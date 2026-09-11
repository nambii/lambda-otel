export { initObservability, flush, shutdown, isInitialized } from './sdk';
export {
  withObservability,
  type WrapOptions,
  type RequestHook,
  type ResponseHook,
  type LambdaContextLike,
} from './handler';
export { detectTrigger, type TriggerInfo, type FaasTriggerType } from './triggers';
export {
  startTelemetryExtension,
  ingestTelemetryEvent,
  isTelemetryExtensionActive,
  type TelemetryExtensionOptions,
} from './telemetry-api';
export { metrics } from './metrics';
export { defaultInstrumentations } from './instrumentations';
export type { ObservabilityConfig } from './types';

// Re-export the OTEL API surface most consumers reach for, so they don't have
// to add @opentelemetry/api as a direct dependency for basic manual spans.
export { trace, context, propagation, SpanKind, SpanStatusCode } from '@opentelemetry/api';
