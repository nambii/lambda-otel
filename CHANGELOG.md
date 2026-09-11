# Changelog

## Unreleased (0.2.0)

Capture controls (all opt-in):

- **undici in the default set.** Outbound global `fetch()` was invisible by
  default; `@opentelemetry/instrumentation-undici` is now an
  `optionalDependency` registered alongside http/aws-sdk/pg.
- **`instrumentationConfig`**: per-instrumentation options for the default
  set — `http`, `undici`, `awsSdk`, `pg` take their upstream config objects,
  `false` disables one, `koa` is opt-in (optional peer
  `@opentelemetry/instrumentation-koa`). `defaultInstrumentations(map)` takes
  the same map.
- **`redact`**: attribute redaction at the export boundary — `dropAttributes`
  patterns and an `attribute(key, value, ctx)` transform — applied to span,
  event, link and forwarded log-record attributes. `RedactingSpanExporter` /
  `RedactingLogRecordExporter` exported for custom pipelines.
- **`metricsConfig`**: `drop` patterns, `allowedAttributes` / `deniedAttributes`
  per instrument pattern (Views under the hood), `cardinalityLimit` for the
  SDK reader, and a `metrics` facade warning at `warnCardinalityAbove`
  distinct attribute sets (default 1000).

Behavior changes (minor bump; all defaults are on):

- **`OTEL_RESOURCE_ATTRIBUTES` honored** (it was ignored), plus a
  `resourceAttributes` config option. Precedence: env < code < the package's
  own `service.name` / cloud attributes.
- **OTLP exporter timeout defaults to 3 s** (`exporterTimeoutMillis`) instead
  of OTel's 10 s, so a dead endpoint fails inside the flush cap. Standard
  `OTEL_EXPORTER_OTLP[_<SIGNAL>]_TIMEOUT` env vars still take precedence.

- **Timeout capture.** `withObservability` arms a timer at
  `remaining - timeoutMarginMs` (default 500 ms). On fire the root span is
  ended with ERROR / `error.type=timeout`, `faas.timeouts` and `faas.errors`
  are counted, and everything is flushed before the runtime kills the sandbox.
  `timeoutMarginMs: false` disables.
- **Bounded flush.** The per-invocation flush waits at most
  `min(flushTimeoutMs, remaining - 100ms)` (default cap 5 s), then returns and
  lets the exporters finish in the background.
- **Returned HTTP 5xx is an error** on http triggers: ERROR status,
  `error.type=<code>`, `faas.errors` count. `http.response.status_code` is set
  for every http result. `httpErrorStatus: false` disables.
- **Case-insensitive inbound headers.** Carrier keys are lowercased before
  extraction, so API Gateway REST (v1) events with `Traceparent` link correctly.
- **`error.type` attribute** on error spans and the `faas.errors` counter
  (exception name, HTTP status, or `timeout`). Successful spans are left UNSET
  instead of OK, per semconv.
- **Seconds-scale histogram buckets** (Views) for `faas.*_duration` and
  `aws.lambda.*_duration`; exponential histogram for `faas.mem_usage`. All
  package instruments now carry units. `views` / `defaultViews` config added;
  `metrics.count/record/gauge` accept `{ unit, description }`.
- **`faas.timeouts` moved** from the Telemetry API listener to the wrapper.
  The listener now emits `aws.lambda.init_duration` from `platform.initReport`.
- **ESM preload**: `--import lambda-otel/register` resolves to `register.mjs`,
  which installs OpenTelemetry's ESM loader hook before initializing the SDK.
- **AWS X-Ray** (opt-in `xrayPropagation: true`, optional peer
  `@opentelemetry/propagator-aws-xray`): `X-Amzn-Trace-Id` header as parent,
  `_X_AMZN_TRACE_ID` env and SQS `AWSTraceHeader` as span links.
- **Response streaming / callback signatures**: the wrapper passes all
  arguments through and finds the Lambda context by shape.
- `OTEL_LOG_LEVEL` honored when `debug` is not set.
- `@opentelemetry/instrumentation-pg` is now an `optionalDependency`
  (still installed by default). `@opentelemetry/core` added as a dependency.
- CI (Node 18/20/22) and a tag-triggered publish workflow with npm provenance.

## 0.1.2

- Dependency refresh within semver ranges.

## 0.1.1

- Initial public release.
