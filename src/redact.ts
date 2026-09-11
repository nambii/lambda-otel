import type { AttributeValue } from '@opentelemetry/api';
import type { ExportResult } from '@opentelemetry/core';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';
import type { LogRecordExporter, ReadableLogRecord } from '@opentelemetry/sdk-logs';
import type { RedactConfig, RedactContext } from './types';

/**
 * Attribute redaction at the export boundary. Wrapping the exporter (rather
 * than a SpanProcessor) means every attribute is final — instrumentation hooks,
 * manual spans, events and links all pass through one place — and the same
 * matcher serves spans and log records.
 *
 * Attributes are edited in place: the span has already ended, and every
 * exporter in the pipeline should see the redacted view.
 */

/** Compile `dropAttributes` patterns once. `*` matches any run of characters. */
export function compileMatcher(patterns: string[] | undefined): (key: string) => boolean {
  if (!patterns?.length) return () => false;
  const exact = new Set<string>();
  const regexps: RegExp[] = [];
  for (const p of patterns) {
    if (!p.includes('*')) exact.add(p);
    else regexps.push(new RegExp(`^${p.split('*').map(escapeRegExp).join('.*')}$`));
  }
  return (key) => exact.has(key) || regexps.some((r) => r.test(key));
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Span attributes and log AnyValueMaps differ in value type; the redactor edits either. */
type AttributeMap = Record<string, unknown>;

export type AttributeRedactor = (attrs: AttributeMap | undefined, ctx: RedactContext) => void;

/** Build one redactor from the config; returns undefined when there is nothing to do. */
export function buildRedactor(config: RedactConfig | undefined): AttributeRedactor | undefined {
  if (!config || (!config.dropAttributes?.length && !config.attribute)) return undefined;
  const drop = compileMatcher(config.dropAttributes);
  const transform = config.attribute;
  return (attrs, ctx) => {
    if (!attrs) return;
    for (const key of Object.keys(attrs)) {
      if (drop(key)) {
        delete attrs[key];
        continue;
      }
      if (transform) {
        const current = attrs[key];
        if (current === undefined) continue;
        const next = transform(key, current as AttributeValue, ctx);
        if (next === undefined) delete attrs[key];
        else if (next !== current) attrs[key] = next as unknown;
      }
    }
  };
}

export function redactSpan(span: ReadableSpan, redact: AttributeRedactor): void {
  const ctx: RedactContext = { signal: 'span', name: span.name };
  redact(span.attributes, ctx);
  for (const event of span.events) redact(event.attributes, ctx);
  for (const link of span.links) redact(link.attributes, ctx);
}

export function redactLogRecord(record: ReadableLogRecord, redact: AttributeRedactor): void {
  redact(record.attributes, {
    signal: 'log',
    name: typeof record.body === 'string' ? record.body : undefined,
  });
}

export class RedactingSpanExporter implements SpanExporter {
  constructor(
    private readonly inner: SpanExporter,
    private readonly redact: AttributeRedactor,
  ) {}
  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    for (const span of spans) redactSpan(span, this.redact);
    this.inner.export(spans, resultCallback);
  }
  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }
  forceFlush(): Promise<void> {
    return this.inner.forceFlush?.() ?? Promise.resolve();
  }
}

export class RedactingLogRecordExporter implements LogRecordExporter {
  constructor(
    private readonly inner: LogRecordExporter,
    private readonly redact: AttributeRedactor,
  ) {}
  export(logs: ReadableLogRecord[], resultCallback: (result: ExportResult) => void): void {
    for (const record of logs) redactLogRecord(record, this.redact);
    this.inner.export(logs, resultCallback);
  }
  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }
  forceFlush(): Promise<void> {
    return this.inner.forceFlush?.() ?? Promise.resolve();
  }
}
