export {
  initObservability,
  flush,
  shutdown,
  isInitialized,
  defaultViews,
  DURATION_SECONDS_BUCKETS,
} from './sdk';
export {
  withObservability,
  type WrapOptions,
  type RequestHook,
  type ResponseHook,
  type LambdaContextLike,
} from './handler';
export { detectTrigger, type TriggerInfo, type FaasTriggerType } from './triggers';
export { normalizeCarrier } from './propagation';
export {
  startTelemetryExtension,
  ingestTelemetryEvent,
  isTelemetryExtensionActive,
  type TelemetryExtensionOptions,
} from './telemetry-api';
export { metrics, type InstrumentOptions } from './metrics';
export { defaultInstrumentations } from './instrumentations';
export type { ObservabilityConfig } from './types';

// Re-export the OTEL API surface most consumers reach for, so they don't have
// to add @opentelemetry/api as a direct dependency for basic manual spans.
export { trace, context, propagation, SpanKind, SpanStatusCode } from '@opentelemetry/api';
