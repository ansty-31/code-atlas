import { defineConfig, type Plugin, type ViteDevServer } from 'vite';
import solid from 'vite-plugin-solid';
import fs from 'node:fs';
import path from 'node:path';
// @ts-expect-error - plain JS helper shared with the CLI tools
import { resolveSourceDir, resolveDataOut } from './tools/lib/config.mjs';

const MIME: Record<string, string> = {
  '.json': 'application/json; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

const flag = (name: string) => process.env[name] === '1' || process.env[name] === 'true';

import { LANGUAGES, languageForPath, IGNORED_DIRS } from './src/shared/languages.mjs';
// @ts-expect-error - plain JS module shared with the extractor
import { grammarAsset } from './tools/lib/parsers.mjs';

/**
 * Serve the parser runtime and the Java grammar to the browser.
 *
 * The source viewer colourises a file with the same grammar that extracted the
 * bundle, in a lazy chunk: these two files are fetched the first time a viewer
 * opens, and nothing else in the app depends on them.
 */
function parserAssetsPlugin(): Plugin {
  // Only the grammar: the runtime is bundled by Vite, which already emits its
  // wasm next to the chunk and lets `Parser.init()` find it.
  const assets = (): { name: string; file: string }[] => LANGUAGES.map(grammarAsset);
  return {
    name: 'zombie-atlas-parser-assets',
    configureServer(server: ViteDevServer) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? '').split('?')[0];
        if (!url.startsWith('/ts/')) return next();
        const asset = assets().find((a) => url === `/ts/${a.name}`);
        if (!asset) {
          res.statusCode = 404;
          return res.end('not found');
        }
        res.setHeader('content-type', 'application/wasm');
        fs.createReadStream(asset.file).pipe(res);
      });
    },
    generateBundle() {
      for (const asset of assets()) {
        this.emitFile({ type: 'asset', fileName: `ts/${asset.name}`, source: fs.readFileSync(asset.file) });
      }
    },
  };
}

/**
 * Owns the generated JSON bundle.
 *
 * Vite decides *when* the artefacts are produced, so one tool drives the whole
 * pipeline and there is no orchestrator to keep in sync:
 *
 *   build  → `closeBundle` writes `dist/data/**` after the app has been emitted
 *            (and after `emptyOutDir`, so the data can never be clobbered)
 *   dev    → generated once on startup, then regenerated whenever a `.java`
 *            file changes, followed by a browser reload
 *
 * Both modes read and write the same directory, so the app never sees two
 * copies of the data.
 */
function atlasDataPlugin(): Plugin {
  let isBuild = false;
  let dataDir = resolveDataOut() as string;
  let source: { dir: string; mount: string; display: string; origin: string } | null = null;
  let sourceError: string | null = null;

  try {
    source = resolveSourceDir();
  } catch (err) {
    sourceError = (err as Error).message;
  }

  const enabled = !flag('ZOMBIE_ATLAS_SKIP_DATA');

  /** Run the extractor; returns true when the bundle was written. */
  const generate = async (reason: string): Promise<boolean> => {
    if (!enabled) {
      console.log(`[atlas] data: skipped (ZOMBIE_ATLAS_SKIP_DATA) — reusing ${path.relative(process.cwd(), dataDir)}`);
      return false;
    }
    if (!source) {
      // A missing tree is only fatal for a real build; in dev the app still
      // boots and reports the problem in the UI.
      const message = `[atlas] no source tree: ${sourceError}`;
      if (isBuild) throw new Error(message);
      console.warn(message);
      return false;
    }
    const started = Date.now();
    // @ts-expect-error - plain JS module without type declarations
    const { runExtraction } = await import('./tools/extract.mjs');
    const result = await runExtraction({
      src: source.dir,
      out: dataDir,
      quiet: true,
      pretty: flag('ZOMBIE_ATLAS_PRETTY'),
    });
    console.log(
      `[atlas] data: ${result.types} types from ${result.files} files (${result.parser}) → ` +
        `${path.relative(process.cwd(), result.out)}${reason ? `  (${reason})` : ''}  ${Date.now() - started}ms`
    );
    return true;
  };

  return {
    name: 'zombie-atlas-data',
    // Run after Vite's own plugins have settled the output layout.
    enforce: 'post',

    configResolved(config) {
      isBuild = config.command === 'build';
      dataDir = resolveDataOut();
    },

    async closeBundle() {
      // Runs after the bundle is written, so `emptyOutDir` has already happened.
      if (!isBuild) return;
      await generate('build');
    },

    configureServer(server: ViteDevServer) {
      // 1. the generated bundle itself, served from the same place as production
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? '').split('?')[0];
        if (!url.startsWith('/data/')) return next();
        const abs = path.join(dataDir, url.slice('/data/'.length));
        if (!abs.startsWith(dataDir)) {
          res.statusCode = 403;
          return res.end('forbidden');
        }
        fs.readFile(abs, (err, buf) => {
          if (err) {
            res.statusCode = 404;
            res.setHeader('content-type', 'text/plain; charset=utf-8');
            return res.end(`No bundle at ${abs}.\nRun "npm run data" (or "npm run build") to generate it.\n`);
          }
          res.setHeader('content-type', MIME[path.extname(abs)] ?? 'application/octet-stream');
          res.end(buf);
        });
      });

      // 2. the raw tree, for the source viewer
      if (!source) return;
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? '').split('?')[0];
        if (!url.startsWith(`/src/${source!.mount}/`)) return next();
        // `<mount>/<path inside the tree>` resolved against the parent of the
        // configured source dir, so a tree anywhere on disk is served correctly.
        const rel = decodeURIComponent(url.slice(`/src/${source!.mount}/`.length));
        const abs = path.resolve(source!.dir, rel);
        if (abs !== source!.dir && !abs.startsWith(source!.dir + path.sep)) {
          res.statusCode = 403;
          return res.end('forbidden');
        }
        fs.readFile(abs, (err, buf) => {
          if (err) {
            res.statusCode = 404;
            return res.end('not found');
          }
          res.setHeader('content-type', 'text/plain; charset=utf-8');
          res.end(buf);
        });
      });

      // 3. regenerate when the decompiled tree changes on disk
      if (!enabled || !source) return;
      server.watcher.add(source.dir);
      let timer: NodeJS.Timeout | undefined;
      let running = false;
      const onChange = (file: string) => {
        if (!languageForPath(file) || path.relative(source!.dir, file).split(path.sep).some((part) => IGNORED_DIRS.has(part))) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(async () => {
          if (running) return;
          running = true;
          try {
            if (await generate('source changed')) {
              server.ws.send({ type: 'full-reload' });
            }
          } catch (err) {
            console.error(`[atlas] regeneration failed: ${(err as Error).message}`);
          } finally {
            running = false;
          }
        }, 400);
      };
      server.watcher.on('change', onChange);
      server.watcher.on('add', onChange);
      server.watcher.on('unlink', onChange);

      // generate once the server is up, so startup is not blocked by parsing
      server.httpServer?.once('listening', () => {
        void generate('dev startup');
      });
    },
  };
}

export default defineConfig({
  base: './',
  // Nothing is copied into dist/: the app is bundled and the data is written
  // into dist/data by the plugin above.
  publicDir: false,
  plugins: [solid(), atlasDataPlugin(), parserAssetsPlugin()],
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1600,
  },
  server: { port: 5183, open: false },
});
