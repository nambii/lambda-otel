// ESM preload entry. Use via:  NODE_OPTIONS="--import lambda-otel/register"
//
// Two jobs, in this order:
//  1. Install OpenTelemetry's ESM loader hook (import-in-the-middle) so
//     instrumentations can patch packages that the handler `import`s. Without
//     it only `require()`d modules get patched, which under an ESM handler
//     means none of them — you'd see the root span and nothing else.
//  2. Initialize the SDK (same code path as the CommonJS `--require` entry).
import * as nodeModule from 'node:module';

if (typeof nodeModule.register === 'function') {
  // Node >= 20.6 / 18.19.
  nodeModule.register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);
} else {
  process.emitWarning(
    'lambda-otel: module.register() is unavailable on this Node version; ESM imports will not be instrumented. ' +
      'Use Node >= 20.6 (or 18.19), or a CommonJS bundle with --require.',
  );
}

const require = nodeModule.createRequire(import.meta.url);
require('./register.js');
