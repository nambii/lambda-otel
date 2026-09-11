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
  defaultInstrumentations,
  compileMatcher,
  trace,
} from '../src/index';

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

const ctx = () => ({ awsRequestId: 'req', getRemainingTimeInMillis: () => 30_000 });

// ---- instrumentationConfig ----

test('instrumentationConfig: false drops an instrumentation, objects pass through, koa is opt-in', () => {
  const names = (list: ReturnType<typeof defaultInstrumentations>) => list.map((i) => i.instrumentationName);

  assert.deepEqual(names(defaultInstrumentations()), [
    '@opentelemetry/instrumentation-http',
    '@opentelemetry/instrumentation-aws-sdk',
    '@opentelemetry/instrumentation-pg',
  ]);
  assert.deepEqual(names(defaultInstrumentations({ pg: false, awsSdk: false })), [
    '@opentelemetry/instrumentation-http',
  ]);

  const [http] = defaultInstrumentations({ http: { serverName: 'x', requireParentforOutgoingSpans: true } });
  assert.equal((http.getConfig() as any).serverName, 'x');
  assert.equal((http.getConfig() as any).requireParentforOutgoingSpans, true);

  const [, aws] = defaultInstrumentations({ awsSdk: { sqsExtractContextPropagationFromPayload: false } });
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
