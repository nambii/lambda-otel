import { diag } from '@opentelemetry/api';
import type { Instrumentation } from '@opentelemetry/instrumentation';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { AwsInstrumentation } from '@opentelemetry/instrumentation-aws-sdk';

/**
 * Registered explicitly (not via auto-discovery) so the set is deterministic
 * and so it can be patched correctly when this module is loaded before the
 * instrumented libraries are required — see README for the esbuild caveat.
 *
 * Deliberately omits AwsLambdaInstrumentation: its handler-patching relies on
 * the _HANDLER env resolving to an on-disk module, which breaks under bundling.
 * withObservability() creates the root span and extracts context instead.
 *
 * `@opentelemetry/instrumentation-pg` is an optionalDependency: installed by
 * default, but a consumer without Postgres can drop it (`--omit=optional`, or
 * an override) and this still works.
 */
export function defaultInstrumentations(): Instrumentation[] {
  const list: Instrumentation[] = [
    new HttpInstrumentation(),
    new AwsInstrumentation({ suppressInternalInstrumentation: true }),
  ];
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { PgInstrumentation } = require('@opentelemetry/instrumentation-pg');
    list.push(new PgInstrumentation()); // Aurora/Postgres via TypeORM, node-postgres driver
  } catch {
    diag.debug('lambda-otel: @opentelemetry/instrumentation-pg not installed; skipping pg spans');
  }
  return list;
}
