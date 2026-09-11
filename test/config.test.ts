import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { diag, type DiagLogger } from '@opentelemetry/api';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import { InMemoryLogRecordExporter } from '@opentelemetry/sdk-logs';
import {
  initObservability,
  defaultInstrumentations,
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
});
diag.setLogger(captureLogger);

beforeEach(() => {
  spanExporter.reset();
  metricExporter.reset();
  logExporter.reset();
  warnings.length = 0;
});

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
