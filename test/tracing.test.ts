import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { InMemorySpanExporter, type ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { initObservability, withObservability, parseResourceAttributesEnv } from '../src/index';

// Own process, own init: resource attributes come from env + config here.
process.env.OTEL_RESOURCE_ATTRIBUTES = 'team=payments,cost.center=cc%2D42,service.name=from-env,bad,=nokey';

const spanExporter = new InMemorySpanExporter();

initObservability({
  serviceName: 'tracing-test',
  traceExporter: spanExporter,
  metrics: false,
  resourceAttributes: { team: 'payments-core', 'service.namespace': 'checkout' },
});

beforeEach(() => spanExporter.reset());

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
