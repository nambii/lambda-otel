import {
  diag,
  DiagConsoleLogger,
  DiagLogLevel,
  metrics as otelMetrics,
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
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { logs as logsApi } from '@opentelemetry/api-logs';
import { BatchLogRecordProcessor, LoggerProvider } from '@opentelemetry/sdk-logs';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';

import { buildResource } from './resource';
import { defaultInstrumentations } from './instrumentations';
import { startTelemetryExtension } from './telemetry-api';
import { buildPropagator } from './propagation';
import { buildRedactor, RedactingLogRecordExporter, RedactingSpanExporter } from './redact';
import { configureMetricsFacade } from './metrics';
import type { MetricsConfig, ObservabilityConfig } from './types';

let tracerProvider: NodeTracerProvider | undefined;
let meterProvider: MeterProvider | undefined;
let loggerProvider: LoggerProvider | undefined;
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

/** Views derived from `metricsConfig` (drop lists, attribute allow/deny lists). */
export function metricsConfigViews(config: MetricsConfig | undefined): ViewOptions[] {
  if (!config) return [];
  const views: ViewOptions[] = [];
  for (const instrumentName of config.drop ?? []) {
    views.push({ instrumentName, aggregation: { type: AggregationType.DROP } });
  }
  for (const [instrumentName, keys] of Object.entries(config.allowedAttributes ?? {})) {
    views.push({ instrumentName, attributesProcessors: [createAllowListAttributesProcessor(keys)] });
  }
  for (const [instrumentName, keys] of Object.entries(config.deniedAttributes ?? {})) {
    views.push({ instrumentName, attributesProcessors: [createDenyListAttributesProcessor(keys)] });
  }
  return views;
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
  initialized = true;

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
  if (config.metrics !== false) {
    configureMetricsFacade({ warnCardinalityAbove: config.metricsConfig?.warnCardinalityAbove });
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
    const views = [
      ...(config.defaultViews !== false ? defaultViews() : []),
      ...metricsConfigViews(config.metricsConfig),
      ...(config.views ?? []),
    ];
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
  registerInstrumentations({
    instrumentations: config.instrumentations ?? defaultInstrumentations(config.instrumentationConfig),
    tracerProvider,
    meterProvider,
  });

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
  initialized = false;
}

export function isInitialized(): boolean {
  return initialized;
}
