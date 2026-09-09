// Preload entry. Use via:  NODE_OPTIONS="--require lambda-otel/register"
// Runs before the handler module loads so instrumentations can patch libraries
// (http, @aws-sdk/*, pg) before they are required.
import { initObservability } from './sdk';

initObservability({ debug: process.env.OTEL_DEBUG === 'true' });
