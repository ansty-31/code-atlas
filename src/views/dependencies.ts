import { msg, trLabel } from '../i18n';
/**
 * Dependency view — how packages (and the types inside them) reference each
 * other, derived purely from `import` statements and fully-qualified references
 * found in the source.
 *
 * Three modes:
 *   graph    force-directed package graph (size = code, colour = domain)
 *   matrix   adjacency matrix of the busiest packages (density-friendly)
 *   classes  the strongest class→class edges for the selected package pair
 */

import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY } from 'd3-force';
import type { SimulationNodeDatum } from 'd3-force';
import { type Atlas, type ClassRec, REF_KINDS, loadClassDeps, loadRefShard } from '../domain';
import { store, type AppState, type DepMode } from '../state';
import { fitText, fmtCompact, fmtInt, h, rgba, sampleRamp, esc } from '../util';

interface GNode extends SimulationNodeDatum {
  path: string;
  name: string;
  code: number;
  domain: string;
  color: string;
  degree: number;
}

interface GEdge {
  source: GNode | string;
  target: GNode | string;
  w: number;
}

let atlas: Atlas | null = null;
let mode: DepMode = 'graph';
let minWeight = 3;
let topN = 40;
let onlyCrossDomain = false;

let canvas: HTMLCanvasElement;
let ctx: CanvasRenderingContext2D;
let wrap: HTMLElement;
let nodes: GNode[] = [];
let edges: GEdge[] = [];
let sim: ReturnType<typeof forceSimulation<GNode>> | null = null;
let hover: GNode | null = null;
let dragging: GNode | null = null;
let view = { x: 0, y: 0, k: 1 };
let matrixSel: { from: string; to: string } | null = null;
let dom: HTMLElement | null = null;
let hint: HTMLElement | null = null;

export function initDependencies(a: Atlas, wrapEl: HTMLElement) {
  atlas = a;
  wrap = wrapEl;
  canvas = wrapEl.querySelector('canvas')!;
  ctx = canvas.getContext('2d')!;
  bind();
}

export function teardownDependencies() {
  // The simulation instance and the view transform survive leaving the view, so
  // coming back shows the same framing instead of a freshly re-fitted graph.
  sim?.stop();
  hint?.remove();
  hint = null;
  dom?.remove();
  dom = null;
  const cv = document.getElementById('canvas');
  if (cv) cv.style.visibility = 'visible';
}

export function setDepMode(m: DepMode) {
  // goes through the store so the stage toolbar re-renders with the new
  // active button (a local variable left the toolbar showing a stale mode)
  store.update((s) => {
    s.depMode = m;
  });
}

/**
 * Called by the shell when the stage size changes. The view transform is kept:
 * refitting here would throw away whatever the user had zoomed into.
 */
export function resizeDependencies() {
  if (mode === 'graph' && store.state.view === 'dependencies') dirty = true;
}

export function renderDependencies(state: AppState) {
  if (!atlas) return;
  if (store.state.view !== 'dependencies') return;
  mode = state.depMode;
  const pane = getPane();
  if (mode === 'graph') {
    canvas.style.visibility = 'visible';
    pane.hidden = true;
    if (!hint) {
      hint = h('div', {
        class: 'graph-hint',
        text: msg("scroll to zoom · drag to pan · click a node to inspect · drag a node to pin it · double-click a node to focus, empty space to fit"),
      });
      wrap.append(hint);
    }
    hint.hidden = false;
    // Only re-run the force layout when the graph inputs changed. Rebuilding on
    // every store update (a click, a filter change) reset pan and zoom.
    const key = graphKey();
    if (key !== builtKey) {
      builtKey = key;
      buildGraph(state);
    } else {
      dirty = true;
    }
  } else {
    canvas.style.visibility = 'hidden';
    if (hint) hint.hidden = true;
    sim?.stop();
    pane.hidden = false;
    pane.replaceChildren(mode === 'matrix' ? matrixPane(state) : classEdgePane(state));
  }
}

function getPane(): HTMLElement {
  if (!dom) {
    dom = h('div', { id: 'deps-pane', class: 'card-grid stage-pane', style: { gridTemplateColumns: '1fr' } });
    wrap.append(dom);
  }
  return dom;
}

/** ---------------------------------------------------------------- graph --- */

/** Inputs that change the node/edge set; anything else is a pure redraw. */
let builtKey = '';
function graphKey(): string {
  return [topN, minWeight, onlyCrossDomain ? 1 : 0, atlas?.classes.length ?? 0].join('|');
}

function buildGraph(state: AppState) {
  if (!atlas) return;
  const w = wrap.clientWidth;
  const hgt = wrap.clientHeight;
  const counts = new Map<string, number>();
  for (const e of atlas.pkgEdges) {
    if (onlyCrossDomain && e.from.split('.')[0] === e.to.split('.')[0]) continue;
    counts.set(e.from, (counts.get(e.from) ?? 0) + e.w);
    counts.set(e.to, (counts.get(e.to) ?? 0) + e.w);
  }
  const keep = new Set(
    [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, topN)
      .map(([p]) => p)
  );
  const prev = new Map(nodes.map((n) => [n.path, n]));
  nodes = [...keep].map((path) => {
    const node = atlas!.pkgByPath.get(path);
    const domain = atlas!.pkgDomain.get(path) ?? path.split('.')[0];
    const old = prev.get(path);
    return {
      path,
      name: node?.name ?? path,
      code: node?.metrics?.code ?? 0,
      domain,
      color: atlas!.domains.find((d) => d.key === domain)?.color ?? '#6ea8fe',
      degree: counts.get(path) ?? 0,
      x: old?.x ?? w / 2 + (Math.random() - 0.5) * w * 0.6,
      y: old?.y ?? hgt / 2 + (Math.random() - 0.5) * hgt * 0.6,
    };
  });
  const byPath = new Map(nodes.map((n) => [n.path, n]));
  edges = atlas.pkgEdges
    .filter((e) => e.w >= minWeight && byPath.has(e.from) && byPath.has(e.to))
    .filter((e) => !onlyCrossDomain || e.from.split('.')[0] !== e.to.split('.')[0])
    .map((e) => ({ source: byPath.get(e.from)!, target: byPath.get(e.to)!, w: e.w }));

  const maxCode = Math.max(1, ...nodes.map((n) => n.code));
  sim?.stop();
  sim = forceSimulation<GNode>(nodes)
    .force('charge', forceManyBody<GNode>().strength((d) => -220 - (d.code / maxCode) * 900).distanceMax(520))
    .force('link', forceLink<GNode, GEdge>(edges).id((d) => d.path).distance((e) => 34 + 130 / Math.sqrt(e.w)).strength(0.35))
    .force('center', forceCenter(w / 2, hgt / 2))
    .force('collide', forceCollide<GNode>().radius((d) => radius(d, maxCode) + 6).strength(0.9).iterations(2))
    .force('x', forceX(w / 2).strength(0.03))
    .force('y', forceY(hgt / 2).strength(0.03))
    .on('tick', () => {
      dirty = true;
    });
  for (let i = 0; i < 320; i++) sim.tick();
  relaxOutliers();
  // Freeze the layout: a still-running simulation would drift nodes out of the
  // viewport right after "fit" framed them. Dragging a node restarts it.
  sim.alpha(0).stop();
  fitView();
  dirty = true;
}

let dirty = true;

function radius(n: GNode, maxCode?: number): number {
  const m = maxCode ?? Math.max(1, ...nodes.map((x) => x.code));
  return 4.5 + Math.sqrt(n.code / m) * 26;
}

/** Bounding box of the settled layout, in graph coordinates. */
function bounds() {
  const maxCode = Math.max(1, ...nodes.map((n) => n.code));
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    const r = radius(n, maxCode);
    minX = Math.min(minX, n.x! - r);
    minY = Math.min(minY, n.y! - r);
    maxX = Math.max(maxX, n.x! + r);
    maxY = Math.max(maxY, n.y! + r);
  }
  return { minX, minY, maxX, maxY };
}

/**
 * Pull stray nodes back toward the bulk of the graph.
 *
 * A single weakly-connected package can be flung far away by the charge force;
 * because "fit" uses the bounding box, that one node would shrink everything
 * else into a corner. Clamping to ~2x the median radius and re-relaxing keeps
 * the picture balanced without dropping any node.
 */
function relaxOutliers() {
  if (!sim || nodes.length < 5) return;
  // Clamp, relax, clamp again: a single pass would be undone by the next ticks.
  for (let pass = 0; pass < 3; pass++) {
    clampToBulk(2.2);
    sim.alpha(0.2);
    for (let i = 0; i < 20; i++) sim.tick();
  }
  clampToBulk(2.0); // final pass with no ticks after it
}

/** Move nodes further than `factor` x the median radius back toward the bulk. */
function clampToBulk(factor: number) {
  const cx = nodes.reduce((a, n) => a + n.x!, 0) / nodes.length;
  const cy = nodes.reduce((a, n) => a + n.y!, 0) / nodes.length;
  const dists = nodes.map((n) => Math.hypot(n.x! - cx, n.y! - cy)).sort((a, b) => a - b);
  const limit = (dists[Math.floor(dists.length / 2)] || 1) * factor;
  for (const n of nodes) {
    if (n.fx != null || n.fy != null) continue; // user-pinned
    const d = Math.hypot(n.x! - cx, n.y! - cy);
    if (d > limit) {
      const t = limit / d;
      n.x = cx + (n.x! - cx) * t;
      n.y = cy + (n.y! - cy) * t;
    }
  }
}

/** Fit the whole graph into the viewport by adjusting the view transform. */
export function fitView() {
  if (!nodes.length) return;
  const w = wrap.clientWidth;
  const h = wrap.clientHeight;
  const { minX, minY, maxX, maxY } = bounds();
  const pad = 30;
  const k = Math.max(0.05, Math.min(3, Math.min((w - pad * 2) / Math.max(1, maxX - minX), (h - pad * 2) / Math.max(1, maxY - minY))));
  view.k = k;
  view.x = w / 2 - ((minX + maxX) / 2) * k;
  view.y = h / 2 - ((minY + maxY) / 2) * k;
  dirty = true;
}

/** Zoom around a screen point (keeps the point under the cursor fixed). */
function zoomAt(px: number, py: number, factor: number) {
  const k = Math.max(0.08, Math.min(12, view.k * factor));
  const scale = k / view.k;
  view.x = px - (px - view.x) * scale;
  view.y = py - (py - view.y) * scale;
  view.k = k;
  dirty = true;
}

export function zoomBy(factor: number) {
  zoomAt(wrap.clientWidth / 2, wrap.clientHeight / 2, factor);
}

export function getZoom(): number {
  return view.k;
}

/** Introspection for the debug handle and the smoke test. */
export function depDebug() {
  return {
    mode,
    zoom: view.k,
    panX: view.x,
    panY: view.y,
    nodes: nodes.length,
    edges: edges.length,
    panning: !!panning,
    draggingNode: dragging?.path ?? null,
    hover: hover?.path ?? null,
    /** canvas-space hit test, used by the smoke test to find empty space */
    hitTest: (x: number, y: number) => nodeAt(x, y)?.path ?? null,
  };
}

const toWorld = (px: number, py: number) => ({ x: (px - view.x) / view.k, y: (py - view.y) / view.k });
const toScreen = (x: number, y: number) => ({ x: x * view.k + view.x, y: y * view.k + view.y });

export function frameDependencies() {
  if (store.state.view !== 'dependencies' || mode !== 'graph' || !dirty) return;
  dirty = false;
  drawGraph();
}

function drawGraph() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = wrap.clientWidth;
  const hgt = wrap.clientHeight;
  if (canvas.width !== w * dpr || canvas.height !== hgt * dpr) {
    canvas.width = w * dpr;
    canvas.height = hgt * dpr;
    canvas.style.width = w + 'px';
    canvas.style.height = hgt + 'px';
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const dark = document.documentElement.dataset.theme !== 'light';
  ctx.fillStyle = dark ? '#0b0e13' : '#f4f6fa';
  ctx.fillRect(0, 0, w, hgt);

  ctx.save();
  ctx.translate(view.x, view.y);
  ctx.scale(view.k, view.k);
  // keep stroke weights and text at a constant on-screen size
  const inv = 1 / view.k;

  const maxW = Math.max(1, ...edges.map((e) => e.w));
  const neighbours = new Set<string>();
  if (hover) {
    neighbours.add(hover.path);
    for (const e of edges) {
      const s = e.source as GNode;
      const t = e.target as GNode;
      if (s.path === hover.path) neighbours.add(t.path);
      if (t.path === hover.path) neighbours.add(s.path);
    }
  }

  // edges
  for (const e of edges) {
    const s = e.source as GNode;
    const t = e.target as GNode;
    const active = !hover || (neighbours.has(s.path) && neighbours.has(t.path) && (s.path === hover.path || t.path === hover.path));
    const strength = e.w / maxW;
    ctx.strokeStyle = active
      ? rgba(dark ? '#8fb8ff' : '#3f6fd8', 0.15 + strength * 0.65)
      : rgba(dark ? '#4a5365' : '#c3cad6', 0.08);
    ctx.lineWidth = (0.5 + Math.sqrt(strength) * 3.5) * inv;
    ctx.beginPath();
    ctx.moveTo(s.x!, s.y!);
    ctx.lineTo(t.x!, t.y!);
    ctx.stroke();
  }

  // nodes
  const maxCode = Math.max(1, ...nodes.map((n) => n.code));
  for (const n of nodes) {
    const r = radius(n, maxCode);
    const dim = hover && !neighbours.has(n.path);
    ctx.globalAlpha = dim ? 0.25 : 1;
    ctx.beginPath();
    ctx.arc(n.x!, n.y!, r, 0, Math.PI * 2);
    ctx.fillStyle = rgba(n.color, dark ? 0.75 : 0.85);
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = n === hover ? (dark ? '#fff' : '#000') : rgba(n.color, 0.95);
    ctx.stroke();
    if (!dim && r * view.k > 8) {
      ctx.font = `${(r > 18 ? 11.5 : 10) * inv}px ui-sans-serif, system-ui, sans-serif`;
      ctx.fillStyle = dark ? '#eef3fa' : '#10141c';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const label = fitText(ctx, n.name, r * 2.4);
      if (label) ctx.fillText(label, n.x!, n.y!);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
    }
    ctx.globalAlpha = 1;
  }
  ctx.restore();
}

function nodeAt(px: number, py: number): GNode | null {
  const maxCode = Math.max(1, ...nodes.map((n) => n.code));
  const p = toWorld(px, py);
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i];
    const r = radius(n, maxCode);
    if ((p.x - n.x!) ** 2 + (p.y - n.y!) ** 2 <= r * r) return n;
  }
  return null;
}

let panning: { x: number; y: number; vx: number; vy: number } | null = null;
/** press bookkeeping so a plain click never turns into a drag */
let pointerDown: { x: number; y: number; node: GNode | null; moved: boolean } | null = null;
let suppressClick = false;
const DRAG_THRESHOLD = 3;

function bind() {
  const cv = canvas;

  // wheel = zoom around the cursor
  cv.addEventListener(
    'wheel',
    (e) => {
      if (store.state.view !== 'dependencies' || mode !== 'graph') return;
      e.preventDefault();
      const r = cv.getBoundingClientRect();
      zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015));
    },
    { passive: false }
  );

  // Gestures are tracked on the window, not on the canvas: a pan or a node drag
  // must keep following the pointer once it leaves the canvas box.
  window.addEventListener('mousemove', (e) => {
    if (store.state.view !== 'dependencies' || mode !== 'graph') return;
    if (!pointerDown && !panning && !dragging) return;
    const r = cv.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;

    // A drag only starts once the pointer actually travels: pressing on a node
    // used to pin and nudge it immediately, so a click looked like a drag.
    if (pointerDown && !pointerDown.moved) {
      if (Math.hypot(px - pointerDown.x, py - pointerDown.y) > DRAG_THRESHOLD) {
        pointerDown.moved = true;
        suppressClick = true;
        if (pointerDown.node) {
          dragging = pointerDown.node;
          dragging.fx = dragging.x;
          dragging.fy = dragging.y;
          sim?.alphaTarget(0.2).restart();
        } else {
          panning = { x: pointerDown.x, y: pointerDown.y, vx: view.x, vy: view.y };
          cv.style.cursor = 'grabbing';
        }
      }
    }

    if (panning) {
      view.x = panning.vx + (px - panning.x);
      view.y = panning.vy + (py - panning.y);
      dirty = true;
      return;
    }
    if (dragging) {
      const p = toWorld(px, py);
      dragging.fx = p.x;
      dragging.fy = p.y;
      sim?.alpha(0.4).restart();
    }
  });

  cv.addEventListener('mousemove', (e) => {
    if (store.state.view !== 'dependencies' || mode !== 'graph') return;
    if (pointerDown || panning || dragging) return; // a gesture owns the pointer
    const r = cv.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    const n = nodeAt(px, py);
    if (n !== hover) {
      hover = n;
      dirty = true;
    }
    cv.style.cursor = n ? 'pointer' : 'default';
    const tip = document.getElementById('tooltip')!;
    if (n) {
      const inbound = edges.filter((x) => (x.target as GNode).path === n.path);
      const outbound = edges.filter((x) => (x.source as GNode).path === n.path);
      tip.innerHTML =
        `<div class="tt-title">${esc(n.path)}</div>` +
        `<div class="tt-path">${n.domain}</div>` +
        `<table><tr><td>${msg("code")}</td><td>${msg("{0} ln", fmtInt(n.code))}</td></tr>` +
        `<tr><td>${msg("packages linked")}</td><td>${msg("{0} in / {1} out", inbound.length, outbound.length)}</td></tr>` +
        `<tr><td>${msg("total refs")}</td><td>${n.degree}</td></tr></table>`;
      tip.hidden = false;
      tip.style.left = `${Math.min(wrap.clientWidth - tip.offsetWidth - 4, px + 14)}px`;
      tip.style.top = `${Math.min(wrap.clientHeight - tip.offsetHeight - 4, py + 14)}px`;
    } else tip.hidden = true;
  });
  cv.addEventListener('mouseleave', () => {
    if (store.state.view !== 'dependencies') return;
    hover = null;
    dirty = true;
    document.getElementById('tooltip')!.hidden = true;
  });
  cv.addEventListener('mousedown', (e) => {
    if (store.state.view !== 'dependencies' || mode !== 'graph') return;
    const r = cv.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    suppressClick = false;
    pointerDown = { x: px, y: py, node: nodeAt(px, py), moved: false };
  });
  window.addEventListener('mouseup', () => {
    if (dragging) {
      dragging.fx = null;
      dragging.fy = null;
      dragging = null;
      // let the neighbours settle, then park the simulation again
      sim?.alphaTarget(0);
      window.setTimeout(() => sim?.alpha(0).stop(), 900);
    }
    if (panning) {
      panning = null;
      cv.style.cursor = 'default';
    }
    pointerDown = null;
  });
  cv.addEventListener('click', (e) => {
    if (store.state.view !== 'dependencies' || mode !== 'graph') return;
    // a gesture that dragged is not a click
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    const r = cv.getBoundingClientRect();
    const n = nodeAt(e.clientX - r.left, e.clientY - r.top);
    if (n) {
      store.update((s) => {
        s.selection.packagePath = n.path;
        s.selection.classId = null;
      });
      matrixSel = null;
    }
  });
  cv.addEventListener('dblclick', (e) => {
    if (store.state.view !== 'dependencies' || mode !== 'graph') return;
    const r = cv.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    const n = nodeAt(px, py);
    if (n) {
      // focus the node: centre it and zoom in a step
      const k = Math.max(view.k, Math.min(6, view.k * 1.8));
      view.k = k;
      view.x = wrap.clientWidth / 2 - n.x! * k;
      view.y = wrap.clientHeight / 2 - n.y! * k;
      dirty = true;
      store.update((s) => {
        s.selection.classId = null;
        s.selection.packagePath = n.path;
      });
    } else {
      fitView();
    }
  });
}

/** --------------------------------------------------------------- matrix --- */

function matrixPane(state: AppState): HTMLElement {
  const panel = h('div', { class: 'card', style: { overflow: 'auto' } });
  const counts = new Map<string, number>();
  for (const e of atlas!.pkgEdges) {
    counts.set(e.from, (counts.get(e.from) ?? 0) + e.w);
    counts.set(e.to, (counts.get(e.to) ?? 0) + e.w);
  }
  const list = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN).map(([p]) => p);
  const index = new Map(list.map((p, i) => [p, i]));
  const m: number[][] = list.map(() => new Array(list.length).fill(0));
  for (const e of atlas!.pkgEdges) {
    const i = index.get(e.from);
    const j = index.get(e.to);
    if (i == null || j == null) continue;
    m[i][j] = e.w;
  }
  const max = Math.max(1, ...m.flat());
  const cell = 17;
  const label = 190;
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('width', String(label + list.length * cell + 20));
  svg.setAttribute('height', String(label + list.length * cell + 20));
  svg.setAttribute('style', 'font-family:var(--font-mono);font-size:10px');

  const dark = document.documentElement.dataset.theme !== 'light';
  const mk = (tag: string, attrs: Record<string, string | number>) => {
    const el = document.createElementNS(svgNS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    return el;
  };

  list.forEach((p, j) => {
    const t = mk('text', {
      x: label - 6,
      y: label + j * cell + 12,
      'text-anchor': 'end',
      fill: 'var(--fg-2)',
    });
    t.textContent = p.length > 28 ? '…' + p.slice(-27) : p;
    svg.append(t);
  });
  list.forEach((p, i) => {
    const t = mk('text', {
      x: label + i * cell + 12,
      y: label - 6,
      'text-anchor': 'end',
      fill: 'var(--fg-2)',
      transform: `rotate(-90 ${label + i * cell + 12} ${label - 6})`,
    });
    t.textContent = p.length > 28 ? '…' + p.slice(-27) : p;
    svg.append(t);
  });

  m.forEach((row, i) => {
    row.forEach((v, j) => {
      const rect = mk('rect', {
        x: label + j * cell,
        y: label + i * cell,
        width: cell - 1,
        height: cell - 1,
        fill: v ? sampleRamp('viridis', Math.sqrt(v / max)) : dark ? '#171c25' : '#e9edf4',
        'data-from': list[i],
        'data-to': list[j],
        'data-w': v,
        style: 'cursor:pointer',
      });
      if (i === j) rect.setAttribute('fill', dark ? '#2a3140' : '#d5dbe6');
      rect.addEventListener('click', () => {
        matrixSel = { from: list[i], to: list[j] };
        renderDependencies(store.state);
      });
      rect.addEventListener('mouseenter', () => {
        const tip = document.getElementById('tooltip')!;
        tip.innerHTML =
          `<div class="tt-title">${esc(list[i])}</div>` +
          `<div class="tt-path">→ ${esc(list[j])}</div>` +
          `<table><tr><td>${msg("class refs")}</td><td>${v}</td></tr><tr><td>${msg("share of row")}</td><td>${((v / Math.max(1, row.reduce((a, b) => a + b, 0))) * 100).toFixed(1)}%</td></tr></table>`;
        tip.hidden = false;
        const wrapRect = wrap.getBoundingClientRect();
        tip.style.left = `${Math.min(wrapRect.width - 480, 220)}px`;
        tip.style.top = `80px`;
      });
      rect.addEventListener('mouseleave', () => {
        document.getElementById('tooltip')!.hidden = true;
      });
      svg.append(rect);
    });
  });
  panel.append(
    h('h3', { text: msg("Package adjacency matrix · top {0} packages", list.length) }),
    h('div', { class: 'sub', text: msg("row = importing package, column = imported package, cell = number of class-level references (max {0}). Click a cell for the class edges.", max) })
  );
  const holder = h('div', { style: { overflow: 'auto', maxHeight: 'calc(100vh - 190px)' } });
  holder.append(svg);
  panel.append(holder);
  if (matrixSel) panel.append(classEdgesFor(matrixSel.from, matrixSel.to));
  return panel;
}

function classEdgePane(state: AppState): HTMLElement {
  const sel = matrixSel ?? (state.selection.packagePath ? { from: state.selection.packagePath, to: '' } : null);
  const panel = h('div', { class: 'card' });
  if (!sel) {
    panel.append(h('h3', { text: msg("Class-level edges") }), h('div', { class: 'empty', text: msg("Pick two packages in the matrix first.") }));
    return panel;
  }
  panel.append(h('h3', { text: msg("Class-level edges") }));
  panel.append(classEdgesFor(sel.from, sel.to));
  return panel;
}

/**
 * The member-level edges behind one class pair.
 *
 * A class-level edge is a number: 340 references between two types says nothing
 * about which method calls which. Expanding a row loads both packages'
 * reference shards and lists the caller/callee pairs, heaviest first. A bundle
 * without the reference layer says so instead of showing an empty list.
 */
function memberEdgesFor(a: ClassRec, b: ClassRec, host: HTMLElement, caret: HTMLButtonElement) {
  if (host.childElementCount) {
    host.replaceChildren();
    caret.textContent = '▸';
    caret.setAttribute('aria-expanded', 'false');
    return;
  }
  caret.textContent = '▾';
  caret.setAttribute('aria-expanded', 'true');
  host.replaceChildren(h('div', { class: 'empty', text: msg("loading member edges…") }));
  const fail = (message: string) => host.replaceChildren(h('div', { class: 'empty', text: message }));

  Promise.all([loadRefShard('data', a.pkg), loadRefShard('data', b.pkg)])
    .then(([fromShard, toShard]) => {
      const fromMembers = fromShard.get(a.id);
      const toMembers = toShard.get(b.id);
      if (!fromMembers) return fail(msg("No member-level edges recorded for this pair."));
      const edges: [string, string, number, number][] = [];
      for (const member of fromMembers.values()) {
        for (const row of member.out ?? []) {
          if (row[0] !== b.id) continue;
          // The target member is unknown when the reference resolved to the
          // class only; the kind still says what it was (call/read/write/new).
          edges.push([member.name, toMembers?.get(row[1])?.name ?? REF_KINDS[row[2]], row[3], row[4]?.[0] ?? 0]);
        }
      }
      if (!edges.length) return fail(msg("No member-level edges recorded for this pair."));
      edges.sort((x, y) => y[2] - x[2]);
      const list = h('div', { class: 'link-list member-edges' });
      for (const [caller, callee, count, line] of edges.slice(0, 40)) {
        list.append(
          h(
            'div',
            {
              class: 'link',
              'data-refs': 'row',
              title: `${a.fqn}.${caller} → ${b.fqn}.${callee}`,
              onclick: () =>
                store.update((s) => {
                  s.selection.classId = a.id;
                }),
            },
            h('span', { class: 'nm', text: `${caller} → ${callee}` }),
            h('span', { class: 'sub', text: `×${count}${line ? ` · ${msg("line {0}", line)}` : ''}` })
          )
        );
      }
      host.replaceChildren(list);
    })
    .catch(() => fail(msg("Member-level edges are not in this bundle.")));
}

/** Load class edges lazily and render the ones between two packages. */
let classDepsCache: { from: number; to: number; w: number }[] | null = null;
function classEdgesFor(from: string, to: string): HTMLElement {
  const box = h('div');
  box.append(h('div', { class: 'empty', text: msg("loading class edges…") }));
  const draw = (rows: { from: number; to: number; w: number }[]) => {
    const filtered = rows
      .filter((e) => atlas!.byId[e.from]?.pkg === from && (!to || atlas!.byId[e.to]?.pkg === to))
      .sort((a, b) => b.w - a.w)
      .slice(0, 120);
    box.replaceChildren();
    if (!filtered.length) {
      box.append(h('div', { class: 'empty', text: msg("No class-level edges recorded for this pair.") }));
      return;
    }
    const list = h('div', { class: 'link-list' });
    for (const e of filtered) {
      const a = atlas!.byId[e.from];
      const b = atlas!.byId[e.to];
      if (!a || !b) continue;
      const host = h('div', { class: 'member-edge-host' });
      const caret = h('button', {
        class: 'caret',
        'aria-expanded': 'false',
        title: msg("Show member-level edges"),
        text: '▸',
        onclick: (ev: Event) => {
          ev.stopPropagation();
          memberEdgesFor(a, b, host, caret);
        },
      });
      list.append(
        h(
          'div',
          { class: 'edge-item' },
          h(
            'div',
            {
              class: 'link',
              onclick: () =>
                store.update((s) => {
                  s.selection.classId = a.id;
                }),
            },
            caret,
            h('span', { class: 'nm', text: a.name }),
            h('span', { style: { color: 'var(--fg-3)' }, text: ' → ' }),
            h('span', { class: 'nm', text: b.name }),
            h('span', { class: 'sub', text: `×${e.w}` })
          ),
          host
        )
      );
    }
    box.append(list);
  };
  if (classDepsCache) {
    draw(classDepsCache);
  } else {
    loadClassDeps('data').then((rows) => {
      classDepsCache = rows;
      draw(rows);
    });
  }
  return box;
}

/** --------------------------------------------------------------- panel ---- */

export function dependenciesControls(state: AppState): HTMLElement {
  const mode = state.depMode;
  return h(
    'div',
    { class: 'graph-controls' },
    h('button', { text: '−', title: msg("Zoom out"), onclick: () => zoomBy(1 / 1.4) }),
    h('button', { text: '+', title: msg("Zoom in"), onclick: () => zoomBy(1.4) }),
    h('button', { text: msg("Fit"), title: msg("Fit the whole graph"), onclick: () => fitView() }),
    h(
      'div',
      { class: 'toggle-group' },
      ...(['graph', 'matrix', 'classes'] as const).map((m) =>
        h('button', {
          class: mode === m ? 'on' : '',
          text: trLabel(m),
          onclick: () => setDepMode(m),
        })
      )
    ),
    h('label', { class: 'chk' }, msg("top"), h('input', {
      type: 'number',
      min: '10',
      max: '270',
      value: String(topN),
      style: { width: '62px' },
      onchange: (e: Event) => {
        topN = Math.max(6, Math.min(270, Number((e.target as HTMLInputElement).value)));
        renderDependencies(store.state);
      },
    })),
    h('label', { class: 'chk' }, msg("min refs"), h('input', {
      type: 'number',
      min: '1',
      value: String(minWeight),
      style: { width: '56px' },
      onchange: (e: Event) => {
        minWeight = Math.max(1, Number((e.target as HTMLInputElement).value));
        renderDependencies(store.state);
      },
    })),
    h(
      'label',
      { class: 'chk' },
      h('input', {
        type: 'checkbox',
        checked: onlyCrossDomain,
        onchange: (e: Event) => {
          onlyCrossDomain = (e.target as HTMLInputElement).checked;
          renderDependencies(store.state);
        },
      }),
      msg("cross-domain only")
    )
  );
}
