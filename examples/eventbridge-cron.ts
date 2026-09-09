/**
 * Scheduled (EventBridge rule / cron) function.
 *
 * For a timer trigger `withObservability` sets `faas.trigger=timer`, a SERVER
 * span kind, and `faas.time` from the event timestamp. There is
 * no inbound trace context, so each run is a fresh trace rooted at the function.
 *
 * Pattern shown: one child span per unit of work so a slow item is visible in
 * the waterfall, a histogram for per-item latency, and a gauge for the backlog
 * observed at the start of the run.
 */
import type { ScheduledEvent } from 'aws-lambda';
import { withObservability, metrics, trace } from 'lambda-otel';

const tracer = trace.getTracer('reconciler');

export const handler = withObservability<ScheduledEvent, void>(async () => {
  const pending = await fetchPending();
  metrics.gauge('reconcile.backlog', pending.length);

  for (const item of pending) {
    const startedAt = Date.now();
    await tracer.startActiveSpan('reconcile.item', async (span) => {
      span.setAttribute('reconcile.item_id', item.id);
      try {
        await reconcile(item);
        metrics.count('reconcile.items', 1, { outcome: 'ok' });
      } catch (err) {
        span.recordException(err as Error);
        metrics.count('reconcile.items', 1, { outcome: 'error' });
        // Swallow so one bad item doesn't fail the whole run; the span carries the error.
      } finally {
        metrics.record('reconcile.item_latency_ms', Date.now() - startedAt);
        span.end();
      }
    });
  }
});

async function fetchPending(): Promise<Array<{ id: string }>> {
  return [];
}

async function reconcile(_item: { id: string }): Promise<void> {}
