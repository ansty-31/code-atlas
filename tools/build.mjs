#!/usr/bin/env node
/**
 * Friendly CLI in front of Vite.
 *
 * Vite itself owns the pipeline (see the `zombie-atlas-data` plugin in
 * vite.config.ts): it bundles the app, generates `dist/data/**` after the
 * bundle is written, serves `/data/**` in dev and regenerates the bundle when
 * the decompiled tree changes. This script only turns convenient flags into the
 * environment variables that plugin reads, and prints what was resolved.
 *
 * Usage:
 *   node tools/build.mjs                 # bundle + data into dist/
 *   node tools/build.mjs --dev           # data + dev server (port 5183)
 *   node tools/build.mjs --skip-data     # UI-only build, reuse dist/data
 *   node tools/build.mjs --src /path/to/decompiled --pretty
 *   node tools/build.mjs --no-refs            # lean bundle: skip the reference layer
 *
 * Equivalent plain-Vite invocations (defaults only):
 *   npx vite build        npx vite
 */

import { parseCommonArgs, resolveDataOut, resolveSourceDir, SOURCE_ENV_VAR } from './lib/config.mjs';

const argv = process.argv.slice(2);
const { src: cliSrc, out: cliOut, languages: cliLanguages } = parseCommonArgs(argv);
const DEV = argv.includes('--dev');
const SKIP_DATA = argv.includes('--skip-data');
const PRETTY = argv.includes('--pretty');

// ---------------------------------------------------------------------------
// translate flags into the environment the Vite plugin reads
// ---------------------------------------------------------------------------
if (cliSrc) process.env.ATLAS_SRC = cliSrc;
if (cliOut) process.env.ATLAS_DATA_OUT = cliOut;
if (cliLanguages) process.env.ATLAS_LANGUAGES = cliLanguages;
if (SKIP_DATA) process.env.ZOMBIE_ATLAS_SKIP_DATA = '1';
if (PRETTY) process.env.ZOMBIE_ATLAS_PRETTY = '1';
if (argv.includes('--no-refs')) process.env.ZOMBIE_ATLAS_SKIP_REFS = '1';

if (!SKIP_DATA) {
  try {
    const source = resolveSourceDir(cliSrc);
    process.stdout.write(
      `[build] source: ${source.dir}${source.origin.startsWith('default') ? '' : `  (${source.origin})`}\n` +
        `[build]   mounted at /src/${source.mount}/ for the source viewer\n` +
        `[build] data:   ${resolveDataOut(cliOut)}\n`
    );
  } catch (err) {
    process.stderr.write(`\n[build] ${err.message}\n\n`);
    process.stderr.write(
      `Hint: set ${SOURCE_ENV_VAR} to the project source directory, e.g.\n` +
        `  ${SOURCE_ENV_VAR}=/path/to/project npm run build\n` +
        `or add the same line to a .env file next to package.json.\n`
    );
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// hand over to Vite
// ---------------------------------------------------------------------------
const vite = await import('vite');
const t0 = Date.now();

if (DEV) {
  const server = await vite.createServer();
  await server.listen();
  server.printUrls();
} else {
  await vite.build();
  process.stdout.write(`[build] done in ${Date.now() - t0}ms\n`);
}
