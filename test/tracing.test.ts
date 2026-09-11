import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  InMemorySpanExporter,
  SamplingDecision,
  type ReadableSpan,
  type Sampler,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { initObservability, withObservability, parseResourceAttributesEnv, trace } from '../src/index';

// Own process, own init: resource attributes come from env + config here.
process.env.OTEL_RESOURCE_ATTRIBUTES = 'team=payments,cost.center=cc%2D42,service.name=from-env,bad,=nokey';

const spanExporter = new InMemorySpanExporter();

// Custom processor: stamps every span on start, records every end.
const endedNames: string[] = [];
const stampProcessor: SpanProcessor = {
  onStart: (span) => span.setAttribute('processor.stamp', 'seen'),
  onEnd: (span) => {
    endedNames.push(span.name);
  },
  forceFlush: async () => {},
  shutdown: async () => {},
};

// Custom sampler: drop any span named "drop-me", record everything else.
const dropSampler: Sampler = {
  shouldSample: (_ctx, _traceId, name) => ({
    decision: name === 'drop-me' ? SamplingDecision.NOT_RECORD : SamplingDecision.RECORD_AND_SAMPLED,
  }),
  toString: () => 'DropSampler',
};

initObservability({
  serviceName: 'tracing-test',
  traceExporter: spanExporter,
  metrics: false,
  resourceAttributes: { team: 'payments-core', 'service.namespace': 'checkout' },
  spanProcessors: [stampProcessor],
  sampler: dropSampler,
});

beforeEach(() => {
  spanExporter.reset();
  endedNames.length = 0;
});

function spans(): ReadableSpan[] {
  return spanExporter.getFinishedSpans();
}
const ctx = () => ({ awsRequestId: 'req', getRemainingTimeInMillis: () => 30_000 });

test('parseResourceAttributesEnv: pairs, percent-decoding, malformed entries skipped', () => {
  assert.deepEqual(parseResourceAttributesEnv('a=1, b = two ,c=x%20y,bad,=nokey,d='), {
    a: '1',
    b: 'two',
    c: 'x y',
    d: '',
  });
  assert.deepEqual(parseResourceAttributesEnv(undefined), {});
});

test('resource: env < resourceAttributes < explicit config, on every exported span', async () => {
  await withObservability(async () => null)({ headers: {} }, ctx());
  const res = spans()[0].resource.attributes;
  assert.equal(res['service.name'], 'tracing-test'); // explicit config beats env's service.name
  assert.equal(res['team'], 'payments-core'); // code beats env
  assert.equal(res['cost.center'], 'cc-42'); // env, decoded
  assert.equal(res['service.namespace'], 'checkout');
  assert.equal(res['cloud.platform'], 'aws_lambda');
});

test('spanProcessors run alongside the exporter processor', async () => {
  await withObservability(async () => {
    trace.getTracer('t').startSpan('inner').end();
    return null;
  })({ headers: {} }, ctx());

  for (const s of spans()) assert.equal(s.attributes['processor.stamp'], 'seen');
  assert.deepEqual(endedNames.sort(), ['inner', 'lambda.invoke']);
});

test('sampler is honored', async () => {
  await withObservability(async () => {
    trace.getTracer('t').startSpan('drop-me').end();
    trace.getTracer('t').startSpan('keep-me').end();
    return null;
  })({ headers: {} }, ctx());

  const names = spans().map((s) => s.name).sort();
  assert.deepEqual(names, ['keep-me', 'lambda.invoke']);
});
