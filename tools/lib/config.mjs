/**
 * Shared configuration for the atlas tooling.
 *
 * Where the decompiled source lives and where the generated bundle goes are
 * both configurable, because `zombie/` is a build artefact of the game that is
 * gitignored and may sit anywhere on disk.
 *
 * Source directory precedence (first hit wins):
 *   1. `--src <dir>` on the command line
 *   2. the `ZOMBIE_SRC` environment variable
 *   3. `ZOMBIE_SRC` in a `.env` file (app directory, then repository root)
 *   4. `<repository root>/zombie`
 *   5. `./zombie` relative to the current working directory
 *
 * Relative paths are resolved against the current working directory first and
 * against the repository root as a fallback, so both `ZOMBIE_SRC=zombie` and
 * `ZOMBIE_SRC=../zombie` work when run through npm scripts.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const REPO_ROOT = path.resolve(APP_DIR, '..');

/** Build output directory. */
export const DIST_DIR = path.join(APP_DIR, 'dist');

/**
 * Where the extractor writes: inside the build output, served as /data/** by
 * both the dev server and the production server. There is deliberately no
 * staging copy — the bundle lives in exactly one place.
 */
export const DEFAULT_DATA_DIR = path.join(DIST_DIR, 'data');

export const SOURCE_ENV_VAR = 'ATLAS_SRC';
export const OUT_ENV_VAR = 'ATLAS_DATA_OUT';

/** Minimal .env reader (KEY=VALUE, # comments, optional quotes). */
export function readDotEnv(dir) {
  const out = {};
  const file = path.join(dir, '.env');
  if (!fs.existsSync(file)) return out;
  for (const rawLine of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function envValue(name) {
  if (process.env[name]) return { value: process.env[name], from: name };
  for (const dir of [APP_DIR, REPO_ROOT]) {
    const dotenv = readDotEnv(dir);
    if (dotenv[name]) return { value: dotenv[name], from: `${name} in ${path.join(dir, '.env')}` };
  }
  return null;
}

const isDir = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** Resolve a possibly-relative path against CWD, then the repository root. */
function resolveAnywhere(value) {
  const attempts = [path.resolve(process.cwd(), value), path.resolve(REPO_ROOT, value)];
  for (const p of attempts) if (isDir(p)) return p;
  return attempts[0];
}

/**
 * @param {string|undefined} cliSrc value of `--src`
 * @returns {{dir: string, mount: string, display: string, origin: string}}
 */
export function resolveSourceDir(cliSrc) {
  const tried = [];
  const consider = (dir, origin) => {
    tried.push(`${dir}  (${origin})`);
    return isDir(dir) ? { dir, origin } : null;
  };

  let found = null;
  let explicit = null; // set when the user named a directory themselves

  if (cliSrc) {
    explicit = { dir: resolveAnywhere(cliSrc), origin: '--src' };
  } else {
    const env = envValue(SOURCE_ENV_VAR) ?? envValue('ZOMBIE_SRC');
    if (env) explicit = { dir: resolveAnywhere(env.value), origin: env.from };
  }

  if (explicit) {
    // An explicit setting is a contract: never silently fall back to a default,
    // otherwise a typo would look like it worked.
    const ok = consider(explicit.dir, explicit.origin);
    if (!ok) {
      throw new Error(
        `${explicit.origin} points at "${explicit.dir}", which is not a directory.\n` +
          `Give the path to the project source directory.`
      );
    }
    found = ok;
  }

  if (!found) found = consider(path.join(REPO_ROOT, 'zombie'), 'default <repo>/zombie');
  if (!found) found = consider(path.join(process.cwd(), 'zombie'), 'default ./zombie');

  if (!found) {
    throw new Error(
      `No source directory found. Point ${SOURCE_ENV_VAR} (or --src) at your project, e.g.\n` +
        `  ${SOURCE_ENV_VAR}=/path/to/decompiled ${'npm run build'}\n` +
        `Tried:\n  ${tried.join('\n  ')}`
    );
  }

  const dir = found.dir;
  // The last path segment doubles as the URL mount for the source viewer
  // (/src/<mount>/...), so it must be URL-safe.
  const mount = path.basename(dir).replace(/[^A-Za-z0-9._-]/g, '_') || 'src';
  const rel = path.relative(REPO_ROOT, dir);
  const display = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : dir;
  return { dir, mount, display, origin: found.origin };
}

/** Directory the extractor writes into (defaults to dist/data). */
export function resolveDataOut(cliOut) {
  if (cliOut) return path.resolve(process.cwd(), cliOut);
  const env = envValue(OUT_ENV_VAR) ?? envValue('ZOMBIE_DATA_OUT');
  if (env) return path.resolve(APP_DIR, env.value);
  return DEFAULT_DATA_DIR;
}

/** Shared CLI parsing: `--src <dir>` / `--out <dir>` on any tool. */
export function parseCommonArgs(argv = process.argv.slice(2)) {
  const take = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : undefined;
  };
  return { src: take('--src'), out: take('--out'), languages: take('--languages') };
}

/** Language selection shared by the CLI and Vite (including .env). */
export function resolveLanguages(cliValue) {
  return cliValue ?? envValue('ATLAS_LANGUAGES')?.value ?? 'auto';
}
