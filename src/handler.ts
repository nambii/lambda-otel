import { performance } from 'node:perf_hooks';
import {
  context,
  diag,
  propagation,
  type Link,
  type Span,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api';
import { flush } from './sdk';
import { metrics } from './metrics';
import { detectTrigger, lambdaContextAttributes, type TriggerInfo } from './triggers';
import { normalizeCarrier, xrayEnvLink } from './propagation';

const TRACER_NAME = 'lambda-otel';

/** Fire the timeout handler this many ms before the Lambda deadline. */
const DEFAULT_TIMEOUT_MARGIN_MS = 500;
/** Upper bound on how long the per-invocation flush may hold the handler. */
const DEFAULT_FLUSH_TIMEOUT_MS = 5_000;
/** Always leave the runtime this much headroom after flush. */
const FLUSH_HEADROOM_MS = 100;

// Module scope persists across warm invocations in the same sandbox.
let isColdStart = true;

/** The subset of the Lambda context the wrapper reads. `any`-compatible on purpose. */
export interface LambdaContextLike {
  awsRequestId?: string;
  invokedFunctionArn?: string;
  functionVersion?: string;
  getRemainingTimeInMillis?: () => number;
}

/**
 * A Lambda handler. The runtime calls `(event, context, callback)`; response
 * streaming handlers receive `(event, responseStream, context)`. The wrapper
 * passes every argument through untouched and locates the context by shape.
 */
type LambdaHandler<E, R> = (event: E, ...rest: any[]) => Promise<R>;

/** Receives the root span plus the raw event/context before the handler runs. */
export type RequestHook = (span: Span, info: { event: unknown; context: unknown }) => void;
/** Receives the root span plus the handler result or thrown error. */
export type ResponseHook = (span: Span, info: { err?: unknown; res?: unknown }) => void;

export interface WrapOptions {
  /** Root span name. Defaults to the Lambda function name. */
  spanName?: string;
  /**
   * Carrier extractor for inbound trace context. Default reads `event.headers`
   * (API Gateway / Lambda URL / ALB). Override for SQS/EventBridge/etc., e.g.
   * pull `traceparent` out of message attributes. Keys are lowercased before
   * extraction, so header casing never matters.
   */
  extractCarrier?: (event: unknown) => Record<string, string> | undefined;
  /**
   * Set OTel FaaS/messaging semantic-convention attributes derived from the
   * event and context (faas.trigger, messaging.*, faas.document.*,
   * cloud.resource_id, batch span links). These conventions are still
   * "Development" stability upstream; set false to opt out. Default true.
   */
  experimentalAttributes?: boolean;
  /**
   * Called after the root span is created, before the handler runs. The hook is
   * where payload capture lives — it is never automatic, so you control PII and
   * cardinality (redact, truncate, or record sizes only). Errors are swallowed.
   */
  requestHook?: RequestHook;
  /** Called before the handler returns or after it throws. Errors are swallowed. */
  responseHook?: ResponseHook;
  /**
   * How many ms before the Lambda deadline to give up on the handler: the root
   * span is ended with an ERROR status and `error.type=timeout`, `faas.timeouts`
   * and `faas.errors` are counted, and everything is flushed — so the invocation
   * you most need to see is not lost when the runtime kills the sandbox. The
   * handler itself keeps running; if it finishes inside the margin its result
   * is still returned. Set `false` to disable. Default 500.
   */
  timeoutMarginMs?: number | false;
  /**
   * Cap on how long the post-invocation flush may hold the response, in ms.
   * Also bounded by the time remaining on the invocation. Exporters continue in
   * the background past the cap. Default 5000.
   */
  flushTimeoutMs?: number;
  /**
   * For `http` triggers, treat a returned `statusCode >= 500` as a failure:
   * ERROR status, `error.type=<code>`, and a `faas.errors` count — the same as
   * a thrown exception. `http.response.status_code` is set either way.
   * Default true.
   */
  httpErrorStatus?: boolean;
}

/**
 * Wraps a Lambda handler with a root span, inbound context propagation,
 * trigger-aware semantic attributes + batch span links, cold-start + duration +
 * error metrics, timeout capture, and a bounded flush of all signals before the
 * sandbox freezes.
 */
export function withObservability<E = any, R = any>(
  handler: LambdaHandler<E, R>,
  opts: WrapOptions = {},
): LambdaHandler<E, R> {
  return async (event: E, ...rest: any[]): Promise<R> => {
    const coldStart = isColdStart;
    isColdStart = false;
    const startedAt = performance.now();
    const lambdaContext = findLambdaContext(rest);

    const enrich = opts.experimentalAttributes !== false;
    const trigger = detectTrigger(event);

    const carrier = normalizeCarrier(opts.extractCarrier?.(event) ?? (event as any)?.headers);
    const parentCtx = propagation.extract(context.active(), carrier);

    const links: Link[] = enrich ? [...trigger.links] : [];
    // Join the X-Ray segment by link when nothing upstream gave us a parent.
    if (!trace.getSpanContext(parentCtx)) {
      const xray = xrayEnvLink();
      if (xray) links.push(xray);
    }

    const tracer = trace.getTracer(TRACER_NAME);
    const spanName =
      opts.spanName ?? process.env.AWS_LAMBDA_FUNCTION_NAME ?? 'lambda.invoke';

    if (coldStart) {
      metrics.count('faas.coldstarts', 1, undefined, { unit: '{coldstart}' });
      // process.uptime() at the first invocation ≈ init/cold-start duration as
      // seen by the Node process (runtime boot + preload + handler module load).
      // Extension init is not included; enable telemetryMetrics for the
      // platform's own aws.lambda.init_duration. Semconv: seconds.
      metrics.record('faas.init_duration', process.uptime(), { 'faas.coldstart': true }, { unit: 's' });
    }
    metrics.count('faas.invocations', 1, { 'faas.coldstart': coldStart }, { unit: '{invocation}' });

    return context.with(parentCtx, () =>
      tracer.startActiveSpan(
        spanName,
        { kind: trigger.kind, links },
        async (span) => {
          let ended = false;
          let timedOut = false;
          const endSpan = () => {
            if (ended) return;
            ended = true;
            span.end();
          };
          const recordDuration = () =>
            metrics.record(
              'faas.invoke_duration',
              (performance.now() - startedAt) / 1000,
              { 'faas.coldstart': coldStart },
              { unit: 's' },
            );

          // ---- timeout capture ----
          const margin = opts.timeoutMarginMs === false ? 0 : (opts.timeoutMarginMs ?? DEFAULT_TIMEOUT_MARGIN_MS);
          const remaining = remainingMs(lambdaContext);
          let timer: NodeJS.Timeout | undefined;
          if (margin > 0 && remaining !== undefined && remaining > margin) {
            timer = setTimeout(() => {
              timedOut = true;
              span.addEvent('lambda.timeout_imminent', { 'faas.timeout_margin_ms': margin });
              span.setAttribute('error.type', 'timeout');
              span.setStatus({
                code: SpanStatusCode.ERROR,
                message: `Lambda timeout imminent (${remaining}ms budget, ${margin}ms margin)`,
              });
              metrics.count('faas.timeouts', 1, undefined, { unit: '{timeout}' });
              metrics.count('faas.errors', 1, { 'faas.coldstart': coldStart, 'error.type': 'timeout' }, { unit: '{error}' });
              recordDuration();
              endSpan();
              // Fire and forget: whatever ships inside the margin is what survives.
              void flush(Math.max(margin - FLUSH_HEADROOM_MS, 0));
            }, remaining - margin);
            // The timer must never keep a finished invocation alive.
            timer.unref?.();
          }

          span.setAttribute('faas.coldstart', coldStart);
          if (lambdaContext?.awsRequestId) {
            span.setAttribute('faas.invocation_id', lambdaContext.awsRequestId);
          }
          if (enrich) {
            span.setAttributes(trigger.attributes);
            span.setAttributes(lambdaContextAttributes(lambdaContext));
          }
          runHook(opts.requestHook, span, { event, context: lambdaContext });
          try {
            const result = await handler(event, ...rest);
            runHook(opts.responseHook, span, { res: result });
            if (!timedOut) applyHttpResponse(span, trigger, result, coldStart, opts);
            return result;
          } catch (err: any) {
            runHook(opts.responseHook, span, { err });
            if (!timedOut) {
              const type = errorType(err);
              span.recordException(err);
              span.setAttribute('error.type', type);
              span.setStatus({ code: SpanStatusCode.ERROR, message: err?.message });
              metrics.count('faas.errors', 1, { 'faas.coldstart': coldStart, 'error.type': type }, { unit: '{error}' });
            }
            throw err;
          } finally {
            if (timer) clearTimeout(timer);
            if (!timedOut) {
              recordDuration();
              endSpan();
            }
            // The critical Lambda step: ship everything before the runtime freezes,
            // but never hold the response past the flush cap or the deadline.
            await flush(flushBudget(lambdaContext, opts));
          }
        },
      ),
    );
  };
}

/**
 * The runtime passes `(event, context, callback)`; streaming handlers get
 * `(event, responseStream, context)`. Pick the argument that looks like a
 * context rather than trusting position.
 */
function findLambdaContext(rest: any[]): LambdaContextLike | undefined {
  for (const arg of rest) {
    if (
      arg &&
      typeof arg === 'object' &&
      (typeof arg.getRemainingTimeInMillis === 'function' || typeof arg.awsRequestId === 'string')
    ) {
      return arg;
    }
  }
  return rest[0] && typeof rest[0] === 'object' ? rest[0] : undefined;
}

function remainingMs(lambdaContext: LambdaContextLike | undefined): number | undefined {
  if (typeof lambdaContext?.getRemainingTimeInMillis !== 'function') return undefined;
  try {
    const ms = lambdaContext.getRemainingTimeInMillis();
    return typeof ms === 'number' && Number.isFinite(ms) ? ms : undefined;
  } catch {
    return undefined;
  }
}

/**
 * HTTP-shaped results carry the outcome in `statusCode`; a 5xx returned without
 * throwing is still a failed invocation from the caller's point of view.
 */
function applyHttpResponse(
  span: Span,
  trigger: TriggerInfo,
  result: unknown,
  coldStart: boolean,
  opts: WrapOptions,
): void {
  if (trigger.trigger !== 'http') return;
  const code = (result as { statusCode?: unknown } | null)?.statusCode;
  if (typeof code !== 'number') return;
  span.setAttribute('http.response.status_code', code);
  if (code >= 500 && opts.httpErrorStatus !== false) {
    const type = String(code);
    span.setAttribute('error.type', type);
    span.setStatus({ code: SpanStatusCode.ERROR, message: `HTTP ${code}` });
    metrics.count('faas.errors', 1, { 'faas.coldstart': coldStart, 'error.type': type }, { unit: '{error}' });
  }
}

function flushBudget(lambdaContext: LambdaContextLike | undefined, opts: WrapOptions): number {
  const cap = opts.flushTimeoutMs ?? DEFAULT_FLUSH_TIMEOUT_MS;
  const remaining = remainingMs(lambdaContext);
  if (remaining === undefined) return cap;
  return Math.min(cap, Math.max(remaining - FLUSH_HEADROOM_MS, 0));
}

/** Low-cardinality error class for `error.type`: the constructor/`name`, never the message. */
function errorType(err: unknown): string {
  if (err && typeof err === 'object') {
    const name = (err as { name?: unknown }).name;
    if (typeof name === 'string' && name) return name;
    return err.constructor?.name || 'Error';
  }
  return typeof err;
}

// A user hook must never break the handler — capture is best-effort.
function runHook<H extends RequestHook | ResponseHook>(
  hook: H | undefined,
  span: Span,
  info: any,
): void {
  if (!hook) return;
  try {
    hook(span, info);
  } catch (err) {
    diag.warn('lambda-otel: instrumentation hook threw', err);
  }
}
