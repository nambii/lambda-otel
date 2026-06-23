import type { Instrumentation } from '@opentelemetry/instrumentation';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { AwsInstrumentation } from '@opentelemetry/instrumentation-aws-sdk';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';

/**
 * Registered explicitly (not via auto-discovery) so the set is deterministic
 * and so it can be patched correctly when this module is loaded before the
 * instrumented libraries are required — see README for the esbuild caveat.
 *
 * Deliberately omits AwsLambdaInstrumentation: its handler-patching relies on
 * the _HANDLER env resolving to an on-disk module, which breaks under bundling.
 * withObservability() creates the root span and extracts context instead.
 */
export function defaultInstrumentations(): Instrumentation[] {
  return [
    new HttpInstrumentation(),
    new AwsInstrumentation({ suppressInternalInstrumentation: true }),
    new PgInstrumentation(), // Aurora/Postgres via TypeORM, node-postgres driver
  ];
}
