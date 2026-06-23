import * as http from 'node:http';
import { diag } from '@opentelemetry/api';
import { metrics } from './metrics';

/**
 * In-process Lambda Telemetry API integration (experimental).
 *
 * Registers an *internal* Lambda extension from within the Node process, stands
 * up a local HTTP listener, subscribes to the `platform` telemetry stream, and
 * translates each `platform.report` into OTel metrics that the handler cannot
 * measure itself: max memory used, billed duration, SnapStart restore duration,
 * and timeouts.
 *
 * Caveats (see README — this is why the Collector layer is the recommended
 * production path):
 *  - The `platform.report` for invocation N is delivered asynchronously, usually
 *    during invocation N+1, so these metrics lag by one invocation.
 *  - Internal extensions receive no SHUTDOWN event, so the final report before a
 *    sandbox is frozen/reaped can be lost.
 *  - `faas.cpu_usage` / `faas.net_io` are NOT in the Lambda report (only Lambda
 *    Insights exposes those), so they are intentionally not emitted here.
 *
 * Everything is best-effort: any failure disables the integration and is logged
 * via `diag`; it must never affect the user's handler.
 */

const EXTENSION_NAME = 'lambda-otel-telemetry';
const EXT_API = '2020-01-01';
const TEL_API = '2022-07-01';
const DEFAULT_PORT = 4243;
const MIB = 1024 * 1024;

let active = false;

/** True once the internal extension has registered and subscribed successfully. */
export function isTelemetryExtensionActive(): boolean {
  return active;
}

export interface TelemetryExtensionOptions {
  /** Port for the local telemetry listener. Default 4243. */
  listenerPort?: number;
}

/**
 * Start the internal telemetry extension. No-op outside a real Lambda runtime
 * (when AWS_LAMBDA_RUNTIME_API is unset). Fire-and-forget: never await this on
 * the handler path.
 */
export async function startTelemetryExtension(opts: TelemetryExtensionOptions = {}): Promise<void> {
  const runtimeApi = process.env.AWS_LAMBDA_RUNTIME_API;
  if (!runtimeApi) {
    diag.debug('lambda-otel: telemetry extension skipped (no AWS_LAMBDA_RUNTIME_API)');
    return;
  }
  const port = opts.listenerPort ?? DEFAULT_PORT;
  try {
    const extensionId = await register(runtimeApi);
    // Confirm the listener is actually bound before subscribing — otherwise we
    // could advertise a destination that never receives anything and still mark
    // the extension active.
    await startListener(port);
    await subscribe(runtimeApi, extensionId, port);
    active = true;
    // Drive the lifecycle loop in the background. We do no work between events,
    // so calling /next never delays the sandbox freeze.
    void nextLoop(runtimeApi, extensionId);
    diag.debug('lambda-otel: telemetry extension active');
  } catch (err) {
    diag.warn('lambda-otel: telemetry extension failed to start', err);
  }
}

/**
 * Translate a single Telemetry API event into OTel metrics. Exported for unit
 * testing; the listener calls this for every event in a batch.
 */
export function ingestTelemetryEvent(event: unknown): void {
  if (!event || typeof event !== 'object') return;
  const e = event as { type?: string; record?: any };
  const m = e.record?.metrics;
  if (!m) return;

  if (e.type === 'platform.report') {
    // Spec metric: faas.mem_usage (bytes). Do NOT tag with requestId — that
    // would explode metric cardinality.
    if (typeof m.maxMemoryUsedMB === 'number') {
      metrics.record('faas.mem_usage', m.maxMemoryUsedMB * MIB);
    }
    // AWS-specific but the key cost signal.
    if (typeof m.billedDurationMs === 'number') {
      metrics.record('aws.lambda.billed_duration', m.billedDurationMs / 1000);
    }
    // Spec metric: faas.timeouts.
    if (e.record?.status === 'timeout') {
      metrics.count('faas.timeouts', 1);
    }
  } else if (e.type === 'platform.restoreReport') {
    if (typeof m.restoreDurationMs === 'number') {
      metrics.record('aws.lambda.restore_duration', m.restoreDurationMs / 1000);
    }
  }
}

// ─── runtime/extension plumbing ───

function register(runtimeApi: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // Internal extensions may only register for INVOKE (not SHUTDOWN).
    const body = JSON.stringify({ events: ['INVOKE'] });
    const req = http.request(
      `http://${runtimeApi}/${EXT_API}/extension/register`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Lambda-Extension-Name': EXTENSION_NAME,
        },
      },
      (res) => {
        res.resume();
        const id = res.headers['lambda-extension-identifier'];
        if (res.statusCode === 200 && typeof id === 'string') resolve(id);
        else reject(new Error(`extension register failed: HTTP ${res.statusCode}`));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

function subscribe(runtimeApi: string, extensionId: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      schemaVersion: TEL_API,
      types: ['platform'],
      buffering: { maxItems: 1000, maxBytes: 256 * 1024, timeoutMs: 100 },
      destination: { protocol: 'HTTP', URI: `http://sandbox.localdomain:${port}` },
    });
    const req = http.request(
      `http://${runtimeApi}/${TEL_API}/telemetry`,
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Lambda-Extension-Identifier': extensionId,
        },
      },
      (res) => {
        res.resume();
        if (res.statusCode && res.statusCode < 300) resolve();
        else reject(new Error(`telemetry subscribe failed: HTTP ${res.statusCode}`));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

function startListener(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405).end();
        return;
      }
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c as Buffer));
      req.on('end', () => {
        try {
          const batch = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (Array.isArray(batch)) for (const event of batch) ingestTelemetryEvent(event);
        } catch (err) {
          diag.warn('lambda-otel: failed to parse telemetry batch', err);
        }
        res.writeHead(200).end();
      });
    });
    // A bind failure must reject startup (so we never subscribe to a dead
    // listener); a later runtime error is best-effort logged.
    server.once('error', reject);
    server.listen(port, () => {
      server.removeListener('error', reject);
      server.on('error', (err) => diag.warn('lambda-otel: telemetry listener error', err));
      // Don't let the listener keep the runtime alive on its own.
      server.unref();
      resolve();
    });
  });
}

async function nextLoop(runtimeApi: string, extensionId: string): Promise<void> {
  // The platform requires registered extensions to call /next to advance the
  // lifecycle. We immediately re-poll and do no work here, so we never gate the
  // freeze; the telemetry listener handles reports out of band.
  for (;;) {
    try {
      await getNext(runtimeApi, extensionId);
    } catch (err) {
      diag.warn('lambda-otel: extension event loop stopped', err);
      return;
    }
  }
}

function getNext(runtimeApi: string, extensionId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      `http://${runtimeApi}/${EXT_API}/extension/event/next`,
      { method: 'GET', headers: { 'Lambda-Extension-Identifier': extensionId } },
      (res) => {
        res.resume();
        res.on('end', () => {
          // Reject on a non-2xx so nextLoop stops instead of hot-spinning: /next
          // normally long-polls, so a fast error response (stale identifier,
          // teardown, throttling) would otherwise become a request storm.
          if (res.statusCode && res.statusCode < 300) resolve();
          else reject(new Error(`extension /next returned HTTP ${res.statusCode}`));
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}
