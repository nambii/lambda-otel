import { type Attributes, metrics as otelMetrics } from '@opentelemetry/api';
import type { Counter, Histogram, Gauge } from '@opentelemetry/api';

const METER_NAME = '@yourscope/lambda-otel';

const counters = new Map<string, Counter>();
const histograms = new Map<string, Histogram>();
const gauges = new Map<string, Gauge>();

function meter() {
  return otelMetrics.getMeter(METER_NAME);
}

/**
 * Thin facade over the OTEL metrics API. Instruments are created lazily and
 * cached by name so callers can just emit by name without holding references.
 */
export const metrics = {
  /** Monotonic counter — e.g. metrics.count('orders.created', 1, { currency: 'AUD' }). */
  count(name: string, value = 1, attributes?: Attributes): void {
    let c = counters.get(name);
    if (!c) {
      c = meter().createCounter(name);
      counters.set(name, c);
    }
    c.add(value, attributes);
  },

  /** Distribution — e.g. latency in ms, payload sizes. */
  record(name: string, value: number, attributes?: Attributes): void {
    let h = histograms.get(name);
    if (!h) {
      h = meter().createHistogram(name);
      histograms.set(name, h);
    }
    h.record(value, attributes);
  },

  /** Point-in-time value — e.g. queue depth at invocation time. Requires @opentelemetry/api >= 1.9. */
  gauge(name: string, value: number, attributes?: Attributes): void {
    let g = gauges.get(name);
    if (!g) {
      g = meter().createGauge(name);
      gauges.set(name, g);
    }
    g.record(value, attributes);
  },
};
