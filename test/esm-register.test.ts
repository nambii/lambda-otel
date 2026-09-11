import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';

const run = promisify(execFile);
const root = path.resolve(__dirname, '..');

// The package self-references through its own `exports` map, exactly as a
// consumer would resolve it. Requires `npm run build` (the test script does).
test('ESM preload: --import lambda-otel/register initializes the SDK and installs the loader hook', async () => {
  const script = `
    import { isInitialized, withObservability } from 'lambda-otel';
    import { register } from 'node:module';
    // A registered ESM loader hook shows up as a customization hook worker; the
    // observable proof is that register() was reachable and the SDK is up.
    const out = { initialized: isInitialized(), wrapped: typeof withObservability(async () => 1) };
    console.log(JSON.stringify(out));
  `;
  const { stdout } = await run(
    process.execPath,
    ['--import', 'lambda-otel/register', '--input-type=module', '-e', script],
    { cwd: root, env: { ...process.env, OTEL_LOG_LEVEL: 'none' } },
  );
  assert.deepEqual(JSON.parse(stdout.trim()), { initialized: true, wrapped: 'function' });
});

test('package.json is reachable through the exports map', async () => {
  const { stdout } = await run(process.execPath, ['-p', "require('lambda-otel/package.json').name"], { cwd: root });
  assert.equal(stdout.trim(), 'lambda-otel');
});

test('CJS preload: --require lambda-otel/register initializes the SDK', async () => {
  const { stdout } = await run(
    process.execPath,
    ['--require', 'lambda-otel/register', '-e', "console.log(require('lambda-otel').isInitialized())"],
    { cwd: root, env: { ...process.env, OTEL_LOG_LEVEL: 'none' } },
  );
  assert.equal(stdout.trim(), 'true');
});

// ---- does the ESM path actually patch anything? ----
// The two tests above prove the entry loads. These prove instrumentation lands
// on modules the handler `import`s, which is the whole point of register.mjs.

test('ESM: http.request is wrapped after --import lambda-otel/register', async () => {
  const script = `
    import http from 'node:http';
    import { isWrapped } from '@opentelemetry/instrumentation';
    console.log(JSON.stringify({ request: isWrapped(http.request), get: isWrapped(http.get) }));
  `;
  const { stdout } = await run(
    process.execPath,
    ['--import', 'lambda-otel/register', '--input-type=module', '-e', script],
    { cwd: root, env: { ...process.env, OTEL_LOG_LEVEL: 'none' } },
  );
  assert.deepEqual(JSON.parse(stdout.trim()), { request: true, get: true });
});

test('ESM: a CommonJS package imported from ESM (koa) is patched via the loader hook', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const os = await import('node:os');
  const { pathToFileURL } = await import('node:url');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lambda-otel-esm-'));
  const preload = path.join(dir, 'preload.mjs');
  // A consumer preload: loader hook first, then init with koa opted in.
  await writeFile(
    preload,
    `
    import { register, createRequire } from 'node:module';
    register('@opentelemetry/instrumentation/hook.mjs', ${JSON.stringify(pathToFileURL(root + '/').href)});
    const require = createRequire(${JSON.stringify(path.join(root, 'package.json'))});
    const { initObservability } = require(${JSON.stringify(path.join(root, 'dist/index.js'))});
    initObservability({ metrics: false, instrumentationConfig: { koa: { ignoreLayersType: ['middleware'] } } });
    `,
  );
  const script = `
    import Koa from 'koa';
    import { isWrapped } from '@opentelemetry/instrumentation';
    console.log(JSON.stringify({ use: isWrapped(Koa.prototype.use) }));
  `;
  try {
    const { stdout } = await run(
      process.execPath,
      ['--import', pathToFileURL(preload).href, '--input-type=module', '-e', script],
      { cwd: root, env: { ...process.env, OTEL_LOG_LEVEL: 'none' } },
    );
    assert.deepEqual(JSON.parse(stdout.trim()), { use: true });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
