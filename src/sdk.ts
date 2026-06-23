import {
  diag,
  DiagConsoleLogger,
  DiagLogLevel,
  metrics as otelMetrics,
} from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import {
  AggregationTemporality,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { logs as logsApi } from '@opentelemetry/api-logs';
import { BatchLogRecordProcessor, LoggerProvider } from '@opentelemetry/sdk-logs';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';

import { buildResource } from './resource';
import { defaultInstrumentations } from './instrumentations';
import { startTelemetryExtension } from './telemetry-api';
import type { ObservabilityConfig } from './types';

let tracerProvider: NodeTracerProvider | undefined;
let meterProvider: MeterProvider | undefined;
let loggerProvider: LoggerProvider | undefined;
let initialized = false;

export function initObservability(config: ObservabilityConfig = {}): void {
  if (initialized) return;
  initialized = true;

  if (config.debug) {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);
  }

  const resource = buildResource(config) as never;

  // OTLP exporter args. When `otlpEndpoint` is set we build the per-signal URL
  // explicitly. Otherwise we pass no url so the exporter falls back to the
  // standard env vars (OTEL_EXPORTER_OTLP_ENDPOINT, OTEL_EXPORTER_OTLP_<SIGNAL>_
  // ENDPOINT, *_HEADERS) and finally to http://localhost:4318. This is what lets
  // you point at Grafana / Sentry / Datadog purely via env, no code change.
  const base = config.otlpEndpoint?.replace(/\/+$/, '');
  const otlpArgs = (signal: 'traces' | 'metrics' | 'logs') => ({
    ...(base ? { url: `${base}/v1/${signal}` } : {}),
    ...(config.headers ? { headers: config.headers } : {}),
  });

  // ---- Traces ----
  const traceExporter = config.traceExporter ?? new OTLPTraceExporter(otlpArgs('traces'));
  tracerProvider = new NodeTracerProvider({
    resource,
    spanProcessors: [new BatchSpanProcessor(traceExporter)],
  });
  // Registers the provider globally and installs W3C trace-context propagation.
  tracerProvider.register();

  // ---- Metrics (on by default; disable with metrics:false, e.g. for Sentry) ----
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
      });
    meterProvider = new MeterProvider({ resource, readers: [reader] });
    otelMetrics.setGlobalMeterProvider(meterProvider);
  }

  // ---- Logs (optional) ----
  // Enabled when config.logs is set or a custom exporter/processor is provided.
  // Pino/Winston instrumentation injects trace context regardless; this pipeline
  // is only for forwarding the log records themselves over OTLP.
  if (config.logs || config.logExporter || config.logRecordProcessor) {
    const logProcessor =
      config.logRecordProcessor ??
      new BatchLogRecordProcessor(config.logExporter ?? new OTLPLogExporter(otlpArgs('logs')));
    loggerProvider = new LoggerProvider({ resource, processors: [logProcessor] });
    logsApi.setGlobalLoggerProvider(loggerProvider);
  }

  // ---- Instrumentations ----
  registerInstrumentations({
    instrumentations: config.instrumentations ?? defaultInstrumentations(),
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
 * Push all buffered traces + metrics. Called by the handler wrapper before freeze.
 * Best-effort: a failed export must never propagate into the user's handler, so
 * errors are logged via diag and swallowed.
 */
export async function flush(): Promise<void> {
  const results = await Promise.allSettled([
    tracerProvider?.forceFlush(),
    meterProvider?.forceFlush(),
    loggerProvider?.forceFlush(),
  ]);
  for (const r of results) {
    if (r.status === 'rejected') {
      diag.warn('lambda-otel: flush failed', r.reason);
    }
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
