/**
 * Project-specific preload for a Koa BFF.
 *
 * Reference it from your Lambda config:
 *   NODE_OPTIONS="--require ./dist/instrument.js"   (CJS)
 *   NODE_OPTIONS="--import ./dist/instrument.js"     (ESM)
 *
 * Why a preload and not the handler module: instrumentation patches `koa` and
 * `undici` at require-time, so it must run BEFORE those modules are imported.
 * The package's built-in `lambda-otel/register` only loads the core
 * set (http, undici, aws-sdk, pg); this adds the API-handler instrumentations on top.
 *
 * Bundling note: with esbuild/SST, mark these external so they can be patched —
 *   external: ['@opentelemetry/*', 'lambda-otel', 'pg', 'koa', '@koa/router']
 */
import { initObservability, defaultInstrumentations } from 'lambda-otel';
import { PinoInstrumentation } from '@opentelemetry/instrumentation-pino';
// Winston is the same shape:
// import { WinstonInstrumentation } from '@opentelemetry/instrumentation-winston';

initObservability({
  environment: process.env.DEPLOYMENT_ENV,
  // Set logs:true to also forward log records over OTLP to the collector.
  // Leave it off to keep logs in CloudWatch and just correlate by trace_id.
  // logs: true,
  // Keep SQL text and auth headers out of every span, whatever emitted them.
  redact: { dropAttributes: ['db.query.text', 'http.request.header.*'] },
  instrumentations: [
    ...defaultInstrumentations({
      // http + undici + aws-sdk + pg with their upstream options, plus opt-in koa.
      http: { ignoreIncomingRequestHook: (req) => req.url === '/health' },
      // Generic per-middleware spans are noisy; keep router (route-name) spans,
      // drop the rest. Remove this to see every middleware layer.
      koa: { ignoreLayersType: ['middleware'] },
    }),
    // Injects trace_id / span_id / trace_flags into every pino log line so logs
    // link to the active span. Add WinstonInstrumentation here if you use winston.
    new PinoInstrumentation(),
  ],
});
