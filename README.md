# lambda-otel

Vendor-neutral OpenTelemetry **traces + metrics** for AWS Lambda (Node.js).

The package only ever speaks **OTLP** to an endpoint. It contains no Datadog,
Sentry, or other vendor exporter — the backend is decided entirely by the
collector you point it at. Switching backends is a config change, never a
republish.

## What it does that the raw SDK / ADOT layer don't

- **Force-flushes traces *and* metrics on every invocation, with a deadline.**
  Lambda freezes the sandbox between invokes, so the metrics SDK's periodic
  export timer is unreliable. The handler wrapper flushes every signal in a
  `finally` before the runtime freezes, bounded by `flushTimeoutMs` and the
  time remaining on the invocation. Flush is best-effort — a failed or abandoned
  export never breaks your handler.
- **Captures timeouts.** A timer armed from `getRemainingTimeInMillis()` ends
  the root span as an error, counts `faas.timeouts`, and flushes *before* the
  runtime kills the sandbox — the invocations you most need to see are exactly
  the ones a plain `finally` never reaches.
- **Treats returned 5xx as failures.** An HTTP handler that returns
  `{ statusCode: 500 }` without throwing gets an ERROR span and a `faas.errors`
  count, same as an exception. `http.response.status_code` is always set.
- **Delta temporality for metrics.** Cumulative counters are meaningless across
  ephemeral, concurrent sandboxes that reset on cold start. Delta makes each
  export self-contained and is what OTLP backends expect from serverless.
- **Explicit instrumentation + a preload entry** so it survives esbuild bundling
  (see the caveat below).
- **Cold-start, duration, and error metrics** plus a root span with inbound
  context propagation (W3C, optionally AWS X-Ray), out of the box. Duration
  histograms ship with seconds-scale buckets and units so percentiles work on
  bucket-based backends, not just Datadog.
- **ESM and CommonJS preload entries.** `--import lambda-otel/register` installs
  OpenTelemetry's ESM loader hook before the SDK, so `import`ed packages are
  patched under an ESM handler (SST's default), not only `require`d ones.
- **Trigger-aware enrichment.** The wrapper inspects the event and applies the
  OTel FaaS/messaging semantic conventions automatically: `faas.trigger`, the
  right span kind (`CONSUMER` for SQS/SNS/Kinesis, `SERVER` for HTTP), `http.route`
  for API Gateway/ALB, `messaging.*` for queues, `faas.document.*` for
  S3/DynamoDB, `cloud.resource_id`/`cloud.account.id` from the invoke context,
  and **one span link per message** for batches (extracted from each record's
  `traceparent`). All of it is gated behind `experimentalAttributes` (on by
  default) since the FaaS semconv is still "Development" stability upstream.

## Quick start (integration checklist)

Do these in order. Each step is expanded in its own section below.

1. **Install** — `npm install lambda-otel @opentelemetry/api`.
2. **Preload** — set the Lambda env var `NODE_OPTIONS=--require lambda-otel/register`
   (`--import` for ESM). This initializes the SDK *before* your handler module
   loads, so `http`, `fetch()`, `@aws-sdk/*`, and `pg` get patched. If you need extra
   instrumentations (Koa, pino, undici…), preload your own file instead — see
   [`examples/instrument.ts`](./examples/instrument.ts).
3. **Wrap the handler** — `export const handler = withObservability(async (event, context) => { ... })`.
   Wrap outermost (outside Middy or any other wrapper).
4. **Point at a collector** — leave `OTEL_EXPORTER_OTLP_ENDPOINT` unset to use a
   sidecar layer on `http://localhost:4318`, or set it to a remote collector /
   vendor OTLP endpoint. Set `OTEL_SERVICE_NAME` and `DEPLOYMENT_ENV`.
5. **If you bundle with esbuild** (SST, CDK `NodejsFunction`, serverless-esbuild,
   SAM esbuild): externalize `@opentelemetry/*`, `lambda-otel`, and every
   instrumented library so they resolve at runtime — see the bundler matrix below.
   Skipping this is the #1 cause of "I only see the root span".
6. **Add custom metrics / spans** where useful — `metrics.count(...)`,
   `metrics.record(...)`, or `trace.getTracer('app').startActiveSpan(...)`.
7. **Verify** — invoke once with `OTEL_DEBUG=true` and confirm the collector
   receives a root span, child spans for outbound calls, and `faas.*` metrics.
   See *Local development* and *Troubleshooting* below.

Minimal handler with nothing else: [`examples/basic-handler.ts`](./examples/basic-handler.ts).

## Install

```bash
npm install lambda-otel @opentelemetry/api
```

## Usage

Initialize once (ideally via the preload, so instrumentation patches libraries
before they're required), then wrap your handler:

```ts
// handler.ts
import { withObservability, metrics } from 'lambda-otel';

export const handler = withObservability(async (event) => {
  metrics.count('orders.created', 1, { currency: 'AUD' });
  metrics.record('fx.quote_latency_ms', 42);
  return { statusCode: 200, body: 'ok' };
});
```

```jsonc
// Lambda env
"NODE_OPTIONS": "--require lambda-otel/register"
```

If you can't use a preload, call `initObservability()` yourself as the very
first thing your entrypoint does (before importing instrumented libraries):

```ts
import { initObservability, withObservability } from 'lambda-otel';
initObservability({ environment: 'prod' });
```

## Deployment topologies (both vendor-neutral)

**A. Sidecar collector layer (recommended).** Attach a collector extension layer
(the upstream `opentelemetry-lambda` collector, ADOT, or your own custom collector
build that includes the vendor exporter you want). Your function exports OTLP to
`http://localhost:4318`; the collector buffers and forwards async. The backend
lives in the collector's config — swap it without touching code.

**B. Remote collector / gateway.** Point `OTEL_EXPORTER_OTLP_ENDPOINT` at a
central collector (e.g. on ECS/Fargate) that fans out to multiple backends. No
layer needed, at the cost of in-handler network latency on flush.

> Note on Datadog specifically: the stripped Lambda collector does **not** bundle
> the Datadog exporter, and the Datadog extension's OTLP endpoint accepts traces
> but **not** custom metrics. For metrics, point the metrics exporter at Datadog's
> OTLP intake with per-signal env vars (see *Datadog* under "Sending to a backend"), or
> route through a collector build that includes the `datadog` exporter.

## The esbuild / SST caveat (important)

OTEL auto-instrumentation patches modules at `require()` time. esbuild inlines
those modules, so the patch never lands and you get spans for your own code but
none for `http`, `fetch()`, `@aws-sdk/*`, or `pg`. Two fixes:

1. **Externalize the instrumented packages** so they're resolved at runtime and
   can be patched. In SST v2:

   ```ts
   nodejs: {
     esbuild: {
       external: ['@opentelemetry/*', 'lambda-otel', 'pg'],
     },
   },
   // @aws-sdk/* is provided by the Lambda runtime and already external.
   ```

   Combine with `NODE_OPTIONS=--require lambda-otel/register`.

   The same idea in other toolchains. The list to externalize is always:
   `@opentelemetry/*`, `lambda-otel`, plus every library you want traced that
   isn't provided by the runtime (`pg`, `koa`, `pino`, …). `@aws-sdk/*` ships
   with the Node runtime and is already external. Externalized packages must
   still be present in `node_modules` at runtime, so use the "install" knob
   where the toolchain has one.

   | Toolchain | Where |
   |---|---|
   | SST v2 | `nodejs.esbuild.external: [...]` + `nodejs.install: ['lambda-otel', 'pg']` |
   | SST v3 (Ion) | `nodejs: { esbuild: { external: [...] }, install: ['lambda-otel', 'pg'] }` |
   | CDK `NodejsFunction` | `bundling: { externalModules: ['@aws-sdk/*', ...], nodeModules: ['lambda-otel', 'pg', ...] }` |
   | Serverless Framework + `serverless-esbuild` | `custom.esbuild.external: [...]` and `custom.esbuild.exclude: ['@aws-sdk/*']` |
   | SAM (`BuildMethod: esbuild`) | `Metadata.BuildProperties.External: [...]` |
   | Plain `esbuild` CLI | `--external:@opentelemetry/* --external:lambda-otel --external:pg` |

   If you cannot externalize (single-file artifact required), you keep the root
   span, `faas.*` metrics, custom metrics, and manual spans — only auto-instrumented
   child spans are lost.

2. **Or** attach a collector layer that also ships the language SDK wrapper and
   let it own instrumentation; use this package purely for the metrics facade and
   flush-correct handler wrapper.

**ESM functions** use `--import lambda-otel/register` instead of `--require`.
The ESM entry first registers OpenTelemetry's loader hook (`module.register`,
Node ≥ 18.19 / 20.6), then initializes the SDK; without the hook, packages the
handler `import`s are never patched and you would see only the root span.
`register.mjs` is what makes SST v2's default `nodejs.format: "esm"` work.

## Configuration

`initObservability(config)` / env fallbacks:

| Option            | Env fallback                    | Default                  |
|-------------------|---------------------------------|--------------------------|
| `serviceName`     | `OTEL_SERVICE_NAME`, fn name    | `unknown-service`        |
| `serviceVersion`  | fn version                      | —                        |
| `environment`     | `DEPLOYMENT_ENV`                | —                        |
| `resourceAttributes` | `OTEL_RESOURCE_ATTRIBUTES`   | —                        |
| `otlpEndpoint`    | `OTEL_EXPORTER_OTLP_ENDPOINT`   | `http://localhost:4318`  |
| `exporterTimeoutMillis` | `OTEL_EXPORTER_OTLP[_<SIGNAL>]_TIMEOUT` | `3000`         |
| `instrumentations`| —                               | http, undici, aws-sdk, pg |
| `instrumentationConfig` | —                         | upstream defaults        |
| `redact`          | —                               | off                      |
| `metricsConfig`   | —                               | warn at 1000 attr sets   |
| `xrayPropagation` | —                               | `false`                  |
| `views` / `defaultViews` | —                        | built-in histogram views |
| `telemetryMetrics`| —                               | `false`                  |
| `debug`           | `OTEL_DEBUG=true` (register), else `OTEL_LOG_LEVEL` | off  |

`withObservability(handler, opts)` per-handler options:

| Option | Default | What it does |
|---|---|---|
| `timeoutMarginMs` | `500` | Fire timeout capture this many ms before the deadline; `false` disables |
| `flushTimeoutMs` | `5000` | Cap on the post-invocation flush; also bounded by remaining time |
| `httpErrorStatus` | `true` | Returned `statusCode >= 500` on http triggers is an error |
| `experimentalAttributes` | `true` | FaaS/messaging semconv enrichment + batch links |
| `extractCarrier` | `event.headers` | Where inbound trace context comes from (keys case-insensitive) |
| `requestHook` / `responseHook` | — | Annotate the root span; errors swallowed |
| `spanName` | function name | Root span name |

### Custom metrics API

`metrics` is a facade over the OTel meter; instruments are created lazily and
cached by name, so call it from anywhere without holding references.

| Call | Instrument | Use for |
|---|---|---|
| `metrics.count(name, value = 1, attrs?, opts?)` | Counter (monotonic) | events: orders created, retries, cache misses |
| `metrics.record(name, value, attrs?, opts?)` | Histogram | distributions: latency, payload size, batch size |
| `metrics.gauge(name, value, attrs?, opts?)` | Gauge | point-in-time values: queue depth, pool size |

```ts
metrics.count('orders.created', 1, { currency: 'AUD' });
metrics.record('fx.quote_latency', 0.042, { provider: 'xe' }, { unit: 's' });
metrics.gauge('worker.queue_depth', 17);
```

`opts` is `{ unit?, description? }` and applies when the instrument is first
created (instruments are cached by name). Units are UCUM as OTel expects:
`'s'`, `'ms'`, `'By'`, `'{request}'`. Naming: dotted lowercase
(`domain.thing`). Attributes become dimensions/tags on the backend, so keep
cardinality low (no user IDs, request IDs, timestamps).

**Histogram buckets.** OTel's default explicit buckets (`0, 5, 10, 25 … 10000`)
are sized for milliseconds. The package registers Views that give its own
`faas.*_duration` / `aws.lambda.*_duration` histograms seconds-scale buckets
(5 ms → 15 min) and `faas.mem_usage` an exponential histogram. For your own
`record()` histograms, either record in the unit the default buckets fit
(milliseconds) or add a View:

```ts
import { AggregationType } from '@opentelemetry/sdk-metrics';
initObservability({
  views: [{
    instrumentName: 'fx.quote_latency',
    aggregation: { type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM, options: { boundaries: [0.01, 0.05, 0.1, 0.5, 1] } },
  }],
});
```

Datadog converts OTLP histograms to distributions and ignores buckets, so this
only matters on Prometheus-style backends (Grafana Cloud, Mimir, etc).

### Sampling

Standard OTel env vars are honored (verified against the installed package):

```
OTEL_TRACES_SAMPLER=parentbased_traceidratio
OTEL_TRACES_SAMPLER_ARG=0.1     # keep 10% of new traces; always follow an inbound sampled parent
```

Metrics are never sampled.

### Flush cost and Lambda timeouts

Every invocation ends with an OTLP export (`finally` block). With a sidecar
collector on localhost this is single-digit milliseconds; against a remote
endpoint it is a real network round-trip added to billed duration.

The wait is bounded: `min(flushTimeoutMs, remainingTime - 100ms)`, default cap
5 s. Past that the handler returns and the exporters keep going in the
background (finishing on the next warm invoke, or lost at freeze) with a
`flush abandoned` warning.

The exporters' own per-request timeout defaults to **3 s** (OTel's own default
is 10 s, which would exceed the flush cap and turn a dead endpoint into a 5 s
stall plus a warning on every invoke). Override with `exporterTimeoutMillis`
in code, or with the standard env vars, which take precedence when set:

```
OTEL_EXPORTER_OTLP_TIMEOUT=2000            # ms, all signals
OTEL_EXPORTER_OTLP_METRICS_TIMEOUT=1000    # per signal
```

A flush that fails or is abandoned is logged and swallowed — it never changes
the handler's result.

**Timeout capture.** Lambda kills the process at the deadline; a plain
`finally` never runs, so the slowest invocations — the ones you want traced —
would vanish. The wrapper arms a timer at `remaining - timeoutMarginMs`
(default 500 ms). When it fires:

- the root span gets `error.type=timeout`, an ERROR status, and a
  `lambda.timeout_imminent` event, and is ended;
- `faas.timeouts` and `faas.errors{error.type=timeout}` are counted,
  `faas.invoke_duration` is recorded;
- everything is flushed with whatever budget the margin leaves.

The handler itself is not interrupted. If it finishes inside the margin its
result is still returned (the span is already closed as a timeout — widen or
narrow the margin to taste). Set `timeoutMarginMs: false` to disable.

**Emitted automatically.** Metrics: `faas.coldstarts`, `faas.invocations`,
`faas.errors` (attribute `error.type` = exception class, HTTP status code, or
`timeout`), `faas.timeouts`, `faas.invoke_duration` (histogram, seconds), and
`faas.init_duration` (histogram, seconds — `process.uptime()` at the first
invoke, i.e. the Node process's share of init; enable `telemetryMetrics` for the
platform's full number). Root span: `faas.coldstart`, `faas.invocation_id`,
`http.response.status_code` for http triggers, `error.type` on failure, and
the trigger-derived attributes described above.

> `faas.mem_usage`, the platform's *billed* and *init* duration, and SnapStart
> restore time only exist in the Lambda Telemetry API. See *Platform metrics*
> below for the in-process extension or the Collector layer.

## Custom carrier extraction (SQS / EventBridge)

`withObservability` reads `event.headers` by default. For other sources, supply
an extractor that returns a carrier with `traceparent`:

```ts
withObservability(handler, {
  extractCarrier: (event) => {
    const attrs = event?.Records?.[0]?.messageAttributes ?? {};
    return { traceparent: attrs.traceparent?.stringValue };
  },
});
```

`extractCarrier` sets the root span's **parent**, so it's a single context — use
it for one-context sources (a single SQS message, an HTTP request). For SQS/SNS
**batches**, the wrapper already adds one **span link per record** automatically
(pulled from each message's `traceparent`), which is the spec-correct way to tie a
batch back to many producers. You don't need `extractCarrier` for the links.

Carrier keys are lowercased before extraction, so `Traceparent` from an API
Gateway REST (v1) event — which preserves the client's header casing — works.

### AWS X-Ray

If API Gateway / ALB / EventBridge active tracing is on, or upstream services
emit X-Ray context, turn on `xrayPropagation` and install the optional peer:

```bash
npm install @opentelemetry/propagator-aws-xray
```

```ts
initObservability({ xrayPropagation: true });
```

Then:

| Source | Becomes |
|---|---|
| `X-Amzn-Trace-Id` request header | root span **parent** (same trace as the X-Ray segment) |
| `_X_AMZN_TRACE_ID` env var (set by Lambda on every invoke) | span **link** |
| SQS record `attributes.AWSTraceHeader` | one span **link** per record (when no `traceparent`) |

The env var is deliberately a link, never a parent: Lambda populates it with
`Sampled=0` whenever active tracing is off, and a non-sampled parent would make
the default `parentbased` sampler drop the entire trace.

## Capturing payloads and per-invocation context (hooks)

Event/response capture is never automatic — that's deliberate, so you own the PII
and cardinality. Use `requestHook`/`responseHook` to add exactly what you want:

```ts
withObservability(handler, {
  requestHook: (span, { event }) => {
    // Record sizes, not bodies, by default. Redact before you attach anything.
    span.setAttribute('app.batch_size', (event as any)?.Records?.length ?? 1);
  },
  responseHook: (span, { res, err }) => {
    if ((res as any)?.statusCode) {
      span.setAttribute('http.response.status_code', (res as any).statusCode);
    }
  },
});
```

Hooks run inside the root span and are best-effort: a throwing hook is logged via
`diag` and never breaks your handler.

## Using with Middy (or any other wrapper)

`withObservability` must be the **outermost** wrapper so the root span covers
every middleware and the flush runs after all of them:

```ts
import middy from '@middy/core';
import httpJsonBodyParser from '@middy/http-json-body-parser';
import { withObservability } from 'lambda-otel';

const base = async (event: any) => ({ statusCode: 200, body: JSON.stringify(event.body) });

export const handler = withObservability(
  middy(base).use(httpJsonBodyParser()),
);
```

The same applies to `serverless-http`, Powertools' `injectLambdaContext`, etc.

## Controlling what gets captured

Three layers, all additive and all off unless you set them.

### Per-instrumentation options (`instrumentationConfig`)

Each key takes the upstream instrumentation's own config object — every hook,
ignore function and header-capture option it supports — or `false` to leave
that instrumentation out. No need to rebuild the list to change one flag.

```ts
initObservability({
  instrumentationConfig: {
    http: {
      ignoreIncomingRequestHook: (req) => req.url === '/health',
      headersToSpanAttributes: { client: { requestHeaders: ['x-request-id'] } },
      redactedQueryParams: ['token', 'signature'],
    },
    undici: { requireParentforSpans: true },                             // fetch(); or false
    pg: { enhancedDatabaseReporting: false, ignoreConnectSpans: true }, // or false
    awsSdk: { sqsExtractContextPropagationFromPayload: false },         // or false
    koa: { ignoreLayersType: ['middleware'] },                          // opt-in, see below
  },
});
```

| Key | Upstream type | Notes |
|---|---|---|
| `http` | `HttpInstrumentationConfig` | ignore hooks, `headersToSpanAttributes`, `redactedQueryParams`, request/response hooks |
| `undici` | `UndiciInstrumentationConfig` | outbound global `fetch()`; `instrumentation-http` does not see it on Node 18+ |
| `awsSdk` | `AwsSdkInstrumentationConfig` | `suppressInternalInstrumentation` stays `true` unless you flip it |
| `pg` | `PgInstrumentationConfig` | `enhancedDatabaseReporting` adds bound parameter values — leave off for PII |
| `koa` | mirror of `KoaInstrumentationConfig` | registered only when set; needs `npm install @opentelemetry/instrumentation-koa` |

`instrumentations: [...]` still replaces the whole set when you need something
not in the map (pino/winston for log correlation, a framework not listed):

```ts
initObservability({
  instrumentations: [
    ...defaultInstrumentations({ koa: { ignoreLayersType: ['middleware'] } }),
    new PinoInstrumentation(),
  ],
});
```

Register extra instrumentations in a preload (so they patch before the library
loads) and, if you bundle with esbuild, add them to the externalized list.

### Attribute redaction (`redact`)

Instrumentation hooks are per library, and some attributes are unconditional
(`pg` always sets `db.query.text`). `redact` runs at the **export boundary** —
one matcher over every span, span event, span link and forwarded log record,
whatever produced it:

```ts
initObservability({
  redact: {
    dropAttributes: ['db.query.text', 'http.request.header.*', '*.password'],
    attribute: (key, value, { signal, name }) =>
      key === 'url.full' ? String(value).split('?')[0] : value, // return undefined to drop
  },
});
```

`dropAttributes` takes exact keys or `*` wildcards and runs first; `attribute`
sees everything that survives. Attributes are edited in place, so every
exporter downstream sees the redacted view. A custom `logRecordProcessor`
bypasses the log half — wrap your own exporter with `RedactingLogRecordExporter`
in that case.

### Custom metric filtering (`metricsConfig`)

```ts
initObservability({
  metricsConfig: {
    drop: ['debug.*'],                                 // never exported
    allowedAttributes: { 'orders.*': ['currency'] },   // strip every other tag
    deniedAttributes: { 'payments.count': ['card_last4'] },
    cardinalityLimit: 2000,                            // SDK hard cap per instrument (default 2000)
    warnCardinalityAbove: 1000,                        // facade warning; false to silence
  },
});
```

`drop` / `allowedAttributes` / `deniedAttributes` are sugar over OTel Views
(`DROP` aggregation and allow/deny attribute processors) and take the same
`*` patterns. Two caveats from how Views work: a pattern that also matches
one of the package's built-in `faas.*` histogram views produces a second
stream for that instrument, so scope patterns to your own names; and
`cardinalityLimit` only applies to the package-built metric reader.

`warnCardinalityAbove` is the early-warning half: the `metrics` facade counts
distinct attribute sets per instrument and logs one warning when a name
crosses the threshold — almost always a request ID, user ID or timestamp that
leaked into a tag. Tracking stops at the threshold, so memory stays bounded.

## Logs (trace correlation + optional forwarding)

```bash
npm install @opentelemetry/instrumentation-pino     # or -winston
```

Add the instrumentation to your set (see `examples/instrument.ts`). It works in
two modes:

- **Correlation (default, recommended for Lambda).** Injects `trace_id`,
  `span_id`, and `trace_flags` into every log line. Your logs still go to
  stdout → CloudWatch, but now each line links to the trace it came from. No
  extra pipeline, no extra cost.
- **OTLP forwarding (opt-in).** Set `logs: true` (or pass a `logExporter`) and
  the package stands up a `LoggerProvider` that ships log records over OTLP to
  the collector alongside traces and metrics, flushed on every invocation. This
  is **off by default** because many collectors disable OTLP log ingestion to
  avoid surprise billing, and in Lambda CloudWatch already has the logs.

```ts
initObservability({
  logs: true, // forward log records over OTLP
  instrumentations: [...defaultInstrumentations(), new PinoInstrumentation()],
});
```

## Platform metrics — max memory, init/billed/restore duration

Some metrics aren't measurable from inside the handler — max memory used, billed
duration, the platform's full init duration (extensions included), and SnapStart
restore duration only exist in the Lambda **Telemetry API**'s `platform.report`
/ `platform.initReport` events, which are delivered to an extension, not to your
code. There are two ways to get them, and they're complementary.

### Recommended for production: the OTel Collector layer

Attach the OpenTelemetry Collector Lambda layer and enable its
`telemetryapireceiver`. The Collector registers as a proper external extension
(so it gets `SHUTDOWN` and never drops the final report) and converts platform
telemetry into OTel spans/metrics — no code change, fully vendor-neutral, and
nothing for this package to maintain. This is the robust path.

### Lightweight / dev: the in-process extension (experimental)

If you'd rather not attach a layer, set `telemetryMetrics: true`. The package
registers an **internal** extension from within the Node process, subscribes to
the platform stream, and emits:

| Metric | Unit | Source |
|---|---|---|
| `faas.mem_usage` | bytes | `maxMemoryUsedMB` |
| `aws.lambda.init_duration` | seconds | `platform.initReport` `durationMs` — runtime + extensions + module load |
| `aws.lambda.billed_duration` | seconds | `billedDurationMs` |
| `aws.lambda.restore_duration` | seconds | SnapStart `restoreDurationMs` |

`faas.timeouts` is **not** emitted here: the handler wrapper counts timeouts
itself (see *Flush cost and Lambda timeouts*), which sees them before the
sandbox dies and avoids double counting.

```ts
initObservability({ telemetryMetrics: true }); // requires metrics enabled
```

Know the trade-offs before using this in production:

- **One-invocation lag.** The `platform.report` for invocation N arrives async,
  usually during invocation N+1, so these metrics trail real time slightly.
- **No `SHUTDOWN`.** Internal extensions don't get the shutdown event, so the
  last report before a sandbox freeze/reap can be lost.
- **No `faas.cpu_usage` / `faas.net_io`.** Those aren't in the Lambda report at
  all — only CloudWatch Lambda Insights exposes them, via a separate mechanism.
- It adds a small cold-start cost and is best-effort: if registration fails it
  silently disables itself and never affects your handler.

`faas.init_duration` is always emitted by the handler wrapper (approximated from
`process.uptime()` on cold start), independent of this setting.

## Examples

See [`examples/`](./examples):

- `basic-handler.ts` — the smallest useful setup: preload + wrap + one custom
  metric + one manual span. Start here.
- `eventbridge-cron.ts` — a scheduled (timer) function with a work-loop span and
  a gauge; shows what `withObservability` sets for non-HTTP triggers.
- `instrument.ts` — a project preload adding Koa + Undici on top of the core set.
- `api-handler.ts` — a Koa BFF on Lambda, with a business-operation span and a
  custom metric.
- `sqs-consumer.ts` — an SQS-triggered worker that links back to the producer's
  trace via the `traceparent` message attribute (the `extractCarrier` hook).

## Sending to a backend

The package emits OTLP and honors the standard `OTEL_EXPORTER_OTLP_*` env vars
(base endpoint, per-signal endpoints, and headers), so most backends are config
only. The collector/extension you point at decides the destination.

**Grafana Cloud** — all three signals, direct OTLP:

```
OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp-gateway-<zone>.grafana.net/otlp
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Basic <base64(instanceID:token)>
```

**Sentry** — traces + logs only (no metrics); set `metrics: false`:

```
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://oXXX.ingest.us.sentry.io/api/<project>/integration/otlp/v1/traces
OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=https://oXXX.ingest.us.sentry.io/api/<project>/integration/otlp/v1/logs
OTEL_EXPORTER_OTLP_TRACES_HEADERS=x-sentry-auth=sentry sentry_key=<public-key>
OTEL_EXPORTER_OTLP_LOGS_HEADERS=x-sentry-auth=sentry sentry_key=<public-key>
```

**Datadog** — three working setups. The package code is identical in all of
them; only the layer and env differ. **C is the recommended one** when you
want custom metrics without running a collector.

*A. Datadog Lambda Extension only (traces + logs, no OTLP metrics).* Least setup.

1. Attach the extension layer:
   `arn:aws:lambda:<region>:464622532012:layer:Datadog-Extension:<version>`
   (`Datadog-Extension-ARM` for arm64).
2. Function env:
   ```
   DD_API_KEY=<key>                       # or DD_API_KEY_SECRET_ARN
   DD_SITE=datadoghq.com                  # datadoghq.eu, us5.datadoghq.com, ...
   DD_OTLP_CONFIG_RECEIVER_PROTOCOLS_HTTP_ENDPOINT=localhost:4318
   DD_ENV=prod
   DD_SERVICE=my-fn
   OTEL_SERVICE_NAME=my-fn
   NODE_OPTIONS=--require lambda-otel/register
   ```
   Leave `OTEL_EXPORTER_OTLP_ENDPOINT` unset; the default `localhost:4318`
   reaches the extension.
3. The extension rejects OTLP **metrics**. The package tolerates this (flush is
   best-effort), but every invoke would make one failing POST and log a warning,
   so either disable them (`initObservability({ metrics: false })` in your own
   preload) or route them straight to Datadog's OTLP intake — setup C.
   The extension emits its own `aws.lambda.enhanced.*` cold-start/duration/error
   metrics regardless.

*B. OpenTelemetry Collector with the `datadog` exporter (traces + metrics + logs).*
Use this when custom metrics matter.

1. Run a collector build that includes `datadogexporter` (`otelcol-contrib`;
   the stripped `opentelemetry-lambda` layer does not). Either a custom Lambda
   layer or a central gateway on ECS/Fargate.
2. Collector config:
   ```yaml
   receivers:
     otlp:
       protocols:
         http:
           endpoint: 0.0.0.0:4318
   processors:
     batch:
       timeout: 1s
   exporters:
     datadog:
       api:
         key: ${env:DD_API_KEY}
         site: datadoghq.com
   service:
     pipelines:
       traces:  { receivers: [otlp], processors: [batch], exporters: [datadog] }
       metrics: { receivers: [otlp], processors: [batch], exporters: [datadog] }
       logs:    { receivers: [otlp], processors: [batch], exporters: [datadog] }
   ```
3. Function env:
   ```
   OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318      # layer; or http://collector.internal:4318 for a gateway
   OTEL_SERVICE_NAME=my-fn
   DEPLOYMENT_ENV=prod
   NODE_OPTIONS=--require lambda-otel/register
   ```
   Datadog maps `service.name` → `service` and `deployment.environment.name` → `env`.

*C. Extension for traces + Datadog's OTLP metrics intake for metrics.*
No collector. Verified working end to end: root/child spans via the
extension, `faas.*` and custom `metrics.*` via the intake.

Datadog's [OTLP metrics intake](https://docs.datadoghq.com/opentelemetry/setup/otlp_ingest/metrics/)
accepts **delta** temporality only, which is what this package emits, so the
metrics exporter can target it directly with per-signal env vars.

1. Attach the extension layer and set the `DD_*` env exactly as in setup A.
2. Add per-signal env for metrics only; traces keep the `localhost:4318` default:
   ```
   OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=https://otlp.datadoghq.com/v1/metrics   # otlp.datadoghq.eu, otlp.us5.datadoghq.com, ...
   OTEL_EXPORTER_OTLP_METRICS_HEADERS=dd-api-key=<key>
   ```
   Keep `metrics: true` (the default). Do **not** pass `otlpEndpoint` in code —
   a code value overrides every env var and would send metrics to the extension.
3. Caveats:
   - The API key lives in an env var; `DD_API_KEY_SECRET_ARN` is read by the
     extension, not by the OTel exporter. To keep the key out of env, resolve it
     from Secrets Manager in your own preload and pass
     `initObservability({ headers: { 'dd-api-key': key } })` — but that header
     then applies to the trace exporter too, which the extension ignores.
   - One outbound HTTPS POST per invoke on flush (typically tens of ms). Set
     `OTEL_EXPORTER_OTLP_TIMEOUT` low so a Datadog outage cannot stall the handler.
   - Intake rejects payloads over 512 KiB compressed; not a concern at Lambda
     per-invoke volumes.

The same per-signal env vars also cover other hybrids, e.g. traces to the
extension and metrics to a collector.

| Backend | Traces | Metrics | Logs |
|---|---|---|---|
| Grafana Cloud | ✓ | ✓ | ✓ |
| Sentry | ✓ | — | ✓ (beta) |
| Datadog | ✓ | ✓ (OTLP intake or collector; not via extension) | ✓ |

## Local development

Fastest way to see what the package emits without any backend: run a collector
that prints to stdout and point the handler at it.

```bash
docker run --rm -p 4318:4318 -v $PWD/otel-local.yaml:/etc/otelcol/config.yaml \
  otel/opentelemetry-collector-contrib:latest --config /etc/otelcol/config.yaml
```

```yaml
# otel-local.yaml
receivers:
  otlp: { protocols: { http: { endpoint: 0.0.0.0:4318 } } }
exporters:
  debug: { verbosity: detailed }
service:
  pipelines:
    traces:  { receivers: [otlp], exporters: [debug] }
    metrics: { receivers: [otlp], exporters: [debug] }
```

Then invoke your handler locally (SAM/SST dev, or a plain script that calls it)
with `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 OTEL_DEBUG=true`. A GUI
alternative is [otel-desktop-viewer](https://github.com/CtrlSpice/otel-desktop-viewer)
(listens on the same port).

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Root span only; no `http` / `pg` / AWS SDK child spans | Libraries were imported before the SDK initialized, or esbuild inlined them | Use `NODE_OPTIONS=--require lambda-otel/register` (or call `initObservability()` first thing); externalize packages per the bundler matrix |
| No outbound `fetch()` spans | `@opentelemetry/instrumentation-undici` omitted (`--omit=optional`) or `instrumentationConfig.undici: false` | Reinstall it; it is in the default set |
| Nothing arrives at all | Wrong endpoint / port, or flush not running | Check `OTEL_EXPORTER_OTLP_ENDPOINT` (base URL, no `/v1/...`); confirm the handler is wrapped; set `OTEL_DEBUG=true` and read the exporter logs |
| Warning `lambda-otel: flush failed` every invoke, traces fine | Endpoint rejects one signal (e.g. Datadog extension rejects metrics) | `initObservability({ metrics: false })`, or route that signal elsewhere with per-signal env vars |
| Duplicate `sdk-trace-base` / type errors about `Resource` | Mixed OTel package generations in your project | Align versions with the table below; keep `@opentelemetry/api` at `^1.9` |
| Handler slower by ~exporter timeout | Remote collector unreachable, flush waits for timeout | Lower `OTEL_EXPORTER_OTLP_TIMEOUT`, or use a sidecar layer |
| Inbound trace not linked (new trace per request) | No `traceparent` in `event.headers`, or non-HTTP source | Confirm the caller propagates W3C context; for SQS/EventBridge use `extractCarrier` or rely on batch span links |
| Cold-start metric never `true` | Warm sandbox reused across test invokes | Expected; deploy a new version or wait for a fresh sandbox |
| ESM handler: root span only, `pg`/`http` children missing | `--require` used with an ESM bundle, so the ESM loader hook is not installed | Use `NODE_OPTIONS=--import lambda-otel/register` |
| Spans end early with `error.type=timeout` but the handler completed | `timeoutMarginMs` larger than the handler's tail latency | Lower the margin, raise the function timeout, or set `timeoutMarginMs: false` |
| `flush abandoned after Nms` warnings | Endpoint slower than `flushTimeoutMs` / remaining time | Lower `exporterTimeoutMillis`, raise `flushTimeoutMs`, or use a sidecar |
| p50/p99 of `faas.invoke_duration` look flat on Grafana/Prometheus | Custom histogram recorded in seconds against default ms buckets | Built-in `faas.*` histograms already have seconds buckets; add a View for your own (see *Custom metrics API*) |
| Traces not joined to X-Ray / API Gateway active tracing | `xrayPropagation` off or peer missing | `initObservability({ xrayPropagation: true })` + install `@opentelemetry/propagator-aws-xray` |
| SQL text / auth headers showing up in a vendor UI | Instrumentation sets them by default | `redact.dropAttributes: ['db.query.text', 'http.request.header.*']`, or per-library options via `instrumentationConfig` |
| `metric "x" has reached N distinct attribute sets` warning | A per-request value is used as a metric attribute | Remove it, or `metricsConfig.allowedAttributes` / `deniedAttributes`; raise `warnCardinalityAbove` if intentional |
| Metric vanished after adding `metricsConfig` | `drop` pattern too broad (`'*'`, `'orders*'`) | Narrow the pattern; check `metricsConfigViews(cfg)` output |

Set `OTEL_DEBUG=true` (with the `register` preload) or the standard
`OTEL_LOG_LEVEL=debug` to get the OTel diagnostic logger; it prints every export
attempt and its result.

## Compatibility & maintenance

OpenTelemetry JS splits **stable** packages (`sdk-*`, `resources`, `api`) from
**experimental** ones (`exporter-*`, `instrumentation-*`). They must come from the
same release generation or types and runtime will clash (you'll see duplicate
copies of `sdk-trace-base` and confusing type errors). This is the most common
issue users hit, so each release of this package targets one generation:

| This package | `@opentelemetry/api` | Stable SDK (`sdk-*`, `resources`) | Experimental (`exporter-*`, `instrumentation-*`) |
|--------------|----------------------|-----------------------------------|--------------------------------------------------|
| 0.2.x        | ^1.9                 | ^2.0                              | ^0.219 / ^0.74 (aws-sdk) / ^0.71 (pg, optional)  |
| 0.1.x        | ^1.9                 | ^2.0                              | ^0.219 / ^0.74 (aws-sdk) / ^0.71 (pg)            |

`@opentelemetry/instrumentation-pg` is an `optionalDependency`: installed by
default, but a project without Postgres can drop it (`npm install
--omit=optional`, or an override) and the default instrumentation set skips it.

If you bump one OTel package, bump them together. `package.json` `overrides`
force a single copy of the stable packages to prevent duplicate-version drift.

## Testing

```bash
npm test   # builds, then tsx --test test/*.test.ts
```

Tests inject in-memory exporters via `initObservability({ traceExporter, metricReader })`
and assert on emitted spans and metrics — no live collector required. The
preload tests spawn `node --import` / `--require lambda-otel/register` against
the built `dist/`, resolving the package through its own `exports` map exactly
as a consumer would. CI (`.github/workflows/ci.yml`) runs lint, tests, and
`npm audit` on Node 18/20/22.

## Publishing

```bash
npm version patch|minor   # commits "chore: release vX.Y.Z" and tags vX.Y.Z
git push --follow-tags    # the tag triggers .github/workflows/publish.yml
```

The workflow runs the tests, checks the tag matches `package.json`, and runs
`npm publish --provenance` so npm shows the package as built from this repo and
commit. One-time setup: add an npm Automation token as the `NPM_TOKEN` repo
secret (or configure npm Trusted Publishing for the workflow and drop the token).
Publishing locally still works (`npm publish --otp=<code>`) but carries no
provenance.
