import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { diag, type DiagLogger } from '@opentelemetry/api';
import { logs, SeverityNumber } from '@opentelemetry/api-logs';
import { InMemorySpanExporter, type ReadableSpan } from '@opentelemetry/sdk-trace-base';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import { InMemoryLogRecordExporter } from '@opentelemetry/sdk-logs';
import {
  initObservability,
  withObservability,
  metrics,
  defaultInstrumentations,
  compileMatcher,
  buildViews,
  trace,
} from '../src/index';
import { AggregationType } from '@opentelemetry/sdk-metrics';

// This file runs in its own process (node --test isolates files), so it gets
// its own initObservability with the redaction / metrics / instrumentation
// config under test.

const spanExporter = new InMemorySpanExporter();
const metricExporter = new InMemoryMetricExporter(AggregationTemporality.DELTA);
const logExporter = new InMemoryLogRecordExporter();

const warnings: string[] = [];
const captureLogger: DiagLogger = {
  verbose() {},
  debug() {},
  info() {},
  warn: (msg: string) => warnings.push(msg),
  error: (msg: string) => warnings.push(msg),
};

initObservability({
  serviceName: 'config-test',
  traceExporter: spanExporter,
  metricReader: new PeriodicExportingMetricReader({ exporter: metricExporter, exportIntervalMillis: 1_000_000 }),
  logExporter,
  instrumentationConfig: {
    pg: false,
    http: { serverName: 'cfg-test' },
  },
  redact: {
    dropAttributes: ['db.query.text', 'http.request.header.*'],
    attribute: (key, value) => (key === 'url.full' ? String(value).split('?')[0] : value),
  },
  metricsConfig: {
    drop: ['debug.*', 'faas.invoke_duration'], // second one is a built-in view: must really drop
    allowedAttributes: { 'orders.*': ['currency'] },
    deniedAttributes: { 'payments.count': ['card_last4'] },
    warnCardinalityAbove: 5,
  },
});
diag.setLogger(captureLogger);

beforeEach(() => {
  spanExporter.reset();
  metricExporter.reset();
  logExporter.reset();
  warnings.length = 0;
});

function spans(): ReadableSpan[] {
  return spanExporter.getFinishedSpans();
}

function metricByName(name: string) {
  return metricExporter
    .getMetrics()
    .flatMap((rm) => rm.scopeMetrics.flatMap((sm) => sm.metrics))
    .find((m) => m.descriptor.name === name);
}

const ctx = () => ({ awsRequestId: 'req', getRemainingTimeInMillis: () => 30_000 });

// ---- instrumentationConfig ----

test('instrumentationConfig: false drops an instrumentation, objects pass through, koa is opt-in', () => {
  const names = (list: ReturnType<typeof defaultInstrumentations>) => list.map((i) => i.instrumentationName);

  assert.deepEqual(names(defaultInstrumentations()), [
    '@opentelemetry/instrumentation-http',
    '@opentelemetry/instrumentation-undici',
    '@opentelemetry/instrumentation-aws-sdk',
    '@opentelemetry/instrumentation-pg',
  ]);
  assert.deepEqual(names(defaultInstrumentations({ pg: false, awsSdk: false, undici: false })), [
    '@opentelemetry/instrumentation-http',
  ]);
  const [, undici] = defaultInstrumentations({ undici: { requireParentforSpans: true } });
  assert.equal((undici.getConfig() as any).requireParentforSpans, true);

  const [http] = defaultInstrumentations({ http: { serverName: 'x', requireParentforOutgoingSpans: true } });
  assert.equal((http.getConfig() as any).serverName, 'x');
  assert.equal((http.getConfig() as any).requireParentforOutgoingSpans, true);

  const [, , aws] = defaultInstrumentations({ awsSdk: { sqsExtractContextPropagationFromPayload: false } });
  const awsCfg = aws.getConfig() as any;
  assert.equal(awsCfg.suppressInternalInstrumentation, true); // default kept
  assert.equal(awsCfg.sqsExtractContextPropagationFromPayload, false);

  // koa only when configured; the dev dependency is installed here so it resolves.
  const withKoa = names(defaultInstrumentations({ koa: { ignoreLayersType: ['middleware'] } }));
  assert.ok(withKoa.includes('@opentelemetry/instrumentation-koa'));
  assert.ok(!names(defaultInstrumentations({ koa: false })).includes('@opentelemetry/instrumentation-koa'));
});

// ---- redact ----

test('compileMatcher: exact keys and * wildcards', () => {
  const m = compileMatcher(['db.query.text', 'http.request.header.*', '*.password']);
  assert.equal(m('db.query.text'), true);
  assert.equal(m('db.query.textual'), false);
  assert.equal(m('http.request.header.authorization'), true);
  assert.equal(m('http.request.headers'), false);
  assert.equal(m('user.password'), true);
  assert.equal(compileMatcher(undefined)('anything'), false);
});

test('redact: dropped and transformed attributes never reach the exporter (span, events, links)', async () => {
  const handler = withObservability(async () => {
    const span = trace.getActiveSpan()!;
    span.setAttribute('db.query.text', 'select * from users where email = $1');
    span.setAttribute('http.request.header.authorization', 'Bearer secret');
    span.setAttribute('url.full', 'https://api.example.com/v1/quote?token=abc');
    span.setAttribute('keep.me', 'yes');
    span.addEvent('query', { 'db.query.text': 'select 1', note: 'kept' });
    const child = trace.getTracer('t').startSpan('child', {
      links: [{ context: span.spanContext(), attributes: { 'http.request.header.cookie': 'x', ok: 1 } }],
    });
    child.setAttribute('db.query.text', 'select 2');
    child.end();
    return null;
  });
  await handler({ headers: {} }, ctx());

  const root = spans().find((s) => s.name !== 'child')!;
  const child = spans().find((s) => s.name === 'child')!;
  assert.equal(root.attributes['db.query.text'], undefined);
  assert.equal(root.attributes['http.request.header.authorization'], undefined);
  assert.equal(root.attributes['url.full'], 'https://api.example.com/v1/quote');
  assert.equal(root.attributes['keep.me'], 'yes');
  assert.deepEqual(root.events.find((e) => e.name === 'query')!.attributes, { note: 'kept' });
  assert.equal(child.attributes['db.query.text'], undefined);
  assert.deepEqual(child.links[0].attributes, { ok: 1 });
});

test('redact: log record attributes go through the same matcher', async () => {
  await withObservability(async () => {
    logs.getLogger('t').emit({
      severityNumber: SeverityNumber.INFO,
      body: 'booked',
      attributes: { 'db.query.text': 'insert ...', 'http.request.header.x-api-key': 'k', order: 7 },
    });
    return null;
  })({ headers: {} }, ctx());

  const [record] = logExporter.getFinishedLogRecords();
  assert.deepEqual(record.attributes, { order: 7 });
});

// ---- metricsConfig ----

test('metricsConfig.drop removes matching instruments from export, built-ins included', async () => {
  await withObservability(async () => {
    metrics.count('debug.loop_iterations', 3);
    metrics.count('orders.created', 1, { currency: 'AUD' });
    return null;
  })({ headers: {} }, ctx());

  assert.equal(metricByName('debug.loop_iterations'), undefined);
  assert.equal(metricByName('faas.invoke_duration'), undefined, 'built-in view must not resurrect a dropped instrument');
  assert.ok(metricByName('faas.invocations'));
  assert.ok(metricByName('orders.created'));
  // and no instrument is exported twice
  const names = metricExporter.getMetrics().flatMap((rm) => rm.scopeMetrics.flatMap((sm) => sm.metrics.map((m) => m.descriptor.name)));
  assert.equal(new Set(names).size, names.length, `duplicate streams: ${names}`);
});

test('buildViews: one view per instrument — merges exact rules into built-ins, replaces on wildcard overlap', () => {
  const byName = (views: ReturnType<typeof buildViews>, n: string) => views.filter((v) => v.instrumentName === n);

  // exact allow-list on a built-in: merged, buckets kept, single view
  let views = buildViews({ metricsConfig: { allowedAttributes: { 'faas.init_duration': ['faas.coldstart'] } } });
  const merged = byName(views, 'faas.init_duration');
  assert.equal(merged.length, 1);
  assert.equal(merged[0].aggregation?.type, AggregationType.EXPLICIT_BUCKET_HISTOGRAM);
  assert.equal(merged[0].attributesProcessors?.length, 1);

  // drop on a built-in: built-in view gone, DROP view present, once
  views = buildViews({ metricsConfig: { drop: ['faas.*_duration'] } });
  assert.equal(byName(views, 'faas.invoke_duration').length, 0);
  assert.equal(byName(views, 'faas.init_duration').length, 0);
  assert.equal(views.filter((v) => v.aggregation?.type === AggregationType.DROP).length, 1);

  // wildcard allow overlapping a built-in: built-in removed (warned), generic view present
  warnings.length = 0;
  views = buildViews({ metricsConfig: { allowedAttributes: { 'aws.lambda.*': ['x'] } } });
  assert.equal(views.some((v) => v.instrumentName === 'aws.lambda.billed_duration'), false);
  assert.equal(byName(views, 'aws.lambda.*').length, 1);
  assert.match(warnings[0], /also matches built-in instrument/);

  // allow + deny on the same pattern: one view, two processors
  views = buildViews({ defaultViews: false, metricsConfig: { allowedAttributes: { 'x.*': ['a'] }, deniedAttributes: { 'x.*': ['b'] } } });
  assert.equal(views.length, 1);
  assert.equal(views[0].attributesProcessors?.length, 2);

  // user views appended untouched
  views = buildViews({ defaultViews: false, views: [{ instrumentName: 'u' }] });
  assert.deepEqual(views, [{ instrumentName: 'u' }]);
});

test('metricsConfig allow/deny lists strip attributes per instrument pattern', async () => {
  await withObservability(async () => {
    metrics.count('orders.created', 1, { currency: 'AUD', customer_id: 'c-123' });
    metrics.count('payments.count', 1, { card_last4: '4242', method: 'card' });
    return null;
  })({ headers: {} }, ctx());

  const orders = metricByName('orders.created')!;
  assert.deepEqual(orders.dataPoints[0].attributes, { currency: 'AUD' });
  const payments = metricByName('payments.count')!;
  assert.deepEqual(payments.dataPoints[0].attributes, { method: 'card' });
});

test('metrics facade warns once when an instrument crosses warnCardinalityAbove', async () => {
  await withObservability(async () => {
    for (let i = 0; i < 20; i++) metrics.count('lookups', 1, { request_id: `r-${i}` });
    for (let i = 0; i < 20; i++) metrics.record('lat', i, { region: 'ap-southeast-2' }); // one set, no warning
    return null;
  })({ headers: {} }, ctx());

  const hits = warnings.filter((w) => w.includes('"lookups"'));
  assert.equal(hits.length, 1);
  assert.match(hits[0], /5 distinct attribute sets/);
  assert.equal(warnings.some((w) => w.includes('"lat"')), false);
});
