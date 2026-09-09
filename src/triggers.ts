import {
  context,
  propagation,
  SpanKind,
  trace,
  type Attributes,
  type Link,
} from '@opentelemetry/api';

/**
 * Maps an inbound Lambda event onto the OpenTelemetry FaaS/messaging semantic
 * conventions: a `faas.trigger` class, the correct span kind, trigger-specific
 * attributes, and — for batch messaging sources — one span link per record.
 *
 * Everything here is OTel "Development" (experimental) stability, so the handler
 * gates it behind `experimentalAttributes` (default on). See aws-lambda.md:
 * https://github.com/open-telemetry/semantic-conventions/blob/main/docs/faas/aws-lambda.md
 */

export type FaasTriggerType = 'http' | 'pubsub' | 'datasource' | 'timer' | 'other';

export interface TriggerInfo {
  /** `faas.trigger` value. */
  trigger: FaasTriggerType;
  /** Span kind appropriate for the trigger (CONSUMER for messaging/datasource). */
  kind: SpanKind;
  /** Trigger-derived semantic-convention attributes. */
  attributes: Attributes;
  /** Per-record span links for batch messaging sources (W3C `traceparent`). */
  links: Link[];
}

const OTHER: TriggerInfo = {
  trigger: 'other',
  kind: SpanKind.SERVER,
  attributes: { 'faas.trigger': 'other' },
  links: [],
};

export function detectTrigger(event: unknown): TriggerInfo {
  if (!event || typeof event !== 'object') return OTHER;
  const e = event as Record<string, any>;

  const records: any[] = Array.isArray(e.Records) ? e.Records : [];
  // SNS spells it `EventSource`; the others use `eventSource`.
  const source: string | undefined = records[0]?.eventSource ?? records[0]?.EventSource;
  switch (source) {
    case 'aws:sqs':
      return sqs(records);
    case 'aws:sns':
      return sns(records);
    case 'aws:kinesis':
      return kinesis(records);
    case 'aws:dynamodb':
      return dynamodb(records);
    case 'aws:s3':
      return s3(records);
  }

  // EventBridge / CloudWatch scheduled rules → timer.
  if (
    e.source === 'aws.events' ||
    e['detail-type'] === 'Scheduled Event' ||
    e['detail-type'] === 'Scheduled'
  ) {
    const attributes: Attributes = { 'faas.trigger': 'timer' };
    if (typeof e.time === 'string') attributes['faas.time'] = e.time;
    return { trigger: 'timer', kind: SpanKind.SERVER, attributes, links: [] };
  }

  // HTTP: API Gateway HTTP API (v2) / Lambda Function URL. Require the HTTP
  // shape itself — keying off `version === '2.0'` alone would misclassify any
  // direct-invoke payload that happens to carry a `version` field.
  if (e.requestContext?.http?.method) {
    const attributes: Attributes = { 'faas.trigger': 'http' };
    const method = e.requestContext.http.method;
    if (method) attributes['http.request.method'] = method;
    if (e.routeKey && e.routeKey !== '$default') attributes['http.route'] = e.routeKey;
    if (e.rawPath) attributes['url.path'] = e.rawPath;
    return { trigger: 'http', kind: SpanKind.SERVER, attributes, links: [] };
  }

  // HTTP: Application Load Balancer.
  if (e.requestContext?.elb) {
    const attributes: Attributes = { 'faas.trigger': 'http' };
    if (e.httpMethod) attributes['http.request.method'] = e.httpMethod;
    if (e.path) attributes['url.path'] = e.path;
    return { trigger: 'http', kind: SpanKind.SERVER, attributes, links: [] };
  }

  // HTTP: API Gateway REST API (v1).
  if (e.httpMethod) {
    const attributes: Attributes = { 'faas.trigger': 'http', 'http.request.method': e.httpMethod };
    // The spec wants the proxy *resource* (templated path), not the concrete path.
    if (e.resource) attributes['http.route'] = e.resource;
    if (e.path) attributes['url.path'] = e.path;
    return { trigger: 'http', kind: SpanKind.SERVER, attributes, links: [] };
  }

  return OTHER;
}

/**
 * Attributes that depend on the Lambda invocation context rather than the event:
 * `cloud.resource_id` / `cloud.account.id` (only knowable at invoke time, hence
 * span attributes not resource attributes) plus the invoked-function identity.
 */
export function lambdaContextAttributes(lambdaContext: any): Attributes {
  const attributes: Attributes = {};
  const arn: string | undefined = lambdaContext?.invokedFunctionArn;
  if (arn) {
    // arn:aws:lambda:<region>:<account>:function:<name>[:<qualifier>]
    const parts = arn.split(':');
    if (parts[4]) attributes['cloud.account.id'] = parts[4];
    // Replace any alias suffix with the resolved version: the same instance can
    // be invoked through multiple aliases, so the resolved ARN is the stable id.
    const version: string | undefined = lambdaContext?.functionVersion;
    let resourceId = arn;
    if (version) {
      if (parts.length >= 8) {
        parts[7] = version;
        resourceId = parts.slice(0, 8).join(':');
      } else if (parts.length === 7) {
        resourceId = `${arn}:${version}`;
      }
    }
    attributes['cloud.resource_id'] = resourceId;
  }
  // Note: the function's own identity (faas.name/version, cloud.region) lives in
  // the Resource (see resource.ts). faas.invoked_* would be wrong here — those
  // describe a callee on a *caller's* outbound-invoke span, not this root span.
  return attributes;
}

// ─── messaging sources ───

function sqs(records: any[]): TriggerInfo {
  const attributes: Attributes = {
    'faas.trigger': 'pubsub',
    'messaging.system': 'aws_sqs',
    'messaging.operation.type': 'process',
  };
  const dest = lastArnSegment(records[0]?.eventSourceARN);
  if (dest) attributes['messaging.destination.name'] = dest;
  if (records.length > 1) attributes['messaging.batch.message_count'] = records.length;
  const links: Link[] = [];
  for (const r of records) {
    // Default to W3C traceparent in user message attributes (what
    // instrumentation-aws-sdk injects). AWSTraceHeader/X-Ray would need the
    // X-Ray propagator dependency, deliberately not pulled in here.
    const tp = r?.messageAttributes?.traceparent?.stringValue;
    pushLink(links, tp);
  }
  return { trigger: 'pubsub', kind: SpanKind.CONSUMER, attributes, links };
}

function sns(records: any[]): TriggerInfo {
  const attributes: Attributes = {
    'faas.trigger': 'pubsub',
    'messaging.system': 'aws_sns',
    'messaging.operation.type': 'process',
  };
  const dest = lastArnSegment(records[0]?.Sns?.TopicArn);
  if (dest) attributes['messaging.destination.name'] = dest;
  if (records.length > 1) attributes['messaging.batch.message_count'] = records.length;
  const links: Link[] = [];
  for (const r of records) {
    const tp = r?.Sns?.MessageAttributes?.traceparent?.Value;
    pushLink(links, tp);
  }
  return { trigger: 'pubsub', kind: SpanKind.CONSUMER, attributes, links };
}

function kinesis(records: any[]): TriggerInfo {
  const attributes: Attributes = {
    'faas.trigger': 'pubsub',
    'messaging.system': 'aws_kinesis',
    'messaging.operation.type': 'process',
  };
  // Kinesis ARN: arn:aws:kinesis:<region>:<account>:stream/<name>
  const arn: string | undefined = records[0]?.eventSourceARN;
  const stream = arn?.split('/').pop();
  if (stream) attributes['messaging.destination.name'] = stream;
  if (records.length > 1) attributes['messaging.batch.message_count'] = records.length;
  return { trigger: 'pubsub', kind: SpanKind.CONSUMER, attributes, links: [] };
}

// ─── datasource sources ───

function dynamodb(records: any[]): TriggerInfo {
  const attributes: Attributes = { 'faas.trigger': 'datasource' };
  // Stream ARN: arn:aws:dynamodb:<region>:<account>:table/<name>/stream/<ts>
  const table = records[0]?.eventSourceARN?.split('/')[1];
  if (table) attributes['faas.document.collection'] = table;
  if (records.length === 1) {
    const op = ddbOperation(records[0]?.eventName);
    if (op) attributes['faas.document.operation'] = op;
    const seconds = records[0]?.dynamodb?.ApproximateCreationDateTime;
    if (typeof seconds === 'number') {
      attributes['faas.document.time'] = new Date(seconds * 1000).toISOString();
    }
  }
  return { trigger: 'datasource', kind: SpanKind.CONSUMER, attributes, links: [] };
}

function s3(records: any[]): TriggerInfo {
  const attributes: Attributes = { 'faas.trigger': 'datasource' };
  const r = records[0];
  if (r?.s3?.bucket?.name) attributes['faas.document.collection'] = r.s3.bucket.name;
  if (records.length === 1) {
    const op = s3Operation(r?.eventName);
    if (op) attributes['faas.document.operation'] = op;
    if (r?.s3?.object?.key) attributes['faas.document.name'] = r.s3.object.key;
    if (r?.eventTime) attributes['faas.document.time'] = r.eventTime;
  }
  return { trigger: 'datasource', kind: SpanKind.CONSUMER, attributes, links: [] };
}

// ─── helpers ───

function lastArnSegment(arn?: string): string | undefined {
  if (!arn) return undefined;
  const parts = arn.split(':');
  return parts[parts.length - 1] || undefined;
}

function ddbOperation(eventName?: string): string | undefined {
  switch (eventName) {
    case 'INSERT':
      return 'insert';
    case 'MODIFY':
      return 'edit';
    case 'REMOVE':
      return 'delete';
    default:
      return undefined;
  }
}

function s3Operation(eventName?: string): string | undefined {
  if (!eventName) return undefined;
  if (eventName.startsWith('ObjectCreated')) return 'insert';
  if (eventName.startsWith('ObjectRemoved')) return 'delete';
  return undefined;
}

function pushLink(links: Link[], traceparent?: string): void {
  if (!traceparent) return;
  const ctx = propagation.extract(context.active(), { traceparent });
  const spanContext = trace.getSpanContext(ctx);
  if (spanContext?.traceId) links.push({ context: spanContext });
}
