/**
 * SQS-triggered consumer.
 *
 * The upstream trace context for each message lives in that message's *message
 * attributes*, not in HTTP headers — and a batch has many producers, so there is
 * no single parent to extract. `withObservability` handles this for you: it
 * detects the SQS batch and adds one **span link per record** to the root span
 * (pulled from each message's `traceparent`), which is the spec-correct way to
 * tie a batch back to its producers. No `extractCarrier` needed.
 *
 * Below we go one step further and link each per-message work span to its own
 * producer, so every `trade.book` span points at exactly the trace that enqueued
 * it. Producer side: @opentelemetry/instrumentation-aws-sdk injects `traceparent`
 * into outgoing SQS/SNS message attributes, so once both ends agree you get a
 * single connected trace across the queue.
 */
import type { SQSEvent, SQSBatchResponse, SQSRecord } from 'aws-lambda';
import { withObservability, metrics, trace, propagation, context } from 'lambda-otel';

export const handler = withObservability<SQSEvent, SQSBatchResponse>(async (event) => {
  const failures: SQSBatchResponse['batchItemFailures'] = [];

  for (const record of event.Records) {
    await trace
      .getTracer('worker')
      .startActiveSpan('trade.book', { links: producerLink(record) }, async (span) => {
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
});

/** A span link to the producer trace carried in this message's attributes, if any. */
function producerLink(record: SQSRecord) {
  const traceparent = record.messageAttributes?.traceparent?.stringValue;
  if (!traceparent) return [];
  const spanContext = trace.getSpanContext(
    propagation.extract(context.active(), { traceparent }),
  );
  return spanContext ? [{ context: spanContext }] : [];
}

async function bookTrade(_trade: unknown): Promise<void> {
  // your booking logic
}
