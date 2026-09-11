import * as resources from '@opentelemetry/resources';
import type { ObservabilityConfig } from './types';

/**
 * Builds an OTEL Resource describing this Lambda.
 *
 * The @opentelemetry/resources API changed between 1.x (new Resource(attrs))
 * and 2.x (resourceFromAttributes(attrs)). We detect which is present so the
 * package works across the range consumers may have installed.
 */
type ResourceAttrs = Record<string, string | number | boolean>;

/**
 * Parse the standard `OTEL_RESOURCE_ATTRIBUTES` env var: comma-separated
 * `key=value` pairs, values percent-decoded (spec: W3C Baggage encoding).
 * Malformed pairs are skipped rather than failing init.
 */
export function parseResourceAttributesEnv(raw: string | undefined): ResourceAttrs {
  const out: ResourceAttrs = {};
  if (!raw) return out;
  for (const pair of raw.split(',')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const key = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Precedence, highest first:
 *   1. explicit config (`serviceName`, `serviceVersion`, `environment`)
 *   2. the dedicated env vars (`OTEL_SERVICE_NAME`, `DEPLOYMENT_ENV`)
 *   3. `resourceAttributes` from code
 *   4. `OTEL_RESOURCE_ATTRIBUTES`
 *   5. Lambda-derived defaults (function name/version, region, memory)
 * Lambda always sets AWS_LAMBDA_FUNCTION_NAME/VERSION, so they must be the
 * fallback, never an override — otherwise a `service.name` set through
 * OTEL_RESOURCE_ATTRIBUTES (as the spec allows) would be clobbered.
 * `cloud.provider` / `cloud.platform` are always the package's.
 */
export function buildResource(config: ObservabilityConfig) {
  const user: ResourceAttrs = {
    ...parseResourceAttributesEnv(process.env.OTEL_RESOURCE_ATTRIBUTES),
    ...(config.resourceAttributes ?? {}),
  };
  const memMb = process.env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE;
  const lambdaDefaults: Record<string, string | number | undefined> = {
    'service.name': process.env.AWS_LAMBDA_FUNCTION_NAME,
    'service.version': process.env.AWS_LAMBDA_FUNCTION_VERSION,
    'faas.name': process.env.AWS_LAMBDA_FUNCTION_NAME,
    'faas.version': process.env.AWS_LAMBDA_FUNCTION_VERSION,
    // Semconv: faas.max_memory is in bytes; the Lambda env var is in MB.
    'faas.max_memory': memMb ? Number(memMb) * 1024 * 1024 : undefined,
    'cloud.region': process.env.AWS_REGION,
  };
  const explicit: Record<string, string | undefined> = {
    'service.name': config.serviceName ?? process.env.OTEL_SERVICE_NAME,
    'service.version': config.serviceVersion,
    'deployment.environment.name': config.environment ?? process.env.DEPLOYMENT_ENV,
  };

  const attrs: ResourceAttrs = {};
  for (const [k, v] of Object.entries(lambdaDefaults)) if (v != null) attrs[k] = v;
  Object.assign(attrs, user);
  for (const [k, v] of Object.entries(explicit)) if (v != null) attrs[k] = v;
  attrs['service.name'] ??= 'unknown-service';
  attrs['cloud.provider'] = 'aws';
  attrs['cloud.platform'] = 'aws_lambda';

  const r = resources as unknown as {
    resourceFromAttributes?: (a: ResourceAttrs) => unknown;
    Resource?: new (a: ResourceAttrs) => unknown;
  };
  if (typeof r.resourceFromAttributes === 'function') {
    return r.resourceFromAttributes(attrs);
  }
  return new r.Resource!(attrs);
}
