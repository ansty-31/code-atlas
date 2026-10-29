/**
 * Shared browser and server plumbing for the Zombie Atlas test suite.
 *
 * One server and one browser are shared by every spec; each spec gets its own
 * browser context, so specs cannot leak state into each other and can still
 * start quickly.
 *
 * The module is deliberately free of any assertion or reporting logic — see
 * `kit.mjs` for that, and `runner.mjs` for the entry point.
 */

import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The `zombie-atlas/` application root. */
export const APP = path.resolve(HERE, '..', '..');
export const SHOTS = path.join(APP, '.pw-shots');

/**
 * Only used when nothing else decides the port. Each runner normally picks its
 * own free port so concurrent runs (or a run next to a dev server) never fight
 * over one server — and never lose it because another runner exited and tore
 * down the process it had spawned.
 */
export const DEFAULT_PORT = process.env.ATLAS_TEST_PORT ? Number(process.env.ATLAS_TEST_PORT) : null;
export const DEFAULT_URL = DEFAULT_PORT ? `http://127.0.0.1:${DEFAULT_PORT}/` : null;
export const DEFAULT_VIEWPORT = { width: 1680, height: 1000 };

// ---------------------------------------------------------------------------
// Browser plumbing.
//
// Chromium and its shared libraries may live inside the project (they do in
// sandboxes without a system browser): point Playwright at them before it is
// imported, so the suite works without wrapping the command in `tools/pw.sh`.
// ---------------------------------------------------------------------------
const LOCAL_BROWSERS = path.join(APP, '.pw-browsers');
if (!process.env.PLAYWRIGHT_BROWSERS_PATH && fs.existsSync(LOCAL_BROWSERS)) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = LOCAL_BROWSERS;
}
const LOCAL_LIBS = path.join(APP, '.pw-libs', 'root', 'usr', 'lib', 'x86_64-linux-gnu');
if (fs.existsSync(LOCAL_LIBS) && !(process.env.LD_LIBRARY_PATH ?? '').includes(LOCAL_LIBS)) {
  process.env.LD_LIBRARY_PATH = `${LOCAL_LIBS}${process.env.LD_LIBRARY_PATH ? `:${process.env.LD_LIBRARY_PATH}` : ''}`;
}

export async function launchBrowser() {
  const { chromium } = await import('playwright');
  return chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
}

// ---------------------------------------------------------------------------
// Server.
// ---------------------------------------------------------------------------

let server = null;

async function probe(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Ask the OS for a free port. */
async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Serve the built app for this run and return its URL.
 *
 * When `port` is omitted the runner picks a free one, so several runners can
 * execute side by side: each owns the server it spawned and only tears that one
 * down. Reusing somebody else's server would mean losing it the moment they
 * exit.
 *
 * Passing an explicit `port` (via `--port` or `ATLAS_TEST_PORT`) opts into
 * sharing: a server already listening there is borrowed and left running.
 */
export async function startServer({ port = null } = {}) {
  const chosen = port ?? (await freePort());
  const url = `http://127.0.0.1:${chosen}/`;

  if (await probe(url)) return { reused: true, url, port: chosen };

  server = spawn(process.execPath, [path.join(HERE, '..', 'serve.mjs'), '--port', String(chosen)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const deadline = Date.now() + 15000;
  while (!(await probe(url))) {
    if (Date.now() > deadline) {
      stopServer();
      throw new Error(`server did not start on ${url}`);
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return { reused: false, url, port: chosen };
}

export function stopServer() {
  if (server && !server.killed) server.kill('SIGTERM');
  server = null;
}

// ---------------------------------------------------------------------------
// Pages.
// ---------------------------------------------------------------------------

/**
 * Open the application in a fresh context.
 *
 * Console errors, page errors and failed requests are collected per page and
 * exposed as `errors`, so a spec can assert "nothing went wrong" for exactly
 * the window of interactions it owns.
 *
 * `waitForData: false` is for the degraded paths (no dataset, denied storage)
 * where `boot()` returns early and never publishes the debug handle.
 */
export async function openApp(browser, opts = {}) {
  const {
    url = DEFAULT_URL,
    locale = 'en-US',
    viewport = DEFAULT_VIEWPORT,
    search = '',
    hash = '',
    waitForData = true,
    route = null,
  } = opts;

  const context = await browser.newContext({ locale, viewport, deviceScaleFactor: 1 });
  if (route) await route(context);
  if (!url) {
    throw new Error('openApp() needs a url — take one from startServer(), or from `t.url` inside a spec');
  }

  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => errors.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));

  await page.goto(`${url}${search}${hash}`, { waitUntil: 'networkidle' });

  if (waitForData) {
    await page.waitForFunction(() => !!window.zombieAtlas, null, { timeout: 20000 });
    await page.waitForTimeout(600);
  }

  return {
    context,
    page,
    errors,
    url,
    /** Drop the context. Extra pages created by a spec must be closed this way. */
    close: () => context.close(),
  };
}

process.on('exit', stopServer);
process.on('SIGINT', () => {
  stopServer();
  process.exit(130);
});
