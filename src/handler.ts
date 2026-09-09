import {
  context,
  diag,
  propagation,
  type Span,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api';
import { flush } from './sdk';
import { metrics } from './metrics';
import { detectTrigger, lambdaContextAttributes } from './triggers';

const TRACER_NAME = 'lambda-otel';

// Module scope persists across warm invocations in the same sandbox.
let isColdStart = true;

type LambdaHandler<E, R> = (event: E, lambdaContext: any) => Promise<R>;

/** Receives the root span plus the raw event/context before the handler runs. */
export type RequestHook = (span: Span, info: { event: unknown; context: unknown }) => void;
/** Receives the root span plus the handler result or thrown error. */
export type ResponseHook = (span: Span, info: { err?: unknown; res?: unknown }) => void;

export interface WrapOptions {
  /** Root span name. Defaults to the Lambda function name. */
  spanName?: string;
  /**
   * Carrier extractor for inbound trace context. Default reads `event.headers`
   * (API Gateway / Lambda URL). Override for SQS/EventBridge/etc., e.g. pull
   * `traceparent` out of message attributes.
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
}

/**
 * Wraps a Lambda handler with a root span, inbound context propagation,
 * trigger-aware semantic attributes + batch span links, cold-start + duration +
 * error metrics, and a guaranteed flush of all signals before the sandbox freezes.
 */
export function withObservability<E = any, R = any>(
  handler: LambdaHandler<E, R>,
  opts: WrapOptions = {},
): LambdaHandler<E, R> {
  return async (event: E, lambdaContext: any): Promise<R> => {
    const coldStart = isColdStart;
    isColdStart = false;
    const startedAt = Date.now();

    const enrich = opts.experimentalAttributes !== false;
    const trigger = detectTrigger(event);

    const carrier =
      opts.extractCarrier?.(event) ??
      ((event as any)?.headers as Record<string, string> | undefined) ??
      {};
    const parentCtx = propagation.extract(context.active(), carrier);

    const tracer = trace.getTracer(TRACER_NAME);
    const spanName =
      opts.spanName ?? process.env.AWS_LAMBDA_FUNCTION_NAME ?? 'lambda.invoke';

    if (coldStart) {
      metrics.count('faas.coldstarts', 1);
      // process.uptime() at the first invocation ≈ init/cold-start duration.
      // Semconv: faas.init_duration is a histogram in seconds.
      metrics.record('faas.init_duration', process.uptime(), { 'faas.coldstart': true });
    }
    metrics.count('faas.invocations', 1, { 'faas.coldstart': coldStart });

    return context.with(parentCtx, () =>
      tracer.startActiveSpan(
        spanName,
        { kind: trigger.kind, links: enrich ? trigger.links : [] },
        async (span) => {
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
            const result = await handler(event, lambdaContext);
            runHook(opts.responseHook, span, { res: result });
            span.setStatus({ code: SpanStatusCode.OK });
            return result;
          } catch (err: any) {
            runHook(opts.responseHook, span, { err });
            span.recordException(err);
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: err?.message,
            });
            metrics.count('faas.errors', 1, { 'faas.coldstart': coldStart });
            throw err;
          } finally {
            // Semconv: faas.invoke_duration is a histogram measured in seconds.
            metrics.record('faas.invoke_duration', (Date.now() - startedAt) / 1000, {
              'faas.coldstart': coldStart,
            });
            span.end();
            // The critical Lambda step: ship everything before the runtime freezes.
            await flush();
          }
        },
      ),
    );
  };
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
