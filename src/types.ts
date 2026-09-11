import type { Instrumentation } from '@opentelemetry/instrumentation';
import type { Sampler, SpanExporter, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import type { MetricReader, ViewOptions } from '@opentelemetry/sdk-metrics';
import type { LogRecordExporter, LogRecordProcessor } from '@opentelemetry/sdk-logs';
import type { AttributeValue, Span, TextMapPropagator } from '@opentelemetry/api';
import type { HttpInstrumentationConfig } from '@opentelemetry/instrumentation-http';
import type { AwsSdkInstrumentationConfig } from '@opentelemetry/instrumentation-aws-sdk';
import type { PgInstrumentationConfig } from '@opentelemetry/instrumentation-pg';
import type { UndiciInstrumentationConfig } from '@opentelemetry/instrumentation-undici';

/**
 * Structural mirror of `KoaInstrumentationConfig` so the type does not leak a
 * dependency on the optional `@opentelemetry/instrumentation-koa` package into
 * consumers' type-checks. Same keys, same meaning.
 *
 * Mirrors @opentelemetry/instrumentation-koa 0.67.x. When bumping that peer,
 * diff its `types.d.ts` against this and update both together.
 */
export interface KoaInstrumentationConfigLike {
  /** Layer kinds to skip. `'middleware'` drops the noisy per-middleware spans. */
  ignoreLayersType?: Array<'router' | 'middleware'>;
  /** Annotate each layer span. `info` is the upstream `KoaRequestInfo`. */
  requestHook?: (span: Span, info: { context: unknown; middlewareLayer: unknown; layerType: 'router' | 'middleware' }) => void;
}

/**
 * Per-instrumentation options for the default set. Each key takes the upstream
 * instrumentation's own config object (every hook, ignore function and header
 * capture option it supports), or `false` to leave that instrumentation out.
 * `koa` is opt-in: it is only registered when a config object is given, and
 * needs the optional peer `@opentelemetry/instrumentation-koa`.
 */
export interface InstrumentationConfigMap {
  http?: HttpInstrumentationConfig | false;
  /** Outbound global `fetch()` (undici). `instrumentation-http` does not see it on Node 18+. */
  undici?: UndiciInstrumentationConfig | false;
  awsSdk?: AwsSdkInstrumentationConfig | false;
  pg?: PgInstrumentationConfig | false;
  koa?: KoaInstrumentationConfigLike | false;
}

/** Context handed to the `redact.attribute` callback. */
export interface RedactContext {
  signal: 'span' | 'log';
  /** Span name, or the log record's body when it is a string. */
  name?: string;
}

/**
 * Attribute redaction applied at the export boundary, so it covers every
 * instrumentation and manual span alike, plus forwarded log records.
 */
export interface RedactConfig {
  /**
   * Attribute keys to remove. Exact keys or `*` wildcards
   * (`'http.request.header.*'`, `'db.query.text'`). Applied to span, span
   * event and span link attributes, and to log record attributes.
   */
  dropAttributes?: string[];
  /**
   * Transform or drop any attribute. Return the value to keep it (possibly
   * rewritten), or `undefined` to drop it. Runs after `dropAttributes`.
   */
  attribute?: (key: string, value: AttributeValue, ctx: RedactContext) => AttributeValue | undefined;
}

/** Controls over which custom metrics and metric attributes are exported. */
export interface MetricsConfig {
  /** Instrument name patterns to drop entirely (`'debug.*'`). */
  drop?: string[];
  /** Instrument name pattern → attribute keys to keep; every other attribute is stripped. */
  allowedAttributes?: Record<string, string[]>;
  /** Instrument name pattern → attribute keys to strip. */
  deniedAttributes?: Record<string, string[]>;
  /**
   * Hard cap on distinct attribute sets per instrument enforced by the SDK
   * (overflow lands in the `otel.metric.overflow` series). Default 2000.
   * Only applies to the package-built metric reader.
   */
  cardinalityLimit?: number;
  /**
   * The `metrics` facade logs one warning per instrument once it has seen this
   * many distinct attribute sets — the usual sign of a request ID or user ID
   * leaking into a tag. Default 1000; `false` disables.
   */
  warnCardinalityAbove?: number | false;
}

export interface ObservabilityConfig {
  /** Logical service name. Falls back to OTEL_SERVICE_NAME, then the Lambda function name. */
  serviceName?: string;
  /** Service version. Falls back to the Lambda function version. */
  serviceVersion?: string;
  /** Deployment environment (e.g. "prod", "staging"). Falls back to DEPLOYMENT_ENV. */
  environment?: string;
  /**
   * Extra resource attributes (team, cost centre, `service.namespace`, …).
   * Merged over the standard `OTEL_RESOURCE_ATTRIBUTES` env var
   * (`key=value,key2=value2`, values URL-decoded), which is merged over the
   * package's Lambda defaults. Explicit fields like `serviceName` still win.
   */
  resourceAttributes?: Record<string, string | number | boolean>;
  /**
   * OTLP base endpoint (no path). The package appends /v1/traces and /v1/metrics.
   * If omitted, the standard OTEL_EXPORTER_OTLP_* env vars are honored
   * (including per-signal endpoints and headers), falling back to
   * http://localhost:4318 (the local collector extension layer).
   */
  otlpEndpoint?: string;
  /** Headers applied to all OTLP exporters (e.g. auth). Env vars work too. */
  headers?: Record<string, string>;
  /**
   * Per-request timeout for the OTLP exporters, in ms. Defaults to 3000 —
   * well under the 5 s flush cap, so a dead endpoint fails fast instead of
   * eating the whole flush budget every invoke. Ignored when
   * `OTEL_EXPORTER_OTLP_TIMEOUT` or a per-signal `OTEL_EXPORTER_OTLP_<SIGNAL>_TIMEOUT`
   * env var is set (those take over, per the OTel spec).
   */
  exporterTimeoutMillis?: number;
  /** Emit FaaS + custom metrics. Default true. Set false for metrics-less backends (e.g. Sentry). */
  metrics?: boolean;
  /**
   * Periodic metric export interval. This is a safety net only — the handler
   * wrapper force-flushes on every invocation, which is what actually ships data.
   */
  metricExportIntervalMillis?: number;
  /**
   * Additional metric Views (e.g. custom histogram buckets for your own
   * instruments). Appended after the package's built-in views, which give the
   * `faas.*_duration` histograms seconds-scale buckets and `faas.mem_usage` an
   * exponential histogram. Set `defaultViews: false` to drop the built-ins.
   */
  views?: ViewOptions[];
  /** Register the package's built-in histogram views. Default true. */
  defaultViews?: boolean;
  /**
   * Options for the default instrumentations (http, aws-sdk, pg, opt-in koa):
   * upstream config objects passed straight through, or `false` to disable
   * one. Ignored when `instrumentations` is set.
   */
  instrumentationConfig?: InstrumentationConfigMap;
  /** Override the default instrumentation set entirely. */
  instrumentations?: Instrumentation[];
  /** Attribute redaction at the export boundary. See {@link RedactConfig}. */
  redact?: RedactConfig;
  /** Custom-metric filtering and cardinality controls. See {@link MetricsConfig}. */
  metricsConfig?: MetricsConfig;
  /**
   * Emit OTEL diagnostic logs to the console at DEBUG. When false/unset, the
   * standard `OTEL_LOG_LEVEL` env var (none|error|warn|info|debug|verbose|all)
   * is honored instead.
   */
  debug?: boolean;
  /**
   * Also understand AWS X-Ray trace context: the `X-Amzn-Trace-Id` header
   * (API Gateway / ALB with active tracing), the SQS `AWSTraceHeader` system
   * attribute, and the `_X_AMZN_TRACE_ID` env var Lambda sets per invocation.
   * A *sampled* inbound X-Ray header becomes the root span's parent. An
   * unsampled one (`Sampled=0`, X-Ray's own sampler declining), the env var,
   * and the SQS attribute become span *links* — never a parent, because a
   * non-sampled parent would make the default ParentBased sampler drop the
   * whole trace. Requires the optional peer `@opentelemetry/propagator-aws-xray`.
   * Default false.
   */
  xrayPropagation?: boolean;
  /** Advanced: replace the global propagator entirely (overrides xrayPropagation). */
  propagator?: TextMapPropagator;
  /** Advanced/testing: inject a span exporter instead of the OTLP default. */
  traceExporter?: SpanExporter;
  /**
   * Extra span processors, run after the package's batch exporter processor:
   * a second exporter, baggage-to-attributes, tail sampling, custom
   * enrichment. Redaction applies only to the package's own exporter.
   */
  spanProcessors?: SpanProcessor[];
  /**
   * Programmatic sampler. When unset the SDK's env-driven default applies
   * (`OTEL_TRACES_SAMPLER` / `OTEL_TRACES_SAMPLER_ARG`, else always-on).
   */
  sampler?: Sampler;
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
  /**
   * Experimental: register an in-process Lambda Telemetry API extension to emit
   * platform metrics the handler can't measure itself — faas.mem_usage,
   * aws.lambda.init_duration, aws.lambda.billed_duration,
   * aws.lambda.restore_duration. Off by default. Metrics lag one invocation and
   * the final pre-freeze report can be lost (internal extensions get no
   * SHUTDOWN); for production prefer the OTel Collector layer's
   * telemetryapireceiver. Requires metrics enabled.
   */
  telemetryMetrics?: boolean;
  /** Port for the telemetry listener when telemetryMetrics is on. Default 4243. */
  telemetryListenerPort?: number;
}
