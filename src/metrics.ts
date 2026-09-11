import { type Attributes, diag, metrics as otelMetrics } from '@opentelemetry/api';
import type { Counter, Histogram, Gauge } from '@opentelemetry/api';

const METER_NAME = 'lambda-otel';
const DEFAULT_WARN_CARDINALITY_ABOVE = 1000;

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

// ---- cardinality guard ----
// Tracks distinct attribute sets per instrument and warns once past the
// threshold. Tracking stops at the threshold, so memory is bounded.

let warnAbove: number | false = DEFAULT_WARN_CARDINALITY_ABOVE;
const seen = new Map<string, Set<string>>();
const warned = new Set<string>();

/** Internal: set by initObservability from `metricsConfig.warnCardinalityAbove`. */
export function configureMetricsFacade(opts: { warnCardinalityAbove?: number | false }): void {
  if (opts.warnCardinalityAbove !== undefined) warnAbove = opts.warnCardinalityAbove;
  seen.clear();
  warned.clear();
}

function track(name: string, attributes: Attributes | undefined): void {
  if (warnAbove === false || warnAbove <= 0 || warned.has(name)) return;
  let set = seen.get(name);
  if (!set) {
    set = new Set();
    seen.set(name, set);
  }
  const key = attributes ? serialize(attributes) : '';
  if (set.has(key)) return;
  set.add(key);
  if (set.size >= warnAbove) {
    warned.add(name);
    seen.delete(name);
    diag.warn(
      `lambda-otel: metric "${name}" has reached ${warnAbove} distinct attribute sets; ` +
        'a high-cardinality attribute (request id, user id, timestamp?) is likely leaking into a tag',
    );
  }
}

function serialize(attributes: Attributes): string {
  const keys = Object.keys(attributes).sort();
  let out = '';
  for (const k of keys) out += `${k}=${String(attributes[k])};`;
  return out;
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
    track(name, attributes);
    c.add(value, attributes);
  },

  /** Distribution — e.g. latency, payload sizes. Pass `{ unit: 's' }` etc. on first use. */
  record(name: string, value: number, attributes?: Attributes, options?: InstrumentOptions): void {
    let h = histograms.get(name);
    if (!h) {
      h = meter().createHistogram(name, options);
      histograms.set(name, h);
    }
    track(name, attributes);
    h.record(value, attributes);
  },

  /** Point-in-time value — e.g. queue depth at invocation time. Requires @opentelemetry/api >= 1.9. */
  gauge(name: string, value: number, attributes?: Attributes, options?: InstrumentOptions): void {
    let g = gauges.get(name);
    if (!g) {
      g = meter().createGauge(name, options);
      gauges.set(name, g);
    }
    track(name, attributes);
    g.record(value, attributes);
  },
};
