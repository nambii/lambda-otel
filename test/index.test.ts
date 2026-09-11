import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { logs, SeverityNumber } from '@opentelemetry/api-logs';
import { InMemorySpanExporter, type ReadableSpan } from '@opentelemetry/sdk-trace-base';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
  type ResourceMetrics,
} from '@opentelemetry/sdk-metrics';
import { InMemoryLogRecordExporter, SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { initObservability, withObservability, metrics, ingestTelemetryEvent } from '../src/index';

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

/** A Lambda context with a live deadline, like the runtime provides. */
function ctx(overrides: Record<string, unknown> = {}, budgetMs = 30_000) {
  const deadline = Date.now() + budgetMs;
  return {
    awsRequestId: 'req',
    getRemainingTimeInMillis: () => deadline - Date.now(),
    ...overrides,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

test('success leaves span status UNSET (semconv), not OK', async () => {
  await withObservability(async () => 'fine')({ headers: {} }, { awsRequestId: 'req-unset' });
  assert.equal(spans()[0].status.code, SpanStatusCode.UNSET);
});

test('inbound headers are matched case-insensitively (API Gateway REST keeps client casing)', async () => {
  const traceId = '1af7651916cd43dd8448eb211c80319c';
  const handler = withObservability(async () => null);
  await handler(
    { httpMethod: 'GET', resource: '/x', headers: { Traceparent: `00-${traceId}-b7ad6b7169203331-01` } },
    { awsRequestId: 'req-case' },
  );
  assert.equal(spans()[0].spanContext().traceId, traceId);
});

test('http 5xx returned without throwing is an error; 2xx just records the code', async () => {
  const fail = withObservability(async () => ({ statusCode: 503, body: 'nope' }));
  await fail({ httpMethod: 'GET', resource: '/x', headers: {} }, { awsRequestId: 'req-503' });
  const ok = withObservability(async () => ({ statusCode: 201 }));
  await ok({ httpMethod: 'POST', resource: '/x', headers: {} }, { awsRequestId: 'req-201' });
  const off = withObservability(async () => ({ statusCode: 500 }), { httpErrorStatus: false });
  await off({ httpMethod: 'GET', resource: '/x', headers: {} }, { awsRequestId: 'req-off' });

  const [s503, s201, s500] = spans();
  assert.equal(s503.attributes['http.response.status_code'], 503);
  assert.equal(s503.status.code, SpanStatusCode.ERROR);
  assert.equal(s503.attributes['error.type'], '503');
  assert.equal(s201.attributes['http.response.status_code'], 201);
  assert.equal(s201.status.code, SpanStatusCode.UNSET);
  assert.equal(s500.status.code, SpanStatusCode.UNSET);
  assert.equal(metricSum('faas.errors'), 1);
});

test('non-http triggers ignore a statusCode-shaped result', async () => {
  await withObservability(async () => ({ statusCode: 500 }))({ Records: [{ eventSource: 'aws:sqs' }] }, ctx());
  assert.equal(spans()[0].status.code, SpanStatusCode.UNSET);
  assert.equal(spans()[0].attributes['http.response.status_code'], undefined);
});

test('imminent timeout ends the span as an error and counts faas.timeouts before the deadline', async () => {
  // 200ms budget, 150ms margin: the timeout handler fires at ~50ms while the
  // handler is still sleeping.
  const handler = withObservability(
    async () => {
      await sleep(120);
      return 'late';
    },
    { timeoutMarginMs: 150 },
  );
  const result = await handler({ headers: {} }, ctx({ awsRequestId: 'req-timeout' }, 200));

  assert.equal(result, 'late'); // the handler's own result still comes back
  const finished = spans();
  assert.equal(finished.length, 1);
  const span = finished[0];
  assert.equal(span.status.code, SpanStatusCode.ERROR);
  assert.equal(span.attributes['error.type'], 'timeout');
  assert.ok(span.events.some((e) => e.name === 'lambda.timeout_imminent'));
  // Ended by the timer, well before the handler finished.
  const endedAfterMs = (span.endTime[0] - span.startTime[0]) * 1e3 + (span.endTime[1] - span.startTime[1]) / 1e6;
  assert.ok(endedAfterMs < 110, `span ended after ${endedAfterMs}ms`);
  assert.equal(metricSum('faas.timeouts'), 1);
  assert.equal(metricSum('faas.errors'), 1);
});

test('timeout capture is skipped when the handler finishes in time or is disabled', async () => {
  await withObservability(async () => 'quick', { timeoutMarginMs: 50 })({ headers: {} }, ctx({}, 5000));
  await withObservability(async () => {
    await sleep(60);
    return 'slow-but-off';
  }, { timeoutMarginMs: false })({ headers: {} }, ctx({}, 80));
  for (const s of spans()) assert.equal(s.status.code, SpanStatusCode.UNSET);
  assert.equal(metricSum('faas.timeouts'), undefined);
});

test('duration histograms use seconds-scale buckets and carry units', async () => {
  await withObservability(async () => null)({ headers: {} }, ctx());
  const found = metricExporter
    .getMetrics()
    .flatMap((rm) => rm.scopeMetrics.flatMap((sm) => sm.metrics))
    .find((m) => m.descriptor.name === 'faas.invoke_duration');
  assert.ok(found);
  assert.equal(found!.descriptor.unit, 's');
  const dp = found!.dataPoints[0] as { value: { buckets: { boundaries: number[] } } };
  assert.deepEqual(dp.value.buckets.boundaries.slice(0, 4), [0.005, 0.01, 0.025, 0.05]);
  assert.equal(dp.value.buckets.boundaries.at(-1), 900);
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

test('API Gateway REST event sets http trigger attributes', async () => {
  const handler = withObservability(async () => ({ statusCode: 200 }));

  await handler(
    { httpMethod: 'POST', resource: '/quotes', path: '/quotes', headers: {} },
    { awsRequestId: 'req-http' },
  );

  const span = spans()[0];
  assert.equal(span.kind, SpanKind.SERVER);
  assert.equal(span.attributes['faas.trigger'], 'http');
  assert.equal(span.attributes['http.request.method'], 'POST');
  assert.equal(span.attributes['http.route'], '/quotes');
});

test('SQS batch yields a CONSUMER span, messaging attrs, and one link per message', async () => {
  const traceId = '0af7651916cd43dd8448eb211c80319c';
  const mkRecord = (spanId: string) => ({
    eventSource: 'aws:sqs',
    eventSourceARN: 'arn:aws:sqs:ap-southeast-2:123456789012:orders',
    messageAttributes: { traceparent: { stringValue: `00-${traceId}-${spanId}-01` } },
  });

  const handler = withObservability(async () => 'ok');
  await handler(
    { Records: [mkRecord('b7ad6b7169203331'), mkRecord('aaaaaaaaaaaaaaaa')] },
    { awsRequestId: 'req-sqs' },
  );

  const span = spans()[0];
  assert.equal(span.kind, SpanKind.CONSUMER);
  assert.equal(span.attributes['faas.trigger'], 'pubsub');
  assert.equal(span.attributes['messaging.system'], 'aws_sqs');
  assert.equal(span.attributes['messaging.destination.name'], 'orders');
  assert.equal(span.attributes['messaging.batch.message_count'], 2);
  assert.equal(span.links.length, 2);
  assert.equal(span.links[0].context.traceId, traceId);
});

test('context attributes derive cloud.resource_id and account from the ARN', async () => {
  const handler = withObservability(async () => null);

  await handler(
    { headers: {} },
    {
      awsRequestId: 'req-ctx',
      invokedFunctionArn: 'arn:aws:lambda:ap-southeast-2:123456789012:function:pricer:live',
      functionName: 'pricer',
      functionVersion: '7',
    },
  );

  const span = spans()[0];
  assert.equal(span.attributes['cloud.account.id'], '123456789012');
  // The "live" alias suffix is resolved to the function version.
  assert.equal(
    span.attributes['cloud.resource_id'],
    'arn:aws:lambda:ap-southeast-2:123456789012:function:pricer:7',
  );
  // The function's own identity belongs on the Resource, not as faas.invoked_*.
  assert.equal(span.attributes['faas.invoked_name'], undefined);
});

test('request and response hooks fire and can annotate the span', async () => {
  const seen: string[] = [];
  const handler = withObservability(async () => ({ result: 42 }), {
    requestHook: (span, { event }) => {
      seen.push('request');
      span.setAttribute('test.had_records', Array.isArray((event as any)?.Records));
    },
    responseHook: (span, { res }) => {
      seen.push('response');
      span.setAttribute('test.result', (res as any)?.result);
    },
  });

  await handler({ headers: {} }, { awsRequestId: 'req-hook' });

  assert.deepEqual(seen, ['request', 'response']);
  const span = spans()[0];
  assert.equal(span.attributes['test.result'], 42);
});

test('experimentalAttributes:false suppresses semconv enrichment', async () => {
  const handler = withObservability(async () => 'ok', { experimentalAttributes: false });

  await handler({ httpMethod: 'GET', resource: '/x', headers: {} }, { awsRequestId: 'req-off' });

  const span = spans()[0];
  assert.equal(span.attributes['faas.trigger'], undefined);
  assert.equal(span.attributes['http.route'], undefined);
  // Baseline attributes still present.
  assert.equal(span.attributes['faas.invocation_id'], 'req-off');
});

test('platform.report telemetry is translated into platform metrics', async () => {
  ingestTelemetryEvent({
    type: 'platform.report',
    record: {
      requestId: 'req-report',
      status: 'timeout',
      metrics: { durationMs: 900, billedDurationMs: 1000, memorySizeMB: 128, maxMemoryUsedMB: 90 },
    },
  });
  ingestTelemetryEvent({
    type: 'platform.restoreReport',
    record: { status: 'success', metrics: { restoreDurationMs: 230 } },
  });
  ingestTelemetryEvent({
    type: 'platform.initReport',
    record: { initializationType: 'on-demand', status: 'success', metrics: { durationMs: 412 } },
  });
  // Wrong shapes must be ignored, never throw.
  ingestTelemetryEvent({ type: 'platform.start', record: {} });
  ingestTelemetryEvent(null);

  // A wrapped invocation force-flushes metrics, exporting what we just recorded.
  await withObservability(async () => null)({ headers: {} }, { awsRequestId: 'req-flush' });

  assert.ok(hasMetric('faas.mem_usage'));
  assert.ok(hasMetric('aws.lambda.billed_duration'));
  assert.ok(hasMetric('aws.lambda.restore_duration'));
  assert.ok(hasMetric('aws.lambda.init_duration'));
  // Timeouts are the wrapper's job (it sees them before the sandbox dies).
  assert.equal(metricSum('faas.timeouts'), undefined);
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
