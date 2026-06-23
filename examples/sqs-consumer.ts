/**
 * SQS-triggered consumer.
 *
 * The key difference from an API handler: the upstream trace context lives in
 * the SQS *message attributes*, not in HTTP headers. Without extracting it,
 * every consumer starts a brand-new trace and you lose the producer -> queue ->
 * consumer chain. The `extractCarrier` hook pulls `traceparent` out so this
 * invocation links back to whoever enqueued the message.
 *
 * Producer side: @opentelemetry/instrumentation-aws-sdk can inject `traceparent`
 * into outgoing SQS/SNS message attributes, so once both ends agree you get a
 * single connected trace across the queue.
 */
import type { SQSEvent, SQSBatchResponse } from 'aws-lambda';
import { withObservability, metrics, trace } from '@yourscope/lambda-otel';

export const handler = withObservability<SQSEvent, SQSBatchResponse>(
  async (event) => {
    const failures: SQSBatchResponse['batchItemFailures'] = [];

    for (const record of event.Records) {
      await trace
        .getTracer('worker')
        .startActiveSpan('trade.book', async (span) => {
          span.setAttribute('messaging.message.id', record.messageId);
          try {
            await bookTrade(JSON.parse(record.body));
            metrics.count('trades.booked', 1);
          } catch (err) {
            span.recordException(err as Error);
            // Partial-batch failure: only this message is retried.
            failures.push({ itemIdentifier: record.messageId });
          } finally {
            span.end();
          }
        });
    }

    return { batchItemFailures: failures };
  },
  {
    // Link to the producer's trace via the message attribute.
    extractCarrier: (event) => {
      const attrs = (event as SQSEvent)?.Records?.[0]?.messageAttributes ?? {};
      const traceparent = attrs.traceparent?.stringValue;
      return traceparent ? { traceparent } : undefined;
    },
  },
);

async function bookTrade(_trade: unknown): Promise<void> {
  // your booking logic
}
