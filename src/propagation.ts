import {
  context,
  diag,
  propagation,
  trace,
  type Link,
  type TextMapPropagator,
} from '@opentelemetry/api';
import { CompositePropagator, W3CBaggagePropagator, W3CTraceContextPropagator } from '@opentelemetry/core';

/** Header name X-Ray uses (lowercased; carriers are normalized before extract). */
export const XRAY_HEADER = 'x-amzn-trace-id';

let xrayEnabled = false;

/** True when the X-Ray propagator is part of the global propagator. */
export function isXrayEnabled(): boolean {
  return xrayEnabled;
}

/**
 * Build the global propagator: W3C trace-context + baggage, plus AWS X-Ray when
 * requested and the optional peer is installed. Returns undefined to let the
 * tracer provider register its own default (identical to the W3C pair).
 */
export function buildPropagator(xray: boolean | undefined): TextMapPropagator | undefined {
  xrayEnabled = false;
  if (!xray) return undefined;
  let AWSXRayPropagator: (new () => TextMapPropagator) | undefined;
  try {
    // Optional peer: only required when xrayPropagation is on.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    AWSXRayPropagator = require('@opentelemetry/propagator-aws-xray').AWSXRayPropagator;
  } catch {
    diag.warn(
      'lambda-otel: xrayPropagation is on but @opentelemetry/propagator-aws-xray is not installed; ' +
        'falling back to W3C only',
    );
    return undefined;
  }
  xrayEnabled = true;
  return new CompositePropagator({
    propagators: [
      new W3CTraceContextPropagator(),
      new W3CBaggagePropagator(),
      new AWSXRayPropagator!(),
    ],
  });
}

/**
 * Lowercase every key so header lookups are case-insensitive. API Gateway REST
 * (v1) preserves the client's casing (`Traceparent`, `X-Amzn-Trace-Id`), and the
 * W3C propagator's getter does an exact-key lookup. Non-string values are
 * dropped; arrays keep their first element (multi-value headers).
 */
export function normalizeCarrier(input: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!input || typeof input !== 'object') return out;
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    const value = Array.isArray(v) ? v[0] : v;
    if (typeof value === 'string') out[k.toLowerCase()] = value;
  }
  return out;
}

/**
 * Extract a span context from a carrier through the global propagator and
 * return it as a span link, or undefined when nothing valid was found. Used for
 * batch records and for the X-Ray env var, where a parent relationship would be
 * wrong (or, for a non-sampled X-Ray parent, would drop the trace).
 */
export function linkFromCarrier(carrier: Record<string, string>): Link | undefined {
  const ctx = propagation.extract(context.active(), carrier);
  const spanContext = trace.getSpanContext(ctx);
  return spanContext && trace.isSpanContextValid(spanContext) ? { context: spanContext } : undefined;
}

/**
 * Lambda sets `_X_AMZN_TRACE_ID` on every invocation. When X-Ray propagation is
 * on, expose it as a link so the OTel trace can be joined to the X-Ray segment
 * (API Gateway / ALB / EventBridge with active tracing).
 */
export function xrayEnvLink(): Link | undefined {
  if (!xrayEnabled) return undefined;
  const header = process.env._X_AMZN_TRACE_ID;
  if (!header) return undefined;
  return linkFromCarrier({ [XRAY_HEADER]: header });
}
