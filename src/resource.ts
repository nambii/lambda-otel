import * as resources from '@opentelemetry/resources';
import type { ObservabilityConfig } from './types';

/**
 * Builds an OTEL Resource describing this Lambda.
 *
 * The @opentelemetry/resources API changed between 1.x (new Resource(attrs))
 * and 2.x (resourceFromAttributes(attrs)). We detect which is present so the
 * package works across the range consumers may have installed.
 */
export function buildResource(config: ObservabilityConfig) {
  const attrs: Record<string, string | number> = {
    'service.name':
      config.serviceName ??
      process.env.OTEL_SERVICE_NAME ??
      process.env.AWS_LAMBDA_FUNCTION_NAME ??
      'unknown-service',
    'cloud.provider': 'aws',
    'cloud.platform': 'aws_lambda',
  };

  const memMb = process.env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE;
  const optional: Record<string, string | number | undefined> = {
    'service.version': config.serviceVersion ?? process.env.AWS_LAMBDA_FUNCTION_VERSION,
    'deployment.environment.name': config.environment ?? process.env.DEPLOYMENT_ENV,
    'faas.name': process.env.AWS_LAMBDA_FUNCTION_NAME,
    'faas.version': process.env.AWS_LAMBDA_FUNCTION_VERSION,
    // Semconv: faas.max_memory is in bytes; the Lambda env var is in MB.
    'faas.max_memory': memMb ? Number(memMb) * 1024 * 1024 : undefined,
    'cloud.region': process.env.AWS_REGION,
  };
  for (const [k, v] of Object.entries(optional)) {
    if (v != null) attrs[k] = v;
  }

  const r = resources as unknown as {
    resourceFromAttributes?: (a: Record<string, string | number>) => unknown;
    Resource?: new (a: Record<string, string | number>) => unknown;
  };
  if (typeof r.resourceFromAttributes === 'function') {
    return r.resourceFromAttributes(attrs);
  }
  return new r.Resource!(attrs);
}
