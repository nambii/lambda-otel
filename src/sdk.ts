import {
  context,
  diag,
  DiagConsoleLogger,
  DiagLogLevel,
  metrics as otelMetrics,
  propagation,
  trace,
} from '@opentelemetry/api';
import { diagLogLevelFromString } from '@opentelemetry/core';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import {
  AggregationTemporality,
  AggregationType,
  createAllowListAttributesProcessor,
  createDenyListAttributesProcessor,
  MeterProvider,
  PeriodicExportingMetricReader,
  type ViewOptions,
} from '@opentelemetry/sdk-metrics';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { registerInstrumentations, type Instrumentation } from '@opentelemetry/instrumentation';
import { logs as logsApi } from '@opentelemetry/api-logs';
import { BatchLogRecordProcessor, LoggerProvider } from '@opentelemetry/sdk-logs';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';

import { buildResource } from './resource';
import { defaultInstrumentations } from './instrumentations';
import { startTelemetryExtension } from './telemetry-api';
import { buildPropagator } from './propagation';
import { buildRedactor, compileMatcher, RedactingLogRecordExporter, RedactingSpanExporter } from './redact';
import { configureMetricsFacade, resetMetricsFacade } from './metrics';
import type { MetricsConfig, ObservabilityConfig } from './types';

let tracerProvider: NodeTracerProvider | undefined;
let meterProvider: MeterProvider | undefined;
let loggerProvider: LoggerProvider | undefined;
let unregisterInstrumentations: (() => void) | undefined;
/**
 * Default instrumentation instances survive shutdown(). require-in-the-middle
 * only calls an instrumentation's hook the first time a module is required,
 * so a *new* instance created on re-init would never get to patch modules
 * that are already loaded; a reused instance re-patches from the exports it
 * captured the first time. Real Lambda never re-inits; tests and local
 * harnesses do.
 */
let defaultInstances: Instrumentation[] | undefined;
let initialized = false;

/** Default OTLP request timeout; the upstream default (10 s) exceeds the flush cap. */
export const DEFAULT_EXPORTER_TIMEOUT_MS = 3_000;

type Signal = 'traces' | 'metrics' | 'logs';

/**
 * Exporter timeout to pass explicitly, or undefined to let the exporter read
 * its env vars. Explicit config wins; any relevant env var defers to the
 * exporter; otherwise the package default applies.
 */
export function resolveExporterTimeout(
  signal: Signal,
  config: Pick<ObservabilityConfig, 'exporterTimeoutMillis'>,
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  if (config.exporterTimeoutMillis !== undefined) return config.exporterTimeoutMillis;
  if (env[`OTEL_EXPORTER_OTLP_${signal.toUpperCase()}_TIMEOUT`] || env.OTEL_EXPORTER_OTLP_TIMEOUT) {
    return undefined;
  }
  return DEFAULT_EXPORTER_TIMEOUT_MS;
}

/**
 * Seconds-scale buckets for Lambda durations. The OTel default boundaries
 * (0, 5, 10, 25 … 10000) are sized for milliseconds; every second-valued
 * Lambda invoke would land in the first bucket and percentiles would be
 * meaningless on bucket-based backends (Prometheus / Grafana). Tops out at
 * Lambda's 15-minute ceiling.
 */
export const DURATION_SECONDS_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300, 900,
];

/** Built-in views. Exported so consumers can extend or inspect them. */
export function defaultViews(): ViewOptions[] {
  const seconds = (instrumentName: string): ViewOptions => ({
    instrumentName,
    aggregation: {
      type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
      options: { boundaries: DURATION_SECONDS_BUCKETS },
    },
  });
  return [
    seconds('faas.invoke_duration'),
    seconds('faas.init_duration'),
    seconds('aws.lambda.init_duration'),
    seconds('aws.lambda.billed_duration'),
    seconds('aws.lambda.restore_duration'),
    // Bytes span several orders of magnitude; exponential buckets fit with no
    // hand-picked boundaries.
    { instrumentName: 'faas.mem_usage', aggregation: { type: AggregationType.EXPONENTIAL_HISTOGRAM } },
  ];
}

/**
 * Views derived from `metricsConfig` (drop lists, attribute allow/deny lists),
 * merged with the built-in views so no instrument ends up matched by two
 * views. sdk-metrics creates one metric stream per matching view, so a naive
 * "built-ins + user rules" list would export an instrument twice (and make a
 * `drop` rule for a built-in instrument a no-op).
 *
 * Rules:
 *  - `drop` patterns remove any built-in view they match, then add DROP views.
 *  - allow/deny rules with an exact built-in instrument name merge their
 *    processors into that built-in view (buckets kept).
 *  - allow/deny rules with a wildcard that overlaps a built-in replace that
 *    built-in view (the instrument loses its seconds buckets) with a warning.
 *  - allow + deny on the same pattern become one view.
 */
export function buildViews(config: Pick<ObservabilityConfig, 'defaultViews' | 'metricsConfig' | 'views'>): ViewOptions[] {
  const builtIn = config.defaultViews !== false ? defaultViews() : [];
  const mc = config.metricsConfig;
  if (!mc) return [...builtIn, ...(config.views ?? [])];

  const dropMatch = compileMatcher(mc.drop);
  let kept = builtIn.filter((v) => !dropMatch(v.instrumentName!));

  // One rule per pattern, carrying both processors when both are given.
  const rules = new Map<string, ViewOptions>();
  const rule = (pattern: string) => {
    let r = rules.get(pattern);
    if (!r) {
      r = { instrumentName: pattern, attributesProcessors: [] };
      rules.set(pattern, r);
    }
    return r;
  };
  for (const [pattern, keys] of Object.entries(mc.allowedAttributes ?? {})) {
    rule(pattern).attributesProcessors!.push(createAllowListAttributesProcessor(keys));
  }
  for (const [pattern, keys] of Object.entries(mc.deniedAttributes ?? {})) {
    rule(pattern).attributesProcessors!.push(createDenyListAttributesProcessor(keys));
  }

  const standalone: ViewOptions[] = [];
  for (const [pattern, r] of rules) {
    const exact = kept.find((v) => v.instrumentName === pattern);
    if (exact) {
      exact.attributesProcessors = [...(exact.attributesProcessors ?? []), ...r.attributesProcessors!];
      continue;
    }
    if (pattern.includes('*')) {
      const match = compileMatcher([pattern]);
      const overlapped = kept.filter((v) => match(v.instrumentName!));
      if (overlapped.length) {
        diag.warn(
          `lambda-otel: metricsConfig pattern "${pattern}" also matches built-in instrument(s) ` +
            `${overlapped.map((v) => v.instrumentName).join(', ')}; they lose their built-in histogram ` +
            'buckets. Use exact names to keep them.',
        );
        kept = kept.filter((v) => !match(v.instrumentName!));
      }
    }
    standalone.push(r);
  }

  const drops: ViewOptions[] = (mc.drop ?? []).map((instrumentName) => ({
    instrumentName,
    aggregation: { type: AggregationType.DROP },
  }));
  return [...kept, ...drops, ...standalone, ...(config.views ?? [])];
}

/** @deprecated Use {@link buildViews}; kept for callers that inspected the raw rule views. */
export function metricsConfigViews(config: MetricsConfig | undefined): ViewOptions[] {
  return buildViews({ defaultViews: false, metricsConfig: config });
}

export function initObservability(config: ObservabilityConfig = {}): void {
  if (initialized) {
    // Typical cause: the preload already initialized, and the handler module
    // calls init again with options that will never apply. Say so.
    if (Object.keys(config).length > 0) {
      diag.warn(
        'lambda-otel: initObservability() called again with config after the SDK was already ' +
          `initialized; ignoring keys [${Object.keys(config).join(', ')}]. Put all options in the ` +
          'first call (your preload), or drop the second call.',
      );
    }
    return;
  }
  // Mark initialized only once everything below has been constructed: a
  // throwing exporter/reader constructor must not leave a half-built SDK
  // that refuses every later init.
  try {
    build(config);
    initialized = true;
  } catch (err) {
    void shutdown().catch(() => {});
    throw err;
  }
}

function build(config: ObservabilityConfig): void {
  // Diagnostics: explicit debug wins, else honor OTEL_LOG_LEVEL.
  const level = config.debug
    ? DiagLogLevel.DEBUG
    : diagLogLevelFromString(process.env.OTEL_LOG_LEVEL);
  if (level !== undefined && level !== DiagLogLevel.NONE) {
    diag.setLogger(new DiagConsoleLogger(), level);
  }

  const resource = buildResource(config) as never;

  // OTLP exporter args. When `otlpEndpoint` is set we build the per-signal URL
  // explicitly. Otherwise we pass no url so the exporter falls back to the
  // standard env vars (OTEL_EXPORTER_OTLP_ENDPOINT, OTEL_EXPORTER_OTLP_<SIGNAL>_
  // ENDPOINT, *_HEADERS) and finally to http://localhost:4318. This is what lets
  // you point at Grafana / Sentry / Datadog purely via env, no code change.
  const base = config.otlpEndpoint?.replace(/\/+$/, '');
  const otlpArgs = (signal: Signal) => {
    const timeoutMillis = resolveExporterTimeout(signal, config);
    return {
      ...(base ? { url: `${base}/v1/${signal}` } : {}),
      ...(config.headers ? { headers: config.headers } : {}),
      ...(timeoutMillis !== undefined ? { timeoutMillis } : {}),
    };
  };

  // Redaction wraps whichever exporters end up in use (OTLP or injected).
  const redactor = buildRedactor(config.redact);

  // ---- Traces ----
  let traceExporter = config.traceExporter ?? new OTLPTraceExporter(otlpArgs('traces'));
  if (redactor) traceExporter = new RedactingSpanExporter(traceExporter, redactor);
  tracerProvider = new NodeTracerProvider({
    resource,
    spanProcessors: [new BatchSpanProcessor(traceExporter), ...(config.spanProcessors ?? [])],
    ...(config.sampler ? { sampler: config.sampler } : {}),
  });
  // Registers the provider globally and installs propagation (W3C, plus X-Ray
  // when asked for). `undefined` lets the provider install its W3C default.
  tracerProvider.register({
    propagator: config.propagator ?? buildPropagator(config.xrayPropagation),
  });

  // ---- Metrics (on by default; disable with metrics:false, e.g. for Sentry) ----
  configureMetricsFacade({
    enabled: config.metrics !== false,
    warnCardinalityAbove: config.metricsConfig?.warnCardinalityAbove,
  });
  if (config.metrics !== false) {
    const reader =
      config.metricReader ??
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({
          ...otlpArgs('metrics'),
          // Delta is the correct default for ephemeral, concurrent Lambda sandboxes:
          // each export is self-contained and survives cold-start resets.
          temporalityPreference: AggregationTemporality.DELTA,
        }),
        // The timer is a fallback; real delivery happens via flush() per invocation.
        exportIntervalMillis: config.metricExportIntervalMillis ?? 60_000,
        ...(config.metricsConfig?.cardinalityLimit
          ? { cardinalityLimits: { default: config.metricsConfig.cardinalityLimit } }
          : {}),
      });
    const views = buildViews(config);
    meterProvider = new MeterProvider({ resource, readers: [reader], views });
    otelMetrics.setGlobalMeterProvider(meterProvider);
  }

  // ---- Logs (optional) ----
  // Enabled when config.logs is set or a custom exporter/processor is provided.
  // Pino/Winston instrumentation injects trace context regardless; this pipeline
  // is only for forwarding the log records themselves over OTLP.
  if (config.logs || config.logExporter || config.logRecordProcessor) {
    let logExporter = config.logExporter ?? new OTLPLogExporter(otlpArgs('logs'));
    if (redactor) logExporter = new RedactingLogRecordExporter(logExporter, redactor);
    // A custom logRecordProcessor bypasses redaction; wrap your own exporter then.
    const logProcessor = config.logRecordProcessor ?? new BatchLogRecordProcessor(logExporter);
    loggerProvider = new LoggerProvider({ resource, processors: [logProcessor] });
    logsApi.setGlobalLoggerProvider(loggerProvider);
  }

  // ---- Instrumentations ----
  let instrumentations = config.instrumentations;
  if (!instrumentations) {
    if (!defaultInstances || config.instrumentationConfig) {
      defaultInstances = defaultInstrumentations(config.instrumentationConfig);
    }
    instrumentations = defaultInstances;
  }
  unregisterInstrumentations = registerInstrumentations({
    instrumentations,
    tracerProvider,
    meterProvider,
  });
  // registerInstrumentations only enables instances whose config says
  // `enabled: false`; one that shutdown() disabled keeps `enabled: true` in its
  // config and would stay off. enable() is idempotent on a live instance.
  for (const i of instrumentations) i.enable();

  // ---- Lambda Telemetry API (experimental, opt-in) ----
  // Stands up an internal extension to capture platform metrics (max memory,
  // billed/restore duration, timeouts). Requires metrics to be enabled and a
  // real Lambda runtime. Fire-and-forget: best-effort, never blocks init.
  if (config.telemetryMetrics && config.metrics !== false) {
    void startTelemetryExtension({ listenerPort: config.telemetryListenerPort });
  }
}

/**
 * Push all buffered traces + metrics + logs. Called by the handler wrapper
 * before freeze. Best-effort: a failed export must never propagate into the
 * user's handler, so errors are logged via diag and swallowed.
 *
 * `timeoutMs` bounds the wait. The exporters keep running in the background if
 * the deadline passes (they'll finish on the next invocation or be lost at
 * freeze), but the handler is never held past it. Omit for no bound.
 */
export async function flush(timeoutMs?: number): Promise<void> {
  const work = Promise.allSettled([
    tracerProvider?.forceFlush(),
    meterProvider?.forceFlush(),
    loggerProvider?.forceFlush(),
  ]).then((results) => {
    for (const r of results) {
      if (r.status === 'rejected') diag.warn('lambda-otel: flush failed', r.reason);
    }
  });
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs)) return work;

  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      diag.warn(`lambda-otel: flush abandoned after ${timeoutMs}ms; exporters continue in background`);
      resolve();
    }, Math.max(0, timeoutMs));
    // Never keep the event loop alive just for this timer.
    timer.unref?.();
  });
  try {
    await Promise.race([work, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Full teardown — rarely needed in Lambda; useful for tests. */
export async function shutdown(): Promise<void> {
  await Promise.all([
    tracerProvider?.shutdown(),
    meterProvider?.shutdown(),
    loggerProvider?.shutdown(),
  ]);
  tracerProvider = undefined;
  meterProvider = undefined;
  loggerProvider = undefined;
  // Unhook instrumentations bound to the dead providers; a re-init registers
  // fresh instances against the new ones.
  unregisterInstrumentations?.();
  unregisterInstrumentations = undefined;
  // The API registers each global exactly once and silently refuses a second
  // set; without releasing them a re-init would build providers nobody uses.
  trace.disable();
  otelMetrics.disable();
  logsApi.disable();
  context.disable();
  propagation.disable();
  resetMetricsFacade();
  initialized = false;
}

export function isInitialized(): boolean {
  return initialized;
}
