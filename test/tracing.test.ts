import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  InMemorySpanExporter,
  SamplingDecision,
  type ReadableSpan,
  type Sampler,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { diag, type DiagLogger } from '@opentelemetry/api';
import { initObservability, withObservability, parseResourceAttributesEnv, buildResource, trace } from '../src/index';

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

const warnings: string[] = [];
const captureLogger: DiagLogger = {
  verbose() {},
  debug() {},
  info() {},
  warn: (msg: string) => warnings.push(msg),
  error: (msg: string) => warnings.push(msg),
};
diag.setLogger(captureLogger);

beforeEach(() => {
  spanExporter.reset();
  endedNames.length = 0;
  warnings.length = 0;
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

test('a second initObservability call with config warns and is ignored; an empty call is silent', () => {
  initObservability({ redact: { dropAttributes: ['x'] }, serviceName: 'late' });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /already initialized/);
  assert.match(warnings[0], /\[redact, serviceName\]/);

  initObservability();
  assert.equal(warnings.length, 1);
});

test('resource: Lambda env is a fallback, never an override, for service.name / service.version', () => {
  const saved = { ...process.env };
  process.env.AWS_LAMBDA_FUNCTION_NAME = 'my-fn';
  process.env.AWS_LAMBDA_FUNCTION_VERSION = '$LATEST';
  process.env.OTEL_RESOURCE_ATTRIBUTES = 'service.name=from-env,service.version=9';
  delete process.env.OTEL_SERVICE_NAME;
  try {
    const attrs = (r: unknown) => (r as { attributes: Record<string, unknown> }).attributes;

    // OTEL_RESOURCE_ATTRIBUTES beats the Lambda function name (spec order)
    let a = attrs(buildResource({}));
    assert.equal(a['service.name'], 'from-env');
    assert.equal(a['service.version'], '9');
    assert.equal(a['faas.name'], 'my-fn'); // faas.* still describes the function

    // code resourceAttributes beat env
    a = attrs(buildResource({ resourceAttributes: { 'service.name': 'from-code' } }));
    assert.equal(a['service.name'], 'from-code');

    // explicit config / OTEL_SERVICE_NAME beat everything
    a = attrs(buildResource({ serviceName: 'explicit', serviceVersion: '1.2.3' }));
    assert.equal(a['service.name'], 'explicit');
    assert.equal(a['service.version'], '1.2.3');
    process.env.OTEL_SERVICE_NAME = 'svc-env';
    assert.equal(attrs(buildResource({}))['service.name'], 'svc-env');

    // nothing set anywhere: Lambda name, then the placeholder
    delete process.env.OTEL_SERVICE_NAME;
    delete process.env.OTEL_RESOURCE_ATTRIBUTES;
    assert.equal(attrs(buildResource({}))['service.name'], 'my-fn');
    delete process.env.AWS_LAMBDA_FUNCTION_NAME;
    assert.equal(attrs(buildResource({}))['service.name'], 'unknown-service');
    // cloud.* cannot be overridden
    assert.equal(attrs(buildResource({ resourceAttributes: { 'cloud.platform': 'nope' } }))['cloud.platform'], 'aws_lambda');
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});
