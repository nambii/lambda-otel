/**
 * Koa BFF API handler on Lambda.
 *
 * Assumes `instrument.ts` is preloaded via NODE_OPTIONS so Koa + Undici are
 * already patched. `withObservability` provides the root SERVER span (with
 * cold-start / duration / error metrics and W3C context extraction from the
 * incoming API Gateway headers); KoaInstrumentation adds the per-route child
 * spans underneath it; UndiciInstrumentation traces any outbound fetch() calls.
 */
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import Koa from 'koa';
import Router from '@koa/router';
import serverless from 'serverless-http';
import { withObservability, metrics, trace } from '@yourscope/lambda-otel';

const app = new Koa();
const router = new Router();

router.get('/health', (ctx) => {
  ctx.body = { ok: true };
});

router.post('/quotes', async (ctx) => {
  // A business-operation span: invisible to generic instrumentation, but the
  // most useful thing in the trace. Attributes make it queryable.
  const quote = await trace
    .getTracer('bff')
    .startActiveSpan('fx.price_quote', async (span) => {
      span.setAttribute('fx.currency_pair', 'AUD/USD');
      const result = await priceQuote(); // your pricing logic
      span.setAttribute('fx.margin_bps', result.marginBps);
      span.end();
      return result;
    });

  metrics.count('fx.quotes_issued', 1, { pair: 'AUD/USD' });
  ctx.body = quote;
});

app.use(router.routes()).use(router.allowedMethods());

// serverless-http turns the Koa app into a Lambda (event, context) handler.
const lambda = serverless(app);

export const handler = withObservability<APIGatewayProxyEvent, APIGatewayProxyResult>(
  (event, context) => lambda(event, context) as Promise<APIGatewayProxyResult>,
);

async function priceQuote(): Promise<{ rate: number; marginBps: number }> {
  return { rate: 0.65, marginBps: 25 };
}
