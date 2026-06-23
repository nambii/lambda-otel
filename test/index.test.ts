import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { SpanStatusCode } from '@opentelemetry/api';
import { logs, SeverityNumber } from '@opentelemetry/api-logs';
import { InMemorySpanExporter, type ReadableSpan } from '@opentelemetry/sdk-trace-base';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
  type ResourceMetrics,
} from '@opentelemetry/sdk-metrics';
import { InMemoryLogRecordExporter, SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { initObservability, withObservability, metrics } from '../src/index';

// Shared in-memory backends. initObservability is idempotent, so we set it up
// once and reset the exporters between tests.
const spanExporter = new InMemorySpanExporter();
const metricExporter = new InMemoryMetricExporter(AggregationTemporality.DELTA);
const metricReader = new PeriodicExportingMetricReader({
  exporter: metricExporter,
  exportIntervalMillis: 1_000_000, // never fires; we rely on per-invoke flush
});
const logExporter = new InMemoryLogRecordExporter();

initObservability({
  serviceName: 'test-service',
  traceExporter: spanExporter,
  metricReader,
  logRecordProcessor: new SimpleLogRecordProcessor(logExporter),
});

beforeEach(() => {
  spanExporter.reset();
  metricExporter.reset();
  logExporter.reset();
});

function spans(): ReadableSpan[] {
  return spanExporter.getFinishedSpans();
}

function metricSum(name: string): number | undefined {
  const batches: ResourceMetrics[] = metricExporter.getMetrics();
  let total: number | undefined;
  for (const rm of batches) {
    for (const sm of rm.scopeMetrics) {
      for (const m of sm.metrics) {
        if (m.descriptor.name !== name) continue;
        for (const dp of m.dataPoints as Array<{ value: number }>) {
          total = (total ?? 0) + dp.value;
        }
      }
    }
  }
  return total;
}

function hasMetric(name: string): boolean {
  return metricExporter
    .getMetrics()
    .some((rm) => rm.scopeMetrics.some((sm) => sm.metrics.some((m) => m.descriptor.name === name)));
}

// NOTE: this runs first so the process's first invocation is observed as a cold start.
test('cold start then warm, with standard faas metrics', async () => {
  const handler = withObservability(async () => ({ ok: true }));

  await handler({ headers: {} }, { awsRequestId: 'req-1' });
  await handler({ headers: {} }, { awsRequestId: 'req-2' });

  const finished = spans();
  assert.equal(finished.length, 2);
  assert.equal(finished[0].attributes['faas.coldstart'], true);
  assert.equal(finished[1].attributes['faas.coldstart'], false);

  assert.equal(metricSum('faas.invocations'), 2);
  assert.equal(metricSum('faas.coldstarts'), 1);
  assert.ok(hasMetric('faas.invoke_duration'));
});

test('custom metrics are emitted and flushed', async () => {
  const handler = withObservability(async () => {
    metrics.count('orders.created', 2, { currency: 'AUD' });
    metrics.record('fx.quote_latency', 0.042);
    return 'done';
  });

  await handler({ headers: {} }, { awsRequestId: 'req-3' });

  assert.equal(metricSum('orders.created'), 2);
  assert.ok(spans().length === 1);
});

test('errors are recorded on the span and rethrown', async () => {
  const handler = withObservability(async () => {
    throw new Error('boom');
  });

  await assert.rejects(() => handler({ headers: {} }, { awsRequestId: 'req-4' }), /boom/);

  const span = spans()[0];
  assert.equal(span.status.code, SpanStatusCode.ERROR);
  assert.ok(span.events.some((e) => e.name === 'exception'));
  assert.equal(metricSum('faas.errors'), 1);
});

test('inbound trace context is propagated into the root span', async () => {
  const traceId = '0af7651916cd43dd8448eb211c80319c';
  const parentSpanId = 'b7ad6b7169203331';
  const traceparent = `00-${traceId}-${parentSpanId}-01`;

  let observedTraceId: string | undefined;
  const handler = withObservability(async () => {
    observedTraceId = (await import('@opentelemetry/api')).trace
      .getActiveSpan()
      ?.spanContext().traceId;
    return null;
  });

  await handler({ headers: { traceparent } }, { awsRequestId: 'req-5' });

  assert.equal(observedTraceId, traceId);
  assert.equal(spans()[0].spanContext().traceId, traceId);
});

test('log records are forwarded and carry the active trace context', async () => {
  let spanTraceId: string | undefined;

  const handler = withObservability(async () => {
    const { trace } = await import('@opentelemetry/api');
    spanTraceId = trace.getActiveSpan()?.spanContext().traceId;
    logs.getLogger('test').emit({ severityNumber: SeverityNumber.INFO, body: 'booked trade' });
    return null;
  });

  await handler({ headers: {} }, { awsRequestId: 'req-6' });

  const records = logExporter.getFinishedLogRecords();
  assert.equal(records.length, 1);
  assert.equal(records[0].body, 'booked trade');
  // The SDK captures the active span context onto the emitted log record.
  assert.equal(records[0].spanContext?.traceId, spanTraceId);
});
