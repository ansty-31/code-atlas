#!/usr/bin/env node
/**
 * Zombie Atlas — showcase trailer recorder.
 *
 * Drives the running app with *real* mouse and keyboard input (the same events
 * a person would generate) and records the page viewport — never the desktop —
 * so the resulting video contains the application and nothing else.
 *
 * What it does:
 *   1. launches headless Chromium with a 1920x1080 viewport and `recordVideo`
 *      pointed at that exact size (viewport capture, not screen capture);
 *   2. injects a synthetic pointer + click ripple, because a headless browser
 *      has no OS cursor to film, plus the intro/outro title cards;
 *   3. walks a scripted storyboard over every view and the primary controls;
 *   4. writes screenshots of the checkpoints to `.pw-video/frames/` so the run
 *      can be eyeballed without decoding the video;
 *   5. optionally trims the load-time lead-in and transcodes the raw WebM/VP8
 *      to H.264 MP4 (30 fps, yuv420p, faststart) when an ffmpeg is available.
 *
 * Usage:
 *   sh tools/pw.sh node tools/trailer.mjs [options]
 *
 *   --url <url>        page to film           (default http://127.0.0.1:5184/#v=treemap)
 *   --out <dir>        output directory       (default .pw-video)
 *   --width/--height   capture size           (default 1920x1080)
 *   --no-cursor        do not draw the synthetic pointer
 *   --no-cards         do not draw the intro/outro title cards
 *   --no-encode        keep the raw .webm only
 *   --trim <seconds>   override the automatic lead-in trim
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');

// Chromium and its shared libraries may live inside the project (they do in
// sandboxes without a system browser) — the same plumbing as tools/test/harness.mjs.
const LOCAL_BROWSERS = path.join(APP, '.pw-browsers');
if (!process.env.PLAYWRIGHT_BROWSERS_PATH && fs.existsSync(LOCAL_BROWSERS)) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = LOCAL_BROWSERS;
}
const LOCAL_LIBS = path.join(APP, '.pw-libs', 'root', 'usr', 'lib', 'x86_64-linux-gnu');
if (fs.existsSync(LOCAL_LIBS) && !(process.env.LD_LIBRARY_PATH ?? '').includes(LOCAL_LIBS)) {
  process.env.LD_LIBRARY_PATH = `${LOCAL_LIBS}${process.env.LD_LIBRARY_PATH ? `:${process.env.LD_LIBRARY_PATH}` : ''}`;
}

const { chromium } = await import('playwright');

/** ------------------------------------------------------------- options -- */

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};
const has = (name) => argv.includes(`--${name}`);

const URL_ = opt('url', 'http://127.0.0.1:5184/#v=treemap');
const W = Number(opt('width', 1920));
const H = Number(opt('height', 1080));
const OUT = path.resolve(APP, opt('out', '.pw-video'));
const RAW = path.join(OUT, 'raw');
const FRAMES = path.join(OUT, 'frames');
const USE_CURSOR = !has('no-cursor');
const USE_CARDS = !has('no-cards');
const ENCODE = !has('no-encode');

fs.rmSync(RAW, { recursive: true, force: true });
fs.mkdirSync(RAW, { recursive: true });
fs.mkdirSync(FRAMES, { recursive: true });

/** ----------------------------------------------------- page-side overlay -- */

/**
 * Injected before any page script runs.
 *
 * Everything here exists for the camera: a pointer glyph that follows the real
 * mouse events Playwright dispatches (a headless browser films no OS cursor), a
 * ripple on press so clicks read at video speed, the title-card component and
 * the closing fade. It sticks to `documentElement`, which the app never
 * re-renders, and every node is `pointer-events: none`.
 */
function overlay() {
  const CSS = `
  #va-cursor{position:fixed;left:0;top:0;width:24px;height:24px;z-index:2147483600;pointer-events:none;
    opacity:0;transition:opacity 220ms linear;will-change:transform;
    filter:drop-shadow(0 2px 4px rgba(0,0,0,.6))}
  #va-cursor.on{opacity:1}
  #va-cursor svg{display:block}
  .va-ripple{position:fixed;left:0;top:0;width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:50%;
    border:2px solid rgba(78,201,176,.9);background:rgba(78,201,176,.28);pointer-events:none;
    z-index:2147483590;animation:va-ripple 620ms cubic-bezier(.2,.7,.3,1) forwards}
  @keyframes va-ripple{from{transform:scale(.3);opacity:.95}to{transform:scale(3.4);opacity:0}}
  #va-card{position:fixed;inset:0;z-index:2147483000;display:grid;place-items:center;pointer-events:none;
    opacity:0;transition:opacity 700ms ease;
    background:radial-gradient(1100px 700px at 28% 18%,rgba(78,201,176,.16),transparent 62%),
               radial-gradient(900px 600px at 78% 84%,rgba(197,134,192,.14),transparent 60%),
               linear-gradient(160deg,#0b0e13 0%,#0d1218 55%,#05070a 100%)}
  #va-card.on{opacity:1}
  #va-card .inner{text-align:center;transform:translateY(14px);transition:transform 1100ms cubic-bezier(.16,.8,.24,1);font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
  #va-card.on .inner{transform:none}
  #va-card .mark{width:54px;height:54px;border-radius:12px;margin:0 auto 22px;
    background:linear-gradient(135deg,#4ec9b0 0 45%,#e8b84b 45% 70%,#c586c0 70% 100%);
    box-shadow:0 18px 44px rgba(78,201,176,.28)}
  #va-card h1{margin:0;font-size:74px;line-height:1;font-weight:600;letter-spacing:-1.5px;color:#e8edf5}
  #va-card h1 b{color:#4ec9b0;font-weight:600}
  #va-card .tag{margin:20px auto 0;max-width:900px;font-size:22px;line-height:1.5;color:#aab4c4}
  #va-card .stats{margin:34px auto 0;display:flex;gap:12px;justify-content:center;flex-wrap:wrap;
    font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace;font-size:15px;color:#7b8798}
  #va-card .stats span{padding:8px 15px;border:1px solid #262d3a;border-radius:999px;background:rgba(22,27,36,.75)}
  #va-card .stats b{color:#e8edf5;font-weight:600}
  #va-card .foot{margin-top:34px;font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace;font-size:14px;color:#59636f;letter-spacing:.2px}
  #va-fade{position:fixed;inset:0;background:#05070a;opacity:0;pointer-events:none;z-index:2147483700;
    transition:opacity 1100ms ease}
  #va-fade.on{opacity:1}
  `;

  const install = () => {
    if (!document.documentElement) return setTimeout(install, 4);
    const style = document.createElement('style');
    style.id = 'va-style';
    style.textContent = CSS;
    document.documentElement.append(style);

    const cursor = document.createElement('div');
    cursor.id = 'va-cursor';
    cursor.innerHTML =
      '<svg width="24" height="24" viewBox="0 0 24 24">' +
      '<path d="M5 2.5 L19.5 12.2 L12.9 13.4 L9.6 20.6 Z" fill="#ffffff" stroke="#0b0e13" stroke-width="1.6" stroke-linejoin="round"/>' +
      '</svg>';
    document.documentElement.append(cursor);
    window.__vaCursor = cursor;

    window.addEventListener(
      'mousemove',
      (e) => {
        cursor.style.transform = `translate3d(${e.clientX}px,${e.clientY}px,0)`;
        if (!window.__vaCursorShown) {
          window.__vaCursorShown = true;
          cursor.classList.add('on');
        }
      },
      true
    );
    window.addEventListener(
      'mousedown',
      (e) => {
        if (!window.__vaCursorShown) return;
        const r = document.createElement('div');
        r.className = 'va-ripple';
        r.style.transform = `translate3d(${e.clientX}px,${e.clientY}px,0)`;
        document.documentElement.append(r);
        setTimeout(() => r.remove(), 700);
      },
      true
    );

    // App dark background from the very first paint: without this the video
    // opens on a white flash before the stylesheet arrives.
    const bg = document.createElement('style');
    bg.textContent = 'html{background:#0b0e13}';
    document.documentElement.append(bg);
  };
  install();

  window.__va = {
    showCursor() {
      window.__vaCursor?.classList.add('on');
      window.__vaCursorShown = true;
    },
    hideCursor() {
      window.__vaCursor?.classList.remove('on');
      window.__vaCursorShown = false;
    },
    card(cfg) {
      document.getElementById('va-card')?.remove();
      const el = document.createElement('div');
      el.id = 'va-card';
      el.innerHTML =
        '<div class="inner">' +
        '<div class="mark"></div>' +
        `<h1>${cfg.title}</h1>` +
        `<div class="tag">${cfg.tagline}</div>` +
        `<div class="stats">${cfg.stats.map((s) => `<span>${s}</span>`).join('')}</div>` +
        (cfg.foot ? `<div class="foot">${cfg.foot}</div>` : '') +
        '</div>';
      document.documentElement.append(el);
      requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('on')));
      return new Promise((res) => setTimeout(res, 900));
    },
    hideCard() {
      const el = document.getElementById('va-card');
      if (!el) return Promise.resolve();
      el.classList.remove('on');
      return new Promise((res) =>
        setTimeout(() => {
          el.remove();
          res();
        }, 760)
      );
    },
    fadeOut() {
      const el = document.createElement('div');
      el.id = 'va-fade';
      document.documentElement.append(el);
      requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('on')));
      return new Promise((res) => setTimeout(res, 1400));
    },
  };
}

/** ------------------------------------------------------------- browser -- */

const tVideo = Date.now();
const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const context = await browser.newContext({
  viewport: { width: W, height: H },
  deviceScaleFactor: 1,
  acceptDownloads: true,
  // The Permalink button copies the URL; without the grant the rejection would
  // show up as a page error in the report.
  permissions: ['clipboard-read', 'clipboard-write'],
  recordVideo: { dir: RAW, size: { width: W, height: H } },
});
const page = await context.newPage();
page.setDefaultTimeout(20000);

const problems = [];
page.on('console', (m) => {
  if (m.type() === 'error') problems.push(`console: ${m.text()}`);
});
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));

/** --------------------------------------------------------------- timing -- */

const beats = [];
const beat = (ms) => page.waitForTimeout(ms);
let cursor = { x: -60, y: -60 };
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/** Move the pointer along an eased path, paced so the video actually shows it. */
async function glide(x, y, dur = 700, ease = easeInOut) {
  const from = { ...cursor };
  const steps = Math.max(3, Math.round(dur / 24));
  for (let i = 1; i <= steps; i++) {
    const p = ease(i / steps);
    await page.mouse.move(from.x + (x - from.x) * p, from.y + (y - from.y) * p);
    await beat(dur / steps);
  }
  cursor = { x, y };
}

/** Bounding box of a selector or a locator (both are accepted everywhere). */
const asLocator = (sel) => (typeof sel === 'string' ? page.locator(sel).first() : sel);
const box = (sel) => asLocator(sel).boundingBox();

async function glideTo(sel, dur = 700) {
  const loc = asLocator(sel);
  await loc.scrollIntoViewIfNeeded().catch(() => {});
  await beat(160);
  const b = await loc.boundingBox();
  if (!b) throw new Error(`no box for ${sel}`);
  await glide(b.x + b.width / 2, b.y + b.height / 2, dur);
  return b;
}

/** Glide onto a locator, then press it with real mouse events. */
async function press(target, { dur = 550, settle = 420, nth = 0 } = {}) {
  const loc = typeof target === 'string' ? page.locator(target).nth(nth) : target;
  await loc.waitFor({ state: 'visible' });
  // A panel may have been scrolled by an earlier beat; pointing at an element
  // that is out of view would click whatever happens to be at those pixels.
  await loc.scrollIntoViewIfNeeded().catch(() => {});
  await beat(180);
  const b = await loc.boundingBox();
  await glide(b.x + b.width / 2, b.y + b.height / 2, dur);
  await beat(120);
  await page.mouse.down();
  await beat(70);
  await page.mouse.up();
  await beat(settle);
}

const pressByText = (scope, text, o) =>
  press(page.locator(`${scope} button`, { hasText: text }).first(), o);

/**
 * Sidebar `<select>`s: the native popup is not rendered in a headless capture,
 * so glide onto the control (the pointer is part of the story) and set the
 * value directly — the map re-renders live either way.
 */
async function setSelect(label, value, { dur = 550, settle = 1200 } = {}) {
  const sel = page.locator('#controls .field', { hasText: label }).locator('select').first();
  const b = await sel.boundingBox();
  await glide(b.x + b.width - 16, b.y + b.height / 2, dur);
  await beat(200);
  await sel.selectOption(value);
  await beat(settle);
}

/** Wheel-scroll whatever sits under the pointer (panels own their scrolling). */
async function wheelAt(x, y, total, dur = 900) {
  await glide(x, y, 420);
  const steps = Math.max(4, Math.round(dur / 60));
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, total / steps);
    await beat(dur / steps);
  }
}

async function shot(name) {
  await page.screenshot({ path: path.join(FRAMES, `${String(beats.length + 1).padStart(2, '0')}-${name}.png`) });
}

/** One storyboard beat: timed, logged, and non-fatal. */
async function run(name, fn) {
  const t = Date.now();
  try {
    await fn();
    beats.push({ name, ms: Date.now() - t, ok: true });
    console.log(`  ✓ ${name} (${((Date.now() - t) / 1000).toFixed(1)}s)`);
  } catch (err) {
    beats.push({ name, ms: Date.now() - t, ok: false, err: String(err).split('\n')[0] });
    console.log(`  ✗ ${name} — ${String(err).split('\n')[0]}`);
  }
}

/** ---------------------------------------------------- canvas-side probes -- */

/** Clear whatever the filters are, using the app's own button. */
async function clearFilters(settle = 800) {
  const btn = page.locator('#controls button').filter({ hasText: /Clear \d+ filters?/ }).first();
  if (!(await btn.count())) return false;
  await press(btn, { settle });
  return true;
}

const themeOf = () => page.evaluate(() => document.documentElement.dataset.theme);

/**
 * Largest visible treemap rectangle of a given node kind, in page coords.
 *
 * With `needSelf` the point is probed until the canvas hit test returns that
 * very node — a rectangle's centre can sit inside a smaller child (or inside a
 * different package altogether), and a click there would select the wrong
 * thing, so the storyboard always aims at a point that belongs to the node it
 * is talking about.
 */
function treemapNode(kind, { needSelf = false } = {}) {
  return page.evaluate(
    ({ want, self }) => {
      const t = window.zombieAtlas.treemap;
      const cv = document.querySelector('#canvas');
      const r = cv.getBoundingClientRect();
      const canvasArea = cv.clientWidth * cv.clientHeight;
      const area = (n) => (n.x1 - n.x0) * (n.y1 - n.y0);
      let best = null;
      for (const n of t.nodes ?? []) {
        if (want && n.data?.kind !== want) continue;
        // The rectangle of the current zoom level is a group as well, but
        // zooming "into" it is a no-op — skip whatever fills the whole canvas.
        if (self && (!n.parent || area(n) > canvasArea * 0.9)) continue;
        const a = area(n);
        if (!best || a > best.a) best = { a, n };
      }
      if (!best) {
        for (const n of t.nodes ?? []) {
          if (want && n.data?.kind !== want) continue;
          const a = area(n);
          if (!best || a > best.a) best = { a, n };
        }
      }
      if (!best) return null;
      const n = best.n;
      let px = (n.x0 + n.x1) / 2;
      let py = (n.y0 + n.y1) / 2;
      let own = t.nodeAt(px, py) === n;
      if (self && !own) {
        // A group rectangle is covered by its children, so its own pixels are
        // only the padding ring around them and the gaps between them. Walk the
        // ring (and then a coarse grid) until the hit test returns the node.
        const w = n.x1 - n.x0;
        const h = n.y1 - n.y0;
        const cols = Math.max(2, Math.min(80, Math.round(w / 8)));
        const rows = Math.max(2, Math.min(80, Math.round(h / 8)));
        const ring = [];
        for (const d of [0.5, 1, 1.5, 2, 2.5, 3]) {
          for (let i = 0; i <= cols; i++) {
            const x = n.x0 + (w * i) / cols;
            ring.push([x, n.y0 + d], [x, n.y1 - d]);
          }
          for (let j = 0; j <= rows; j++) {
            const y = n.y0 + (h * j) / rows;
            ring.push([n.x0 + d, y], [n.x1 - d, y]);
          }
        }
        for (let j = 2; j < rows - 1 && !own; j++) {
          for (let i = 2; i < cols - 1; i++) ring.push([n.x0 + (w * i) / cols, n.y0 + (h * j) / rows]);
        }
        for (const [qx, qy] of ring) {
          if (qx < 1 || qy < 1 || qx > cv.clientWidth - 1 || qy > cv.clientHeight - 1) continue;
          if (t.nodeAt(qx, qy) === n) {
            px = qx;
            py = qy;
            own = true;
            break;
          }
        }
      }
      return {
        x: r.left + px,
        y: r.top + py,
        kind: n.data?.kind ?? null,
        id: n.data?.id ?? null,
        classId: n.data?.classId ?? null,
        hitsSelf: own,
        area: Math.round(best.a),
      };
    },
    { want: kind, self: needSelf }
  );
}

/** Busiest package node in the dependency graph, in page coords. */
function graphHottestNode() {
  return page.evaluate(() => {
    const d = window.zombieAtlas.deps();
    const cv = document.querySelector('#canvas');
    const r = cv.getBoundingClientRect();
    const counts = new Map();
    const pts = new Map();
    for (let y = 70; y < cv.clientHeight - 70; y += 9) {
      for (let x = 70; x < cv.clientWidth - 70; x += 9) {
        const hit = d.hitTest(x, y);
        if (!hit) continue;
        counts.set(hit, (counts.get(hit) ?? 0) + 1);
        const p = pts.get(hit) ?? { sx: 0, sy: 0, n: 0 };
        pts.set(hit, { sx: p.sx + x, sy: p.sy + y, n: p.n + 1 });
      }
    }
    let best = null;
    for (const [p, c] of counts) if (!best || c > best.c) best = { p, c };
    if (!best) return null;
    const q = pts.get(best.p);
    return { x: r.left + q.sx / q.n, y: r.top + q.sy / q.n, path: best.p };
  });
}

/** Strongest off-diagonal cell of the package adjacency matrix. */
function matrixCell() {
  return page.evaluate(() => {
    const rects = [...document.querySelectorAll('#deps-pane svg rect')];
    let best = null;
    for (const r of rects) {
      if (r.getAttribute('data-from') === r.getAttribute('data-to')) continue;
      const w = Number(r.getAttribute('data-w') ?? 0);
      if (!w) continue;
      if (!best || w > best.w) best = { w, r };
    }
    if (!best) return null;
    const b = best.r.getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2, w: best.w, from: best.r.getAttribute('data-from'), to: best.r.getAttribute('data-to') };
  });
}

/** ------------------------------------------------------------ storyboard -- */

console.log(`\nZombie Atlas trailer — ${W}x${H} @ ${URL_}\n`);

await page.addInitScript(overlay);
await page.goto(URL_, { waitUntil: 'networkidle' });
await page.waitForFunction(() => !!window.zombieAtlas && document.querySelectorAll('#tabs button').length === 5);
await beat(1400); // first paint of the treemap + member shard prefetch

const meta = await page.evaluate(() => window.zombieAtlas.atlas.meta);
const counts = meta.counts;
const domains = await page.evaluate(() => window.zombieAtlas.atlas.domains.length);
const fmt = (n) => n.toLocaleString('en-US');

const intro = {
  title: 'Zombie<b>Atlas</b>',
  tagline: `An interactive map of the decompiled Project Zomboid source tree — ${fmt(counts.files)} files, parsed, never hand-curated.`,
  stats: [
    `<b>${fmt(counts.types)}</b> types`,
    `<b>${fmt(counts.code)}</b> code lines`,
    `<b>${fmt(counts.packages)}</b> packages`,
    `<b>${fmt(counts.classEdges)}</b> class edges`,
  ],
  foot: 'treemap · hierarchy · dependencies · subsystems · insights',
};
const outro = {
  title: 'Zombie<b>Atlas</b>',
  tagline: 'Every view shares one selection, one filter set and one inspector — and the exact screen travels in the URL.',
  stats: [
    '<b>5</b> views',
    `<b>${domains}</b> domains`,
    'member-level leaves',
    'PNG / JSON export',
    'permalink',
  ],
  foot: `npm start → 127.0.0.1:5184 · ${fmt(counts.types)} types · ${fmt(counts.code)} code lines`,
};

const tStory = Date.now();

// ---- title card -----------------------------------------------------------
let tCardIn = null;
await run('intro title card', async () => {
  await page.evaluate(() => window.__va.hideCursor());
  if (USE_CARDS) await page.evaluate((c) => window.__va.card(c), intro);
  else await page.evaluate(() => window.__va.showCursor());
  tCardIn = Date.now(); // the card is at full opacity from here
  await beat(3600);
  await shot('intro');
  if (USE_CARDS) await page.evaluate(() => window.__va.hideCard());
  await page.mouse.move(40, 40);
  cursor = { x: 40, y: 40 };
  await page.evaluate(() => window.__va.showCursor());
  await beat(200);
});

const cv = await box('#canvas');

// ---- act 1: the treemap ---------------------------------------------------
await run('treemap hover sweep', async () => {
  await glide(cv.x + cv.width * 0.12, cv.y + cv.height * 0.16, 600);
  await glide(cv.x + cv.width * 0.66, cv.y + cv.height * 0.5, 1800);
  await glide(cv.x + cv.width * 0.3, cv.y + cv.height * 0.78, 1400);
});

await run('hover a class → readout tooltip', async () => {
  const n = await treemapNode('class');
  await glide(n.x, n.y, 750);
  await beat(1250);
  await shot('treemap-tooltip');
});

await run('click → inspector fills', async () => {
  const n = await treemapNode('class');
  await page.mouse.click(n.x, n.y);
  await beat(1000);
  await shot('treemap-selected');
});

await run('inspector scroll', async () => {
  const b = await box('#inspector');
  await wheelAt(b.x + b.width / 2, b.y + b.height * 0.6, 700, 900);
  await beat(400);
  await wheelAt(b.x + b.width / 2, b.y + b.height * 0.6, -800, 900);
});

await run('double-click → zoom into a package', async () => {
  // A package rectangle is covered by its children, so aim at a pixel that the
  // hit test attributes to the package itself. The zoom path is absolute
  // (`zombie > zombie.iso` from the root view), which is what the breadcrumb
  // walk-back below steps through.
  const g = await treemapNode('group', { needSelf: true });
  if (!g?.hitsSelf) throw new Error('no package rectangle hit its own pixels');
  await glide(g.x, g.y, 650);
  await page.mouse.dblclick(g.x, g.y);
  await beat(900);
  const depth = await page.evaluate(() => window.zombieAtlas.store.state.selection.zoom.length);
  if (depth < 2) throw new Error(`expected the zoom path to grow, got depth ${depth}`);
  await shot('treemap-zoomed');
});

await run('breadcrumbs: up then root', async () => {
  const depth = await page.evaluate(() => window.zombieAtlas.store.state.selection.zoom.length);
  if (depth < 2) throw new Error(`treemap is not zoomed (depth ${depth}) — nothing to walk back`);
  await pressByText('#stage-actions', 'Up', { settle: 750 });
  await pressByText('#stage-actions', 'Root', { settle: 850 });
});

await run('leaves: members', async () => {
  await pressByText('#stage-actions', 'Leaves: types', { settle: 700 });
  // member shards are fetched on demand — wait for the rectangles to exist
  await page
    .waitForFunction(() => (window.zombieAtlas.treemap.nodes ?? []).some((n) => n.data?.kind === 'member'), null, { timeout: 12000 })
    .catch(() => {});
  await beat(800);
  const n = await treemapNode('member');
  if (n) {
    await glide(n.x, n.y, 700);
    await beat(1100);
  }
  await shot('treemap-members');
  await pressByText('#stage-actions', 'Leaves: members', { settle: 900 });
});

await run('layout algorithms', async () => {
  await pressByText('#stage-actions', 'Slice', { settle: 900 });
  await pressByText('#stage-actions', 'Binary', { settle: 900 });
  await shot('treemap-binary');
  await pressByText('#stage-actions', 'Squarified', { settle: 800 });
});

await run('size metric → complexity', async () => {
  await setSelect('Size metric', 'complexity', { settle: 1200 });
  await shot('metric-complexity');
});

await run('colour by fan-in heat', async () => {
  await setSelect('Colour by', 'fanIn', { settle: 1200 });
  await shot('colour-fanin');
});

await run('group by stereotype', async () => {
  await setSelect('Group by', 'stereotype', { settle: 1300 });
  await shot('group-stereotype');
});

await run('back to the default encoding', async () => {
  await setSelect('Size metric', 'code', { settle: 500 });
  await setSelect('Colour by', 'domain', { settle: 500 });
  await setSelect('Group by', 'package', { settle: 700 });
});

await run('cull slider', async () => {
  const slider = page.locator('#controls input[type=range]').nth(2); // hide below N%
  const b = await slider.boundingBox();
  await glide(b.x + 4, b.y + b.height / 2, 550);
  await page.mouse.down();
  await glide(b.x + b.width * 0.34, b.y + b.height / 2, 900);
  await beat(400);
  await glide(b.x + 2, b.y + b.height / 2, 700);
  await page.mouse.up();
  await beat(600);
});

await run('filter chips', async () => {
  await press(page.locator('#controls .chip', { hasText: 'manager' }).first(), { settle: 900 });
  await shot('filter-chip');
  const domain = page.locator('#controls .chip').filter({ hasText: /^iso$/ }).first();
  await glideTo(domain, 700);
  await beat(600);
  await press(domain, { settle: 900 });
  await shot('filter-domain');
  await clearFilters(900);
});

await run('stage actions: export', async () => {
  await pressByText('#stage-actions', 'PNG', { settle: 500 });
  await pressByText('#stage-actions', 'JSON', { settle: 500 });
});

// ---- act 2: search + source ----------------------------------------------
await run('search → IsoPlayer', async () => {
  await page.keyboard.press('/');
  await beat(400);
  await page.keyboard.type('IsoPlayer', { delay: 80 });
  await beat(900);
  await shot('search-suggest');
  await page.keyboard.press('ArrowDown');
  await beat(400);
  await page.keyboard.press('ArrowUp');
  await beat(300);
  await page.keyboard.press('Enter');
  await beat(1200);
  await shot('search-selected');
});

await run('source viewer', async () => {
  await pressByText('#inspector-body', 'View source', { settle: 1200 });
  const b = await box('.modal .src-wrap');
  await wheelAt(b.x + b.width / 2, b.y + b.height * 0.6, 900, 1200);
  await beat(500);
  await shot('source');
  await press(page.locator('.modal .close-row button.primary'), { settle: 500 });
  await clearFilters(700);
});

// ---- act 3: hierarchy -----------------------------------------------------
await run('hierarchy view', async () => {
  await pressByText('#tabs', 'Hierarchy', { settle: 900 });
  // A root whose subtree is tall enough to fill the pane once expanded.
  await press(page.locator('#hierarchy-pane .link', { hasText: 'IAnimEventListener' }).first(), { settle: 1000 });
  await pressByText('#stage-actions', 'Expand two levels', { settle: 1300 });
  await shot('hierarchy');
});

await run('hierarchy root filter', async () => {
  const input = page.locator('#hierarchy-pane input[placeholder="filter roots…"]');
  const b = await input.boundingBox();
  await glide(b.x + 40, b.y + b.height / 2, 500);
  await page.mouse.click(b.x + 40, b.y + b.height / 2);
  await beat(300);
  await page.keyboard.type('Iso', { delay: 110 });
  await beat(900);
  await shot('hierarchy-filter');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await beat(600);
});

// ---- act 4: dependencies --------------------------------------------------
await run('dependency graph', async () => {
  await pressByText('#tabs', 'Dependencies', { settle: 2100 });
  const b = await box('#canvas');
  await glide(b.x + b.width * 0.5, b.y + b.height * 0.5, 1000);
  await beat(500);
  await shot('deps-graph');
});

await run('graph hover → neighbourhood', async () => {
  const n = await graphHottestNode();
  if (!n) throw new Error('no graph node found');
  await glide(n.x, n.y, 850);
  await beat(1300);
  await page.mouse.click(n.x, n.y);
  await beat(1000);
  await shot('deps-hover');
});

await run('graph wheel zoom + pan', async () => {
  const b = await box('#canvas');
  const cx = b.x + b.width * 0.5;
  const cy = b.y + b.height * 0.5;
  for (let i = 0; i < 9; i++) {
    await page.mouse.wheel(0, -70);
    await beat(60);
  }
  await beat(400);
  await glide(cx + 180, cy + 130, 350);
  await page.mouse.down();
  await glide(cx - 220, cy - 90, 1100);
  await page.mouse.up();
  await beat(600);
  await shot('deps-zoomed');
  await pressByText('#stage-actions', 'Fit', { settle: 1000 });
});

await run('matrix mode', async () => {
  await pressByText('#stage-actions', 'matrix', { settle: 1100 });
  const cell = await matrixCell();
  if (cell) {
    await glide(cell.x - 60, cell.y - 40, 550);
    await glide(cell.x, cell.y, 550);
    await beat(1200);
    await shot('deps-matrix');
    await page.mouse.click(cell.x, cell.y);
    await beat(1000);
  }
});

await run('class edge list', async () => {
  await pressByText('#stage-actions', 'classes', { settle: 1100 });
  const b = await box('#deps-pane');
  await wheelAt(b.x + b.width * 0.4, b.y + b.height * 0.6, 800, 1300);
  await beat(400);
  await shot('deps-classes');
});

// ---- act 5: subsystems ----------------------------------------------------
await run('subsystems cards', async () => {
  await pressByText('#tabs', 'Subsystems', { settle: 900 });
  const b = await box('#subsystems-pane');
  await wheelAt(b.x + b.width * 0.5, b.y + b.height * 0.6, 900, 1300);
  await beat(400);
  await shot('subsystems');
  await wheelAt(b.x + b.width * 0.5, b.y + b.height * 0.6, -900, 1100);
});

await run('domain card → filtered treemap', async () => {
  // The first card is the biggest domain (iso); the pane is back at its top.
  const card = page.locator('#subsystems-pane .domain-card').filter({ hasText: /^iso/ }).first();
  await press(card, { settle: 1200 });
  await shot('domain-filtered-treemap');
  await clearFilters(900);
});

// ---- act 6: insights ------------------------------------------------------
await run('insights rankings', async () => {
  await pressByText('#tabs', 'Insights', { settle: 900 });
  const b = await box('#insights-pane');
  await wheelAt(b.x + b.width * 0.5, b.y + b.height * 0.6, 1000, 1400);
  await beat(500);
  await shot('insights');
  await wheelAt(b.x + b.width * 0.5, b.y + b.height * 0.6, -1000, 900);
});

await run('insight row → selection', async () => {
  await press(page.locator('#insights-pane .rank-row').first(), { settle: 1100 });
  await shot('insights-selected');
});

// ---- act 7: theme, help, outro -------------------------------------------
await run('light theme', async () => {
  if ((await themeOf()) !== 'light') await press('#btn-theme', { settle: 1000 });
  if ((await themeOf()) !== 'light') throw new Error('theme did not switch to light');
  await pressByText('#tabs', 'Treemap', { settle: 1300 });
  const b = await box('#canvas');
  await glide(b.x + b.width * 0.4, b.y + b.height * 0.45, 900);
  await beat(700);
  await shot('treemap-light');
});

await run('help dialog', async () => {
  await press('#btn-help', { settle: 1000 });
  const b = await box('.modal');
  await wheelAt(b.x + b.width / 2, b.y + b.height * 0.6, 700, 1300);
  await beat(700);
  await shot('help');
  await press(page.locator('.modal .close-row button.primary'), { settle: 700 });
});

await run('permalink', async () => {
  await pressByText('#stage-actions', 'Permalink', { settle: 1200 });
});

await run('outro title card', async () => {
  await page.evaluate(() => window.__va.hideCursor());
  await beat(400);
  if (USE_CARDS) await page.evaluate((c) => window.__va.card(c), outro);
  await beat(3200);
  await shot('outro');
  await page.evaluate(() => window.__va.fadeOut());
});

const tEnd = Date.now();

/** ------------------------------------------------------------- encoding -- */

await context.close();
await browser.close();

const rawPath = await (async () => {
  const files = fs.readdirSync(RAW).filter((f) => f.endsWith('.webm'));
  return files.length ? path.join(RAW, files[0]) : null;
})();

function findFfmpeg() {
  if (process.env.FFMPEG && fs.existsSync(process.env.FFMPEG)) return process.env.FFMPEG;
  const local = path.resolve(APP, '..', 'tmp', 'trailer-tools', 'node_modules', 'ffmpeg-static', 'ffmpeg');
  if (fs.existsSync(local)) return local;
  const probe = spawnSync('sh', ['-c', 'command -v ffmpeg'], { encoding: 'utf8' });
  return probe.status === 0 && probe.stdout.trim() ? probe.stdout.trim() : null;
}

const finalWebm = path.join(OUT, 'zombie-atlas-trailer.webm');
const finalMp4 = path.join(OUT, 'zombie-atlas-trailer.mp4');
let delivered = null;

if (rawPath) {
  // Trim the load: with a title card the film opens on the card at full
  // opacity, otherwise it keeps a second of the freshly painted app.
  const autoTrim = tCardIn
    ? Math.max(0, (tCardIn - tVideo) / 1000 - 0.2)
    : Math.max(0, (tStory - tVideo) / 1000 - 1.0);
  const trim = Number(opt('trim', autoTrim.toFixed(2)));

  const ffmpeg = ENCODE ? findFfmpeg() : null;
  if (ffmpeg) {
    const encode = (out, args) =>
      spawnSync(ffmpeg, ['-y', '-loglevel', 'error', '-ss', String(trim), '-i', rawPath, ...args, out], { encoding: 'utf8' });

    // H.264 / yuv420p / faststart: plays everywhere, seeks instantly.
    let r = encode(finalMp4, [
      '-vf', `fps=30,scale=${W}:${H}:flags=lanczos`,
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-g', '60',
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    ]);
    if (r.status === 0 && fs.existsSync(finalMp4)) {
      delivered = finalMp4;
    } else {
      console.log(`  ffmpeg mp4 failed: ${(r.stderr || '').trim().split('\n').slice(-2).join(' ')}`);
      // Fall back to a fresh VP8/WebM render of the trimmed range.
      r = encode(finalWebm, ['-c:v', 'libvpx', '-b:v', '6M', '-crf', '24', '-deadline', 'good', '-cpu-used', '2']);
      if (r.status === 0 && fs.existsSync(finalWebm)) delivered = finalWebm;
    }
  }
  if (!delivered) {
    fs.copyFileSync(rawPath, finalWebm);
    delivered = finalWebm;
  }
}

/** --------------------------------------------------------------- report -- */

const wall = ((tEnd - tStory) / 1000).toFixed(1);
console.log(`\nStoryboard: ${wall}s, ${beats.filter((b) => b.ok).length}/${beats.length} beats ok`);
const failed = beats.filter((b) => !b.ok);
for (const f of failed) console.log(`  ! ${f.name}: ${f.err}`);
if (problems.length) {
  console.log(`\nPage errors (${problems.length}):`);
  for (const p of problems.slice(0, 10)) console.log(`  ! ${p}`);
} else {
  console.log('No console or page errors.');
}

if (delivered) {
  const size = (fs.statSync(delivered).size / 1024 / 1024).toFixed(1);
  console.log(`\nVideo: ${path.relative(process.cwd(), delivered)}  (${size} MB)`);
  console.log(`Frames: ${FRAMES}`);
  if (delivered === finalMp4 && rawPath && fs.existsSync(rawPath)) {
    fs.rmSync(RAW, { recursive: true, force: true });
  }
} else {
  console.log('\nNo video produced.');
  process.exitCode = 1;
}
if (failed.length) process.exitCode = 1;
