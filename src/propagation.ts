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
