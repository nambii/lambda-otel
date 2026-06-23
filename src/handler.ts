import {
  context,
  propagation,
  SpanKind,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api';
import { flush } from './sdk';
import { metrics } from './metrics';

const TRACER_NAME = '@yourscope/lambda-otel';

// Module scope persists across warm invocations in the same sandbox.
let isColdStart = true;

type LambdaHandler<E, R> = (event: E, lambdaContext: any) => Promise<R>;

export interface WrapOptions {
  /** Root span name. Defaults to the Lambda function name. */
  spanName?: string;
  /**
   * Carrier extractor for inbound trace context. Default reads `event.headers`
   * (API Gateway / Lambda URL). Override for SQS/EventBridge/etc., e.g. pull
   * `traceparent` out of message attributes.
   */
  extractCarrier?: (event: unknown) => Record<string, string> | undefined;
}

/**
 * Wraps a Lambda handler with a root span, inbound context propagation,
 * cold-start + duration + error metrics, and a guaranteed flush of both
 * traces and metrics before the sandbox freezes.
 */
export function withObservability<E = any, R = any>(
  handler: LambdaHandler<E, R>,
  opts: WrapOptions = {},
): LambdaHandler<E, R> {
  return async (event: E, lambdaContext: any): Promise<R> => {
    const coldStart = isColdStart;
    isColdStart = false;
    const startedAt = Date.now();

    const carrier =
      opts.extractCarrier?.(event) ??
      ((event as any)?.headers as Record<string, string> | undefined) ??
      {};
    const parentCtx = propagation.extract(context.active(), carrier);

    const tracer = trace.getTracer(TRACER_NAME);
    const spanName =
      opts.spanName ?? process.env.AWS_LAMBDA_FUNCTION_NAME ?? 'lambda.invoke';

    if (coldStart) metrics.count('faas.coldstarts', 1);
    metrics.count('faas.invocations', 1, { 'faas.coldstart': coldStart });

    return context.with(parentCtx, () =>
      tracer.startActiveSpan(
        spanName,
        { kind: SpanKind.SERVER },
        async (span) => {
          span.setAttribute('faas.coldstart', coldStart);
          if (lambdaContext?.awsRequestId) {
            span.setAttribute('faas.invocation_id', lambdaContext.awsRequestId);
          }
          try {
            const result = await handler(event, lambdaContext);
            span.setStatus({ code: SpanStatusCode.OK });
            return result;
          } catch (err: any) {
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
