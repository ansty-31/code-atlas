#!/usr/bin/env node
/**
 * Minimal production server for Zombie Atlas.
 *
 *  - serves the built SPA from ./dist
 *  - maps /src/zombie/** onto the decompiled tree in the repository, so the
 *    source viewer always reads the exact files the dataset came from
 *  - gzips JSON/JS/CSS on the fly and caches the compressed form in memory
 *
 * Usage: node tools/serve.mjs [--port 5184] [--host 127.0.0.1]
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { LANGUAGES } from '../src/shared/languages.mjs';
import { parseCommonArgs, resolveSourceDir, SOURCE_ENV_VAR } from './lib/config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const DIST = path.join(APP, 'dist');

// The raw tree is served read-only at /src/<mount>/... for the source viewer.
// It may live anywhere; ZOMBIE_SRC / --src decide where.
const { src: cliSrc } = parseCommonArgs();
let SOURCE = null;
try {
  SOURCE = resolveSourceDir(cliSrc);
} catch (err) {
  process.stderr.write(`[serve] source tree unavailable: ${err.message.split('\n')[0]}\n`);
  process.stderr.write(`[serve] "View source" will be disabled; set ${SOURCE_ENV_VAR} to enable it.\n`);
}

const argv = process.argv.slice(2);
const argVal = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
let PORT = Number(argVal('--port', process.env.PORT ?? 5184));
const HOST = argVal('--host', '127.0.0.1');
const EXPLICIT_PORT = argv.includes('--port') || process.env.PORT !== undefined;
if (!Number.isInteger(PORT) || PORT < 0 || PORT > 65535) {
  process.stderr.write('[serve] Invalid port; use --port with a number between 0 and 65535.\n');
  process.exit(1);
}

const metaPath = path.join(DIST, 'data', 'meta.json');
if (SOURCE && fs.existsSync(metaPath)) {
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  if (meta.sourceRootAbs && path.resolve(meta.sourceRootAbs) !== SOURCE.dir) {
    const quoted = `'${SOURCE.dir.replace(/'/g, "'\\''")}'`;
    process.stderr.write(
      `[serve] The existing data was built for a different source directory.\n` +
      `Rebuild for this project first:\n  npm run build -- --src ${quoted}\n` +
      `Then run:\n  npm run serve -- --src ${quoted}\n`
    );
    process.exit(1);
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  ...Object.fromEntries(LANGUAGES.flatMap((language) => language.extensions).map((ext) => [ext, 'text/plain; charset=utf-8'])),
  '.map': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

const gzipCache = new Map();

function send(req, res, abs, status = 200) {
  const ext = path.extname(abs).toLowerCase();
  const type = MIME[ext] ?? 'application/octet-stream';
  const compressible = /^(text|application\/(json|javascript))/.test(type);
  const acceptsGzip = /\bgzip\b/.test(req.headers['accept-encoding'] ?? '');

  if (compressible && acceptsGzip) {
    // The key must include mtime+size: a rebuild replaces asset contents under
    // the same path, and a stale cached body would make the browser request an
    // asset that no longer exists.
    let st = null;
    try {
      st = fs.statSync(abs);
    } catch {
      st = null;
    }
    const key = st ? `${abs}:${status}:${st.mtimeMs}:${st.size}` : null;
    let buf = key ? gzipCache.get(key) : null;
    if (!buf) {
      try {
        buf = zlib.gzipSync(fs.readFileSync(abs), { level: 6 });
        if (key && gzipCache.size < 300) gzipCache.set(key, buf);
      } catch {
        buf = null;
      }
    }
    if (buf) {
      res.writeHead(status, { 'content-type': type, 'content-encoding': 'gzip', 'cache-control': 'no-cache' });
      return res.end(buf);
    }
  }
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-cache' });
  fs.createReadStream(abs)
    .on('error', () => {
      res.statusCode = 500;
      res.end('read error');
    })
    .pipe(res);
}

const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url ?? '/').split('?')[0]);

  // ---- raw source tree
  const mount = SOURCE?.mount ?? 'zombie';
  if (url.startsWith('/src/')) {
    // Never let a source request fall through to the SPA fallback: an HTML body
    // where a .java file was expected is far more confusing than a 404.
    if (!SOURCE) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end(`No source tree configured. Set ${SOURCE_ENV_VAR} and restart the server.\n`);
    }
    if (!url.startsWith(`/src/${mount}/`)) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end(`Unknown source mount. This build serves /src/${mount}/**.\n`);
    }
  }
  if (SOURCE && url.startsWith(`/src/${mount}/`)) {
    const abs = path.resolve(SOURCE.dir, url.slice(`/src/${mount}/`.length));
    if (!abs.startsWith(SOURCE.dir + path.sep)) {
      res.writeHead(403);
      return res.end('forbidden');
    }
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      res.writeHead(404);
      return res.end('not found');
    }
    return send(req, res, abs);
  }

  if (!fs.existsSync(DIST)) {
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('dist/ not found — run "npm run build" first.\n');
  }
  if (!fs.existsSync(path.join(DIST, 'data'))) {
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('dist/data/ missing — rebuild with "npm run build" so the bundle is regenerated.\n');
  }

  // ---- static assets
  let rel = url === '/' ? '/index.html' : url;
  let abs = path.join(DIST, rel);
  if (!abs.startsWith(DIST)) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
    // SPA fallback (the app keeps all state in the hash, so index.html is right)
    abs = path.join(DIST, 'index.html');
    if (!fs.existsSync(abs)) {
      res.writeHead(404);
      return res.end('not found');
    }
    return send(req, res, abs);
  }
  send(req, res, abs);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE' && !EXPLICIT_PORT && PORT < 65535) {
    process.stderr.write(`[serve] Port ${PORT} is already in use; trying ${PORT + 1}.\n`);
    PORT++;
    server.listen(PORT, HOST);
    return;
  }
  const message = err.code === 'EADDRINUSE'
    ? `Port ${PORT} is already in use. Stop the other server or use --port ${PORT < 65535 ? PORT + 1 : 5184}.`
    : `Could not listen on ${HOST}:${PORT}: ${err.message}`;
  process.stderr.write(`[serve] ${message}\n`);
  process.exitCode = 1;
});

server.listen(PORT, HOST, () => {
  PORT = server.address().port;
  const size = fs.existsSync(path.join(DIST, 'data'))
    ? fs.readdirSync(path.join(DIST, 'data')).length
    : 0;
  process.stdout.write(
    `Code Atlas\n  app     http://${HOST}:${PORT}/\n  data    ${path.join(DIST, 'data')} (${size} files)\n` +
      `  sources ${SOURCE ? `${SOURCE.dir}  ->  /src/${SOURCE.mount}/` : 'not found (set ' + SOURCE_ENV_VAR + ')'}\n`
  );
});
