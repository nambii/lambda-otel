import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { initObservability, shutdown, isInitialized, metrics, flush } from '../src/index';

function boot() {
  const metricExporter = new InMemoryMetricExporter(AggregationTemporality.DELTA);
  initObservability({
    serviceName: 'lifecycle',
    traceExporter: new InMemorySpanExporter(),
    metricReader: new PeriodicExportingMetricReader({ exporter: metricExporter, exportIntervalMillis: 1_000_000 }),
  });
  return metricExporter;
}

function sum(exporter: InMemoryMetricExporter, name: string): number | undefined {
  let total: number | undefined;
  for (const rm of exporter.getMetrics())
    for (const sm of rm.scopeMetrics)
      for (const m of sm.metrics)
        if (m.descriptor.name === name)
          for (const dp of m.dataPoints as Array<{ value: number }>) total = (total ?? 0) + dp.value;
  return total;
}

test('a metric recorded before init is a no-op, but the same name works after init', async () => {
  metrics.count('early.bird', 1); // no provider yet: silently dropped, must not poison the cache
  const exporter = boot();
  metrics.count('early.bird', 5);
  await flush();
  assert.equal(sum(exporter, 'early.bird'), 5);
  await shutdown();
});

test('shutdown() then initObservability(): the metrics facade re-binds to the new provider', async () => {
  const first = boot();
  metrics.count('jobs.done', 1);
  await flush();
  assert.equal(sum(first, 'jobs.done'), 1);

  await shutdown();
  assert.equal(isInitialized(), false);

  const second = boot();
  metrics.count('jobs.done', 2); // same instrument name: must not hit the dead provider
  await flush();
  assert.equal(sum(second, 'jobs.done'), 2);
  assert.equal(sum(first, 'jobs.done'), 1); // nothing leaked back to the old exporter

  await shutdown();
});
