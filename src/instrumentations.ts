import { diag } from '@opentelemetry/api';
import type { Instrumentation } from '@opentelemetry/instrumentation';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { AwsInstrumentation } from '@opentelemetry/instrumentation-aws-sdk';
import type { InstrumentationConfigMap } from './types';

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
 * an override) and this still works. `@opentelemetry/instrumentation-koa` is an
 * optional peer, registered only when `koa` config is given.
 */
export function defaultInstrumentations(config: InstrumentationConfigMap = {}): Instrumentation[] {
  const list: Instrumentation[] = [];

  if (config.http !== false) {
    list.push(new HttpInstrumentation(config.http ?? {}));
  }

  if (config.awsSdk !== false) {
    // suppressInternalInstrumentation hides the SDK's inner http spans, which
    // would otherwise double every AWS call. Callers can still flip it.
    list.push(new AwsInstrumentation({ suppressInternalInstrumentation: true, ...(config.awsSdk ?? {}) }));
  }

  if (config.pg !== false) {
    const PgInstrumentation = optionalRequire('@opentelemetry/instrumentation-pg', 'PgInstrumentation');
    if (PgInstrumentation) list.push(new PgInstrumentation(config.pg ?? {}));
    else diag.debug('lambda-otel: @opentelemetry/instrumentation-pg not installed; skipping pg spans');
  }

  if (config.koa && config.koa !== undefined) {
    const KoaInstrumentation = optionalRequire('@opentelemetry/instrumentation-koa', 'KoaInstrumentation');
    if (KoaInstrumentation) list.push(new KoaInstrumentation(config.koa));
    else {
      diag.warn(
        'lambda-otel: instrumentationConfig.koa is set but @opentelemetry/instrumentation-koa is not installed; skipping',
      );
    }
  }

  return list;
}

type InstrumentationCtor = new (cfg?: any) => Instrumentation;

function optionalRequire(pkg: string, exportName: string): InstrumentationCtor | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require(pkg);
    const ctor = mod?.[exportName];
    return typeof ctor === 'function' ? ctor : undefined;
  } catch {
    return undefined;
  }
}
