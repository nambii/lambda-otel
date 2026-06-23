import type { Instrumentation } from '@opentelemetry/instrumentation';
import type { SpanExporter } from '@opentelemetry/sdk-trace-base';
import type { MetricReader } from '@opentelemetry/sdk-metrics';
import type { LogRecordExporter, LogRecordProcessor } from '@opentelemetry/sdk-logs';

export interface ObservabilityConfig {
  /** Logical service name. Falls back to OTEL_SERVICE_NAME, then the Lambda function name. */
  serviceName?: string;
  /** Service version. Falls back to the Lambda function version. */
  serviceVersion?: string;
  /** Deployment environment (e.g. "prod", "staging"). Falls back to DEPLOYMENT_ENV. */
  environment?: string;
  /**
   * OTLP base endpoint (no path). The package appends /v1/traces and /v1/metrics.
   * If omitted, the standard OTEL_EXPORTER_OTLP_* env vars are honored
   * (including per-signal endpoints and headers), falling back to
   * http://localhost:4318 (the local collector extension layer).
   */
  otlpEndpoint?: string;
  /** Headers applied to all OTLP exporters (e.g. auth). Env vars work too. */
  headers?: Record<string, string>;
  /** Emit FaaS + custom metrics. Default true. Set false for metrics-less backends (e.g. Sentry). */
  metrics?: boolean;
  /**
   * Periodic metric export interval. This is a safety net only — the handler
   * wrapper force-flushes on every invocation, which is what actually ships data.
   */
  metricExportIntervalMillis?: number;
  /** Override the default instrumentation set entirely. */
  instrumentations?: Instrumentation[];
  /** Emit OTEL diagnostic logs to the console. */
  debug?: boolean;
  /** Advanced/testing: inject a span exporter instead of the OTLP default. */
  traceExporter?: SpanExporter;
  /** Advanced/testing: inject a metric reader instead of the OTLP default. */
  metricReader?: MetricReader;
  /**
   * Enable OTLP log forwarding (sends log records to the collector alongside
   * traces and metrics). Off by default — many collectors disable OTLP log
   * ingestion to avoid surprise billing, and in Lambda stdout logs are already
   * captured by CloudWatch. Trace-context *injection* into pino/winston logs
   * does NOT require this; it works as long as the relevant instrumentation is
   * registered.
   */
  logs?: boolean;
  /** Advanced/testing: inject a log exporter instead of the OTLP default. */
  logExporter?: LogRecordExporter;
  /** Advanced/testing: inject a log record processor (overrides logExporter). */
  logRecordProcessor?: LogRecordProcessor;
}
