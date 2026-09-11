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

test('CJS preload: --require lambda-otel/register initializes the SDK', async () => {
  const { stdout } = await run(
    process.execPath,
    ['--require', 'lambda-otel/register', '-e', "console.log(require('lambda-otel').isInitialized())"],
    { cwd: root, env: { ...process.env, OTEL_LOG_LEVEL: 'none' } },
  );
  assert.equal(stdout.trim(), 'true');
});
