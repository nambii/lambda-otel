# @yourscope/lambda-otel

Vendor-neutral OpenTelemetry **traces + metrics** for AWS Lambda (Node.js).

The package only ever speaks **OTLP** to an endpoint. It contains no Datadog,
Sentry, or other vendor exporter — the backend is decided entirely by the
collector you point it at. Switching backends is a config change, never a
republish.

## What it does that the raw SDK / ADOT layer don't

- **Force-flushes traces *and* metrics on every invocation.** Lambda freezes the
  sandbox between invokes, so the metrics SDK's periodic export timer is
  unreliable. The handler wrapper flushes both signals in a `finally` before the
  runtime freezes. Flush is best-effort — a failed export never breaks your handler.
- **Delta temporality for metrics.** Cumulative counters are meaningless across
  ephemeral, concurrent sandboxes that reset on cold start. Delta makes each
  export self-contained and is what OTLP backends expect from serverless.
- **Explicit instrumentation + a preload entry** so it survives esbuild bundling
  (see the caveat below).
- **Cold-start, duration, and error metrics** plus a root span with inbound
  context propagation, out of the box.

## Install

```bash
npm install @yourscope/lambda-otel @opentelemetry/api
```

## Usage

Initialize once (ideally via the preload, so instrumentation patches libraries
before they're required), then wrap your handler:

```ts
// handler.ts
import { withObservability, metrics } from '@yourscope/lambda-otel';

export const handler = withObservability(async (event) => {
  metrics.count('orders.created', 1, { currency: 'AUD' });
  metrics.record('fx.quote_latency_ms', 42);
  return { statusCode: 200, body: 'ok' };
});
```

```jsonc
// Lambda env
"NODE_OPTIONS": "--require @yourscope/lambda-otel/register"
```

If you can't use a preload, call `initObservability()` yourself as the very
first thing your entrypoint does (before importing instrumented libraries):

```ts
import { initObservability, withObservability } from '@yourscope/lambda-otel';
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
> but **not** custom metrics. For full metrics to Datadog, route through a custom
> collector build (or central gateway) that includes the `datadog` exporter.

## The esbuild / SST caveat (important)

OTEL auto-instrumentation patches modules at `require()` time. esbuild inlines
those modules, so the patch never lands and you get spans for your own code but
none for `http`, `@aws-sdk/*`, or `pg`. Two fixes:

1. **Externalize the instrumented packages** so they're resolved at runtime and
   can be patched. In SST v2:

   ```ts
   nodejs: {
     esbuild: {
       external: ['@opentelemetry/*', '@yourscope/lambda-otel', 'pg'],
     },
   },
   // @aws-sdk/* is provided by the Lambda runtime and already external.
   ```

   Combine with `NODE_OPTIONS=--require @yourscope/lambda-otel/register`.

2. **Or** attach a collector layer that also ships the language SDK wrapper and
   let it own instrumentation; use this package purely for the metrics facade and
   flush-correct handler wrapper.

ESM functions use `--import` instead of `--require`.

## Configuration

`initObservability(config)` / env fallbacks:

| Option            | Env fallback                    | Default                  |
|-------------------|---------------------------------|--------------------------|
| `serviceName`     | `OTEL_SERVICE_NAME`, fn name    | `unknown-service`        |
| `serviceVersion`  | fn version                      | —                        |
| `environment`     | `DEPLOYMENT_ENV`                | —                        |
| `otlpEndpoint`    | `OTEL_EXPORTER_OTLP_ENDPOINT`   | `http://localhost:4318`  |
| `instrumentations`| —                               | http, aws-sdk, pg        |
| `debug`           | `OTEL_DEBUG=true`               | `false`                  |

Emitted automatically: `faas.coldstarts`, `faas.errors`,
`faas.invoke_duration_ms`, plus a `SERVER` root span with `faas.coldstart` and
`faas.invocation_id`.

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

## Optional instrumentations

The core install stays lean (`http` + `aws-sdk` + `pg`). Add framework-specific
instrumentations yourself and pass them in. For a Koa API handler:

```bash
npm install @opentelemetry/instrumentation-koa @opentelemetry/instrumentation-undici
```

```ts
import { defaultInstrumentations, initObservability } from '@yourscope/lambda-otel';
import { KoaInstrumentation } from '@opentelemetry/instrumentation-koa';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';

initObservability({
  instrumentations: [...defaultInstrumentations(), new KoaInstrumentation(), new UndiciInstrumentation()],
});
```

- **Koa** adds a span per route/middleware under the `http` server span. It's
  chatty — use `ignoreLayersType` to keep only the route spans.
- **Undici** traces outbound global `fetch()`, which `instrumentation-http`
  does **not** capture on Node 18+.

Register these in a preload (so they patch before `koa`/`undici` load) and, if
you bundle with esbuild, add them to the externalized list.

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

## Examples

See [`examples/`](./examples):

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

**Datadog** — attach the Datadog Lambda Extension (`DD_API_KEY`, `DD_SITE`) and
enable its OTLP receiver (`DD_OTLP_CONFIG_RECEIVER_PROTOCOLS_HTTP_ENDPOINT=localhost:4318`);
the default localhost export reaches it. Traces and logs flow this way, but the
extension does **not** accept custom metrics over OTLP — route those via DogStatsD
or use a collector built with the `datadog` exporter for the full set.

| Backend | Traces | Metrics | Logs |
|---|---|---|---|
| Grafana Cloud | ✓ | ✓ | ✓ |
| Sentry | ✓ | — | ✓ (beta) |
| Datadog | ✓ | not via extension OTLP | ✓ |

## Compatibility & maintenance

OpenTelemetry JS splits **stable** packages (`sdk-*`, `resources`, `api`) from
**experimental** ones (`exporter-*`, `instrumentation-*`). They must come from the
same release generation or types and runtime will clash (you'll see duplicate
copies of `sdk-trace-base` and confusing type errors). This is the most common
issue users hit, so each release of this package targets one generation:

| This package | `@opentelemetry/api` | Stable SDK (`sdk-*`, `resources`) | Experimental (`exporter-*`, `instrumentation-*`) |
|--------------|----------------------|-----------------------------------|--------------------------------------------------|
| 0.1.x        | ^1.9                 | ^2.0                              | ^0.219 / ^0.74 (aws-sdk) / ^0.71 (pg)            |

If you bump one OTel package, bump them together. `package.json` `overrides`
force a single copy of the stable packages to prevent duplicate-version drift.

## Testing

```bash
npm test   # tsx --test test/*.test.ts
```

Tests inject in-memory exporters via `initObservability({ traceExporter, metricReader })`
and assert on emitted spans and metrics — no live collector required.

## Publishing

```bash
npm run build                      # tsc -> dist/
npm publish --access public --provenance
```

`--provenance` attaches a verifiable supply-chain attestation (run it from CI on
a tagged release). Set a real scope/name and confirm the license before publishing.
