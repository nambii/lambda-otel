export { initObservability, flush, shutdown, isInitialized } from './sdk';
export { withObservability, type WrapOptions } from './handler';
export { metrics } from './metrics';
export { defaultInstrumentations } from './instrumentations';
export type { ObservabilityConfig } from './types';

// Re-export the OTEL API surface most consumers reach for, so they don't have
// to add @opentelemetry/api as a direct dependency for basic manual spans.
export { trace, context, propagation, SpanKind, SpanStatusCode } from '@opentelemetry/api';
