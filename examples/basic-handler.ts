/**
 * The smallest useful setup. No framework, no extra instrumentations.
 *
 * Lambda env:
 *   NODE_OPTIONS=--require lambda-otel/register   # init SDK before this module loads
 *   OTEL_SERVICE_NAME=orders-api
 *   DEPLOYMENT_ENV=prod
 *   # OTEL_EXPORTER_OTLP_ENDPOINT unset -> http://localhost:4318 (sidecar collector layer)
 *
 * What you get for free: a root SERVER span named after the function with
 * inbound `traceparent` extraction, faas.* attributes, cold-start / duration /
 * error metrics, child spans for outbound http / @aws-sdk / pg calls, and a
 * flush of everything before the sandbox freezes.
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { withObservability, metrics, trace } from 'lambda-otel';

const tracer = trace.getTracer('orders');

export const handler = withObservability<APIGatewayProxyEventV2, APIGatewayProxyResultV2>(
  async (event) => {
    const order = JSON.parse(event.body ?? '{}') as { id: string; amount: number; currency: string };

    // A manual span for the business step you actually care about.
    await tracer.startActiveSpan('order.validate', async (span) => {
      span.setAttribute('order.currency', order.currency);
      try {
        validate(order);
      } finally {
        span.end();
      }
    });

    // Custom metric: becomes a counter with `currency` as a dimension.
    metrics.count('orders.created', 1, { currency: order.currency });
    metrics.record('orders.amount', order.amount, { currency: order.currency });

    return { statusCode: 201, body: JSON.stringify({ id: order.id }) };
  },
  {
    responseHook: (span, { res }) => {
      const status = (res as APIGatewayProxyResultV2 as { statusCode?: number })?.statusCode;
      if (status) span.setAttribute('http.response.status_code', status);
    },
  },
);

function validate(order: { id: string; amount: number }): void {
  if (!order.id || !(order.amount > 0)) throw new Error('invalid order');
}
