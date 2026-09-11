import { type Attributes, metrics as otelMetrics } from '@opentelemetry/api';
import type { Counter, Histogram, Gauge } from '@opentelemetry/api';

const METER_NAME = 'lambda-otel';

const counters = new Map<string, Counter>();
const histograms = new Map<string, Histogram>();
const gauges = new Map<string, Gauge>();

function meter() {
  return otelMetrics.getMeter(METER_NAME);
}

/**
 * Instrument metadata. Applied only when the instrument is first created
 * (instruments are cached by name), so pass it consistently or once up front.
 * `unit` follows UCUM as OTel expects: 's', 'ms', 'By', '{request}', '1'.
 */
export interface InstrumentOptions {
  unit?: string;
  description?: string;
}

/**
 * Thin facade over the OTEL metrics API. Instruments are created lazily and
 * cached by name so callers can just emit by name without holding references.
 */
export const metrics = {
  /** Monotonic counter — e.g. metrics.count('orders.created', 1, { currency: 'AUD' }). */
  count(name: string, value = 1, attributes?: Attributes, options?: InstrumentOptions): void {
    let c = counters.get(name);
    if (!c) {
      c = meter().createCounter(name, options);
      counters.set(name, c);
    }
    c.add(value, attributes);
  },

  /** Distribution — e.g. latency, payload sizes. Pass `{ unit: 's' }` etc. on first use. */
  record(name: string, value: number, attributes?: Attributes, options?: InstrumentOptions): void {
    let h = histograms.get(name);
    if (!h) {
      h = meter().createHistogram(name, options);
      histograms.set(name, h);
    }
    h.record(value, attributes);
  },

  /** Point-in-time value — e.g. queue depth at invocation time. Requires @opentelemetry/api >= 1.9. */
  gauge(name: string, value: number, attributes?: Attributes, options?: InstrumentOptions): void {
    let g = gauges.get(name);
    if (!g) {
      g = meter().createGauge(name, options);
      gauges.set(name, g);
    }
    g.record(value, attributes);
  },
};
