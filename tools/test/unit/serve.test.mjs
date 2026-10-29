import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const metaPath = path.join(app, 'dist/data/meta.json');
const source = fs.existsSync(metaPath)
  ? JSON.parse(fs.readFileSync(metaPath, 'utf8')).sourceRootAbs
  : path.join(app, 'tools/test/fixtures/mixed');

async function occupiedPort(t, port) {
  const server = net.createServer();
  server.listen(port, '127.0.0.1');
  try {
    await once(server, 'listening');
  } catch (err) {
    if (port === 5184 && err.code === 'EADDRINUSE') return port;
    throw err;
  }
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return server.address().port;
}

function start(t, args, cwd = app) {
  const env = { ...process.env };
  delete env.PORT;
  const child = spawn(process.execPath, ['tools/serve.mjs', '--src', source, ...args], {
    cwd, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (data) => { output += data; });
  child.stderr.on('data', (data) => { output += data; });
  const closed = once(child, 'close');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
  });
  return { child, closed, output: () => output };
}

test('an occupied default port falls back without an unhandled exception', async (t) => {
  await occupiedPort(t, 5184);
  const server = start(t, []);
  const deadline = Date.now() + 5000;
  while (!server.output().includes('  app ') && server.child.exitCode === null && Date.now() < deadline) await delay(20);
  assert.match(server.output(), /trying 5185/i);
  assert.match(server.output(), /app\s+http:\/\/127\.0\.0\.1:(\d+)\//);
  const port = Number(server.output().match(/app\s+http:\/\/127\.0\.0\.1:(\d+)\//)[1]);
  assert.ok(port > 5184);
  assert.doesNotMatch(server.output(), /Unhandled|throw er;/);
});

test('an explicitly occupied port reports a useful error and exits cleanly', async (t) => {
  const port = await occupiedPort(t, 0);
  const server = start(t, ['--port', String(port)]);
  const [code] = await server.closed;
  assert.equal(code, 1);
  assert.match(server.output(), /already in use/i);
  assert.match(server.output(), /--port/);
  assert.doesNotMatch(server.output(), /Unhandled|throw er;/);
});

test('a different source directory asks for a rebuild before serving stale data', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-serve-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const file of ['tools/serve.mjs', 'tools/lib/config.mjs', 'src/shared/languages.mjs']) {
    const target = path.join(directory, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(app, file), target);
  }
  fs.mkdirSync(path.join(directory, 'dist/data'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'dist/data/meta.json'), JSON.stringify({ sourceRootAbs: '/different-project' }));
  const server = start(t, ['--port', '0'], directory);
  const [code] = await server.closed;
  assert.equal(code, 1);
  assert.match(server.output(), /different source directory/);
  assert.match(server.output(), /npm run build -- --src/);
  assert.doesNotMatch(server.output(), /Unhandled|throw er;/);
});
