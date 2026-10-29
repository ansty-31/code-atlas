#!/usr/bin/env node
/**
 * Zombie Atlas test runner.
 *
 * Discovers `specs/*.spec.mjs`, boots one browser and one server, and runs each
 * spec in its own browser context. A spec that throws is reported and the run
 * continues, so one broken area never hides the results of the others.
 *
 * Usage:
 *   node tools/test/runner.mjs                 # everything
 *   node tools/test/runner.mjs --spec treemap  # specs whose filename matches
 *   node tools/test/runner.mjs --shots         # also write .pw-shots/*.png
 *   node tools/test/runner.mjs --bail          # stop at the first failing spec
 *   node tools/test/runner.mjs --list          # list discovered specs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_PORT,
  SHOTS,
  launchBrowser,
  startServer,
  stopServer,
} from './harness.mjs';
import { createRecorder, createTestContext } from './kit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SPEC_DIR = path.join(HERE, 'specs');

function parseArgs(argv) {
  const opts = { shots: false, bail: false, list: false, port: DEFAULT_PORT, url: null, spec: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--shots') opts.shots = true;
    else if (arg === '--bail') opts.bail = true;
    else if (arg === '--list') opts.list = true;
    else if (arg === '--port') opts.port = Number(argv[++i]);
    else if (arg === '--src') opts.src = argv[++i];
    else if (arg === '--url') opts.url = argv[++i];
    else if (arg === '--spec') opts.spec.push(argv[++i]);
    else {
      console.error(`unknown option: ${arg} (try --help)`);
      process.exit(2);
    }
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));

const all = fs.readdirSync(SPEC_DIR).filter((f) => f.endsWith('.spec.mjs')).sort();
const files = opts.spec.length ? all.filter((f) => opts.spec.some((s) => f.includes(s))) : all;

if (opts.list) {
  for (const f of all) console.log(f.replace(/\.spec\.mjs$/, ''));
  process.exit(0);
}
if (!files.length) {
  console.error(opts.spec.length ? `no spec matched: ${opts.spec.join(', ')}` : 'no specs found');
  process.exit(2);
}

const recorder = createRecorder({
  onResult(result) {
    // TODO  = a known defect, documented and expected to fail
    // XPASS = a TODO that started passing; promote it to a real test
    const mark = result.todo
      ? result.ok
        ? 'XPASS'
        : 'TODO '
      : result.ok
        ? 'PASS '
        : 'FAIL ';
    console.log(`  ${mark}  ${result.name}${result.detail ? `  — ${result.detail}` : ''}`);
  },
});

const started = Date.now();
// `--url` means "test this deployment", so a local server must not be started:
// on a checkout without a usable `dist/` the local probe never succeeds and the
// run aborts after the timeout, never reaching the URL that was asked for.
if (opts.src) process.env.ATLAS_SRC = opts.src;
const server = opts.url ? null : await startServer({ port: opts.port });
const url = server?.url ?? opts.url;
const origin = server ? (server.reused ? ' (existing server)' : '') : ' (external url)';
console.log(`zombie-atlas tests · ${url}${origin} · ${files.length} specs`);
if (!opts.shots) console.log('(screenshots off — pass --shots to write .pw-shots/)');

const browser = await launchBrowser();

try {
  for (const file of files) {
    const spec = (await import(path.join(SPEC_DIR, file))).default;
    if (!spec?.run) {
      recorder.add({ spec: file, name: '(load)', ok: false, detail: 'spec has no default export with a run()', ms: 0 });
      continue;
    }
    console.log(`\n▸ ${spec.name}`);
    const context = await createTestContext({
      browser,
      spec,
      url,
      shots: { enabled: opts.shots, dir: SHOTS },
      recorder,
    });
    const specStarted = Date.now();
    try {
      await spec.run(context);
    } catch (err) {
      recorder.add({
        spec: spec.name,
        name: '(spec aborted)',
        ok: false,
        detail: err?.message ?? String(err),
        ms: Date.now() - specStarted,
      });
    } finally {
      await context.dispose();
    }

    if (opts.bail && recorder.failures().length) {
      console.log('\n--bail: stopping after the first failing spec');
      break;
    }
  }
} finally {
  await browser.close();
  stopServer();
}

const failures = recorder.failures();
const passed = recorder.passed();
const total = recorder.results.length;
const todos = recorder.todos().filter((r) => !r.ok);
const seconds = ((Date.now() - started) / 1000).toFixed(1);

console.log(`\n=== zombie-atlas: ${passed}/${total} tests passed in ${seconds}s ===`);
if (todos.length) {
  console.log(`\n${todos.length} known defect(s) documented as TODO:`);
  for (const d of todos) console.log(` - ${d.spec} › ${d.name} — ${d.detail}`);
}
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log(` - ${f.spec} › ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
  process.exit(1);
}
