import { languageColor } from '../shared/languages.mjs';
import { msg, trLabel } from '../i18n';
/**
 * Treemap view — the Firefox "memory tree map" interaction model applied to a
 * Java code base.
 *
 *  - nested rectangles: packages (groups) → classes → members
 *  - click a group to zoom in, breadcrumbs / right-click / Esc to zoom out
 *  - hover for a full readout, click a leaf to select it in the inspector
 *  - size, colour, grouping, layout and labelling are all configurable
 *
 * Rendering is canvas-based so tens of thousands of rectangles stay smooth.
 */

import { hierarchy, treemap, treemapSquarify, treemapBinary, treemapSliceDice, treemapSlice } from 'd3-hierarchy';
import type { HierarchyRectangularNode } from 'd3-hierarchy';
import {
  type Atlas,
  type ClassRec,
  type MemberRec,
  KIND_COLORS,
  KIND_NAMES,
  metricValue,
  pkgMetricValue,
  loadMembers,
} from '../domain';
import { applyFilters, store, type AppState, type Settings, type ColorMode } from '../state';
import { fmtBytes, fmtCompact, fmtInt, fitText, hashCode, lighten, pct, rgba, sampleRamp, esc } from '../util';

export interface TNode {
  id: string;
  name: string;
  kind: 'root' | 'group' | 'class' | 'member';
  /** group kind label, e.g. package / domain / stereotype */
  groupType?: string;
  classId?: number;
  pkg?: string;
  member?: MemberRec;
  children?: TNode[];
  /** intrinsic weight for leaves; groups get summed by d3 */
  value: number;
  /** display aggregates, filled in after layout */
  agg?: { code: number; types: number; complexity: number; lua: number; methods: number };
}

type RNode = HierarchyRectangularNode<TNode>;

const atlas_max = (a: Atlas, k: string): number => a.max[k] ?? 1;

/** A label is worth drawing only when it still says something. */
const isReadable = (label: string): boolean =>
  label.length >= 4 && !(label.endsWith('…') && label.length < 7);

const TILE: Record<string, (a: unknown) => unknown> = {
  squarify: treemapSquarify as never,
  sliceDice: treemapSliceDice as never,
  binary: treemapBinary as never,
  // Plain `treemapSlice`: horizontal strips. (d3's `treemapResquarify` is a
  // *stable-update* variant of squarify — on a freshly built hierarchy it
  // reproduces the squarified layout exactly, so it is not a distinct tile.)
  strip: treemapSlice as never,
};

export class TreemapView {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private wrap: HTMLElement;
  private atlas: Atlas | null = null;
  private nodes: RNode[] = [];
  private leaves: RNode[] = [];
  private root: RNode | null = null;
  private tree: TNode | null = null;
  private dpr = 1;
  private w = 0;
  private h = 0;
  private dirty = true;
  private builtFor = '';
  private memberNames = new Map<number, string[]>();
  private memberLists = new Map<number, MemberRec[]>();
  private hover: RNode | null = null;
  private selected: RNode | null = null;
  private onSelect: (n: TNode | null) => void;
  private onZoom: (path: string[]) => void;
  private tooltip: HTMLElement;
  private unsubscribe?: () => void;

  constructor(
    wrap: HTMLElement,
    opts: { onSelect: (n: TNode | null) => void; onZoom: (path: string[]) => void }
  ) {
    this.wrap = wrap;
    this.canvas = wrap.querySelector('canvas')!;
    this.ctx = this.canvas.getContext('2d')!;
    this.tooltip = wrap.querySelector('#tooltip') as HTMLElement;
    this.onSelect = opts.onSelect;
    this.onZoom = opts.onZoom;
    this.bindEvents();
    this.resize();
  }

  /** ------------------------------------------------------------------ API */

  setData(atlas: Atlas) {
    this.atlas = atlas;
  }

  update(state: AppState) {
    this.atlas = state.atlas ?? this.atlas;
    if (!this.atlas) return;
    const key = this.buildKey(state);
    const lkey = this.layoutKey(state);
    if (key !== this.builtFor) {
      this.build(state);
      this.builtFor = key;
      this.appliedLayoutKey = lkey;
    } else if (lkey !== this.appliedLayoutKey) {
      // The tree itself is unchanged, but how it is tiled is not: re-run the
      // layout without rebuilding the hierarchy. This covers the tiling
      // algorithm, padding, the small-node cull and the zoom path.
      this.layout(state);
    }
    this.dirty = true;
  }

  /** Everything that changes the tiling but not the tree. */
  private layoutKey(s: AppState): string {
    return [s.settings.layout, s.settings.padding, s.settings.minShare, s.selection.zoom.join('|')].join('|');
  }

  private appliedLayoutKey = '';

  /** True when the current filters leave nothing to draw. */
  get isEmpty(): boolean {
    return this.leaves.length === 0 && this.nodes.length === 0;
  }

  /** Force a rebuild (member shards finished loading, etc.). */
  invalidate() {
    this.builtFor = '';
    this.dirty = true;
  }

  resize() {
    const r = this.wrap.getBoundingClientRect();
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.w = Math.max(1, Math.floor(r.width));
    this.h = Math.max(1, Math.floor(r.height));
    this.canvas.width = Math.floor(this.w * this.dpr);
    this.canvas.height = Math.floor(this.h * this.dpr);
    this.canvas.style.width = this.w + 'px';
    this.canvas.style.height = this.h + 'px';
    this.dirty = true;
  }

  frame() {
    if (!this.dirty) return;
    this.dirty = false;
    this.draw();
  }

  destroy() {
    this.unsubscribe?.();
  }

  /** ---------------------------------------------------------------- build */

  private buildKey(s: AppState): string {
    const f = s.settings.filters;
    return [
      s.settings.groupBy,
      s.settings.sizeMetric,
      JSON.stringify(s.settings.weights),
      s.settings.showMembers,
      s.settings.depthLimit,
      s.settings.sort,
      f.query,
      f.kinds.join(','),
      f.languages.join(','),
      f.stereotypes.join(','),
      f.domains.join(','),
      f.luaOnly ? 1 : 0,
      f.minCode,
      this.memberLists.size,
      this.atlas?.classes.length ?? 0,
    ].join('|');
  }

  private build(state: AppState) {
    const atlas = this.atlas!;
    const s = state.settings;
    const allowed = this.allowedIds(state);
    const byId = atlas.byId;

    const classNode = (c: ClassRec): TNode => {
      const n: TNode = {
        id: `c:${c.id}`,
        name: c.name,
        kind: 'class',
        classId: c.id,
        pkg: c.pkg,
        value: this.leafWeight(c, s),
      };
      if (s.showMembers) {
        const mem = this.memberLists.get(c.id);
        if (mem && mem.length) {
          const kids: TNode[] = mem
            .filter((m) => m.kind !== 'field' || m.complexity === 0)
            .map((m, i) => ({
              id: `m:${c.id}:${i}`,
              name: m.name,
              kind: 'member' as const,
              classId: c.id,
              pkg: c.pkg,
              member: m,
              value: Math.max(1, m.bodyLines || m.complexity || 1),
            }));
          if (kids.length) n.children = kids;
        }
      }
      return n;
    };

    const group = (id: string, name: string, groupType: string, children: TNode[]): TNode => ({
      id,
      name,
      kind: 'group',
      groupType,
      children,
      value: 0,
    });

    const root: TNode = { id: 'root', name: atlas.meta.sourceRoot, kind: 'root', children: [], value: 0 };

    const sorter = (a: TNode, b: TNode) => {
      switch (s.sort) {
        case 'name': return a.name.localeCompare(b.name);
        case 'fanIn': return (this.cls(b)?.fanIn ?? 0) - (this.cls(a)?.fanIn ?? 0);
        case 'complexity': return (this.cls(b)?.complexity ?? 0) - (this.cls(a)?.complexity ?? 0);
        default: return 0; // d3 sizes decide
      }
    };

    const ids = [...allowed].map((id) => byId[id]).filter(Boolean);

    if (s.groupBy === 'package') {
      // Build package groups only for branches that contain allowed classes.
      const needed = new Set<string>();
      for (const c of ids) {
        const parts = c.pkg.split('.');
        for (let i = 1; i <= parts.length; i++) {
          if (s.depthLimit && i > s.depthLimit) break;
          needed.add(parts.slice(0, i).join('.'));
        }
        if (s.depthLimit === 0) needed.add(c.pkg);
      }
      const fileNodes = new Map<string, TNode>();
      const nodeFor = new Map<string, TNode>();
      for (const path of [...needed].sort()) {
        const node = group(`p:${path}`, path.split('.').pop()!, 'package', []);
        node.pkg = path;
        nodeFor.set(path, node);
        const parentPath = path.includes('.') ? path.slice(0, path.lastIndexOf('.')) : '';
        const parent = parentPath && nodeFor.has(parentPath) ? nodeFor.get(parentPath)! : root;
        (parent.children ??= []).push(node);
      }
      for (const c of ids) {
        // attach to the deepest existing ancestor package
        const parts = c.pkg.split('.');
        let target: TNode | undefined;
        for (let i = parts.length; i >= 1; i--) {
          const p = parts.slice(0, i).join('.');
          if (nodeFor.has(p)) {
            target = nodeFor.get(p);
            break;
          }
        }
        if (c.language && c.language !== 'java') {
          let fileNode = fileNodes.get(c.path);
          if (!fileNode) {
            fileNode = group(`f:${c.path}`, c.path.split('/').pop()!, 'file', []);
            fileNode.classId = atlas.byPath.get(c.path)?.find((entity) => entity.kind === 5)?.id;
            fileNode.pkg = c.pkg;
            fileNodes.set(c.path, fileNode);
            (target ?? root).children!.push(fileNode);
          }
          const leaf = classNode(c);
          if (c.kind === 5) leaf.name = msg('Top-level code');
          fileNode.children!.push(leaf);
        } else (target ?? root).children!.push(classNode(c));
      }
    } else if (s.groupBy === 'domain') {
      const map = new Map<string, TNode>();
      for (const c of ids) {
        let g = map.get(c.domain);
        if (!g) {
          g = group(`dom:${c.domain}`, c.domain, 'domain', []);
          g.pkg = c.domain;
          map.set(c.domain, g);
          root.children!.push(g);
        }
        g.children!.push(classNode(c));
      }
    } else if (s.groupBy === 'stereotype' || s.groupBy === 'kind') {
      const map = new Map<string, TNode>();
      for (const c of ids) {
        const key = s.groupBy === 'kind' ? KIND_NAMES[c.kind] : c.stereotype;
        const id = `${s.groupBy === 'kind' ? 'k' : 'st'}:${key}`;
        let g = map.get(key);
        if (!g) {
          g = group(id, trLabel(key), s.groupBy, []);
          map.set(key, g);
          root.children!.push(g);
        }
        g.children!.push(classNode(c));
      }
    } else {
      // stereotype → top-level package → class
      const map = new Map<string, TNode>();
      for (const c of ids) {
        let g = map.get(c.stereotype);
        if (!g) {
          g = group(`st:${c.stereotype}`, trLabel(c.stereotype), 'stereotype', []);
          map.set(c.stereotype, g);
          root.children!.push(g);
        }
        let sub = (g.children ??= []).find((n) => n.id === `dom:${c.domain}`);
        if (!sub) {
          sub = group(`dom:${c.domain}`, c.domain, 'domain', []);
          sub.pkg = c.domain;
          g.children!.push(sub);
        }
        sub.children!.push(classNode(c));
      }
    }

    // prune empties, sort, and cull
    const prune = (n: TNode): TNode | null => {
      if (n.children) {
        n.children = n.children.map(prune).filter(Boolean) as TNode[];
        if (!n.children.length && n.kind !== 'root') return null;
      }
      return n;
    };
    prune(root);
    if (s.sort !== 'size') {
      const sortRec = (n: TNode) => {
        if (n.children) {
          n.children.sort(sorter);
          n.children.forEach(sortRec);
        }
      };
      sortRec(root);
    }

    this.tree = root;
    this.layout(state);
  }

  private allowedIds(state: AppState): Set<number> {
    return applyFilters(this.atlas!, state.settings, this.memberNames).ids;
  }

  private leafWeight(c: ClassRec, s: Settings): number {
    if (s.sizeMetric === 'composite') {
      let v = 0;
      let any = false;
      for (const [k, w] of Object.entries(s.weights)) {
        if (!w) continue;
        any = true;
        const max = this.atlas!.max[k] ?? 1;
        v += (metricValue(c, k) / max) * w;
      }
      return any ? Math.max(0.0001, v) : Math.max(1, c.code);
    }
    return Math.max(0, metricValue(c, s.sizeMetric));
  }

  private cls(n: RNode | TNode): ClassRec | null {
    const id = ((n as RNode).data ?? (n as TNode)).classId;
    return id != null ? this.atlas!.byId[id] : null;
  }

  /** ---------------------------------------------------------------- layout */

  private layout(state: AppState) {
    if (!this.tree) return;
    const s = state.settings;
    const zoom = state.selection.zoom;
    this.appliedLayoutKey = this.layoutKey(state);

    // Walk the data tree to the subtree that should fill the viewport. Only
    // the ids that actually matched are kept as the zoom in effect: a path can
    // name a node that is not on the way down (a permalink from an older
    // bundle, or a path built relative to an already-zoomed view), and every
    // navigation that starts from here — double-click, Up — has to start from
    // what is really on screen.
    let target: TNode = this.tree;
    const applied: string[] = [];
    for (const id of zoom) {
      const next = (target.children ?? []).find((c) => c.id === id);
      if (!next) break;
      target = next;
      applied.push(id);
    }
    this.currentZoom = applied;

    // The layout must be handed a *fresh root*: d3's treemap indexes its
    // padding stack by absolute `node.depth`, so laying out a node that already
    // sits at depth N would produce NaN rectangles.
    const h = hierarchy<TNode>(target).sum((d) =>
      d.children && d.children.length ? 0 : Math.max(0, d.value)
    );
    let total = h.value || 1;
    if (s.minShare > 0) {
      const min = total * s.minShare;
      h.each((n) => {
        if (n.children) n.children = n.children.filter((c) => (c.value ?? 0) >= min || (c.children?.length ?? 0) > 0);
      });
      total = h.value || 1;
    }

    const pad = Math.max(0, s.padding);
    const tile = TILE[s.layout] ?? treemapSquarify;
    treemap<TNode>()
      .tile(tile as never)
      .size([this.w, this.h])
      .paddingOuter((d) => (d.depth === 0 ? 0 : pad))
      .paddingInner((d) => (d.depth === 0 ? 0 : pad))
      .paddingTop((d) => (d.children && d.children.length && d.depth > 0 ? 15 + pad : pad))
      .round(true)(h);

    this.root = h as unknown as RNode;
    this.zoomRoot = this.root;
    const rect = h as unknown as RNode;
    this.nodes = rect.descendants().filter((n) => n !== rect);
    this.leaves = rect.leaves().filter((n) => n !== rect);
    this.aggregate(rect);
    this.dirty = true;
  }

  /** root of the currently laid-out (possibly zoomed) hierarchy */
  private zoomRoot: RNode | null = null;

  /** Sum display metrics bottom-up so group tooltips report live numbers. */
  private aggregate(root: RNode) {
    type Agg = NonNullable<TNode['agg']>;
    const walk = (n: RNode): Agg => {
      const childMetrics = (n.children ?? []).map((child) => walk(child as RNode));
      const c = this.cls(n);
      let agg: Agg;
      if (n.data.kind === 'class' && c) {
        agg = { code: c.code, types: 1, complexity: c.complexity, lua: c.luaExposed ? 1 : 0, methods: c.methods };
      } else if (n.data.kind === 'member' && n.data.member) {
        const member = n.data.member;
        agg = { code: member.bodyLines, types: 0, complexity: member.complexity, lua: 0, methods: member.kind === 'field' ? 0 : 1 };
      } else {
        agg = { code: 0, types: 0, complexity: 0, lua: 0, methods: 0 };
        for (const child of childMetrics) {
          agg.code += child.code;
          agg.types += child.types;
          agg.complexity += child.complexity;
          agg.lua += child.lua;
          agg.methods += child.methods;
        }
      }
      n.data.agg = agg;
      return agg;
    };
    walk(root);
  }

  /** ----------------------------------------------------------------- draw */

  private draw() {
    const ctx = this.ctx;
    const s = this.currentSettings;
    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);

    const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg-0').trim() || '#0b0e13';
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, this.w, this.h);
    if (!this.root || !s) {
      ctx.restore();
      return;
    }

    const base = this.zoomRoot ?? this.root;
    const baseDepth = base.depth;
    const q = s.filters.query.trim().toLowerCase();
    const dark = document.documentElement.dataset.theme !== 'light';
    const labelColor = dark ? '#eef3fa' : '#10141c';
    const subColor = dark ? 'rgba(255,255,255,0.72)' : 'rgba(0,0,0,0.62)';

    ctx.textBaseline = 'top';

    for (const n of this.nodes) {
      const d = n.data;
      const x = n.x0;
      const y = n.y0;
      const w = n.x1 - n.x0;
      const h = n.y1 - n.y0;
      if (w < 0.6 || h < 0.6) continue;

      const depth = n.depth - baseDepth;
      const isGroup = !!n.children?.length;
      const col = this.colorFor(n, s, depth, dark);
      const dim = q.length > 0 && !this.matches(n, q);

      ctx.globalAlpha = dim ? 0.25 : 1;
      ctx.fillStyle = col;

      if (isGroup) {
        // group = tinted backdrop, children are drawn on top
        ctx.fillStyle = dark ? rgba(col, 0.26) : rgba(col, 0.2);
        ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = rgba(col, dark ? 0.75 : 0.9);
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
        // header
        const headH = Math.min(15, h);
        if (h > 13 && w > 34) {
          ctx.fillStyle = rgba(col, dark ? 0.55 : 0.42);
          ctx.fillRect(x, y, w, headH);
          ctx.fillStyle = labelColor;
          ctx.font = `600 ${depth === 0 ? 11 : 10.5}px var(--font-ui), sans-serif`;
          const label = fitText(ctx, d.name, w - 8);
          if (isReadable(label)) {
            ctx.fillText(label, x + 4, y + 2.5);
            if (w > 150 && d.agg) {
              const used = ctx.measureText(label).width;
              ctx.font = `10px var(--font-mono), monospace`;
              ctx.fillStyle = subColor;
              const extra = msg("{0} types · {1} ln", d.agg.types, fmtCompact(d.agg.code));
              if (w - used > ctx.measureText(extra).width + 18) ctx.fillText(extra, x + 8 + used, y + 3.5);
            }
          }
        }
      } else {
        ctx.fillRect(x, y, w, h);
        // subtle depth shading so nested leaves read as distinct
        ctx.fillStyle = dark ? 'rgba(255,255,255,0.045)' : 'rgba(0,0,0,0.03)';
        ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = dark ? 'rgba(0,0,0,0.45)' : 'rgba(255,255,255,0.7)';
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
      }

      // ---- selected / hover outlines
      const isHover = this.hover === n;
      const isSel = d.classId != null && d.classId === this.selectedClassId;
      if (isHover || isSel) {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = dark ? '#ffffff' : '#000000';
        ctx.lineWidth = isSel ? 2 : 1.5;
        ctx.strokeRect(x + 1, y + 1, Math.max(0, w - 2), Math.max(0, h - 2));
      }

      // ---- leaf label
      if (!isGroup && s.labelMode !== 'never' && h > 11 && w > 30 && (s.labelMode === 'always' || depth <= 2 || h > 22)) {
        ctx.globalAlpha = dim ? 0.3 : 1;
        const fs = h > 34 && w > 90 ? 12 : 10.5;
        ctx.font = `600 ${fs}px var(--font-ui), sans-serif`;
        ctx.fillStyle = labelColor;
        const label = fitText(ctx, d.name, w - 8);
        if (isReadable(label)) {
          ctx.fillText(label, x + 4, y + 3);
          if (h > 26 && w > 70) {
            const c = this.cls(n);
            if (c) {
              ctx.font = `10px var(--font-mono), monospace`;
              ctx.fillStyle = subColor;
              const line = msg("{0} ln · {1}m", fmtCompact(c.code), c.methods);
              if (ctx.measureText(line).width < w - 10) ctx.fillText(line, x + 4, y + 4 + fs + 2);
            }
          }
        }
      }
      ctx.globalAlpha = 1;
    }

    // zoom-root frame
    if (base !== this.root) {
      ctx.strokeStyle = dark ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.25)';
      ctx.lineWidth = 1;
      ctx.strokeRect(0.5, 0.5, this.w - 1, this.h - 1);
    }
    ctx.restore();
  }

  private matches(n: RNode, q: string): boolean {
    let cur: RNode | null = n;
    while (cur) {
      const d = cur.data;
      if (d.name.toLowerCase().includes(q)) return true;
      const c = this.cls(cur);
      if (c && `${c.name} ${c.fqn} ${c.stereotype}`.toLowerCase().includes(q)) return true;
      if (d.member && d.member.name.toLowerCase().includes(q)) return true;
      cur = cur.parent as RNode | null;
    }
    return false;
  }

  private currentSettings: Settings | null = null;
  private selectedClassId: number | null = null;

  setSettings(s: Settings, selectedClassId: number | null) {
    this.currentSettings = s;
    this.selectedClassId = selectedClassId;
    this.dirty = true;
  }

  /**
   * Colour of a node. Groups and leaves share the same rules so a package and
   * the types inside it stay visually related.
   */
  private colorFor(n: RNode, s: Settings, depth: number, dark: boolean): string {
    const d = n.data;
    const c = this.cls(n);
    const mode: ColorMode = s.colorMode;
    const isGroup = d.kind === 'group' || d.kind === 'root';

    if (d.kind === 'member') {
      const base = this.classColor(c, s, dark, n);
      return d.member?.kind === 'field' ? rgba(base, 0.72) : base;
    }

    if (mode === 'language') return isGroup ? this.groupColor(n, s, dark) : languageColor(c?.language ?? 'java');

    if (mode === 'kind') {
      return isGroup ? sampleRamp(s.palette, 0.35) : (dark ? KIND_COLORS.dark : KIND_COLORS.light)[c?.kind ?? 0];
    }

    if (mode === 'lua') {
      if (isGroup) return this.groupColor(n, s, dark);
      return c?.luaExposed ? '#c586c0' : dark ? '#39414f' : '#cfd6e2';
    }

    if (mode === 'fanIn' || mode === 'fanOut' || mode === 'complexity' || mode === 'density') {
      const v = isGroup ? (d.agg ? d.agg.complexity : 0) : c ? metricValue(c, mode) : 0;
      const max = atlas_max(this.atlas!, mode) || 1;
      const t = Math.min(1, Math.sqrt(v / max));
      return sampleRamp(s.palette, isGroup ? t * 0.7 : t);
    }

    if (mode === 'depth') {
      return sampleRamp(s.palette, Math.min(1, (n.depth - (this.zoomRoot?.depth ?? 0)) / 5));
    }

    return isGroup ? this.groupColor(n, s, dark) : this.classColor(c, s, dark, n);
  }

  /** Colour of the functional domain a package path belongs to. */
  private domainColorOf(path: string): string | null {
    const atlas = this.atlas!;
    const key = atlas.pkgDomain.get(path) ?? path.split('.')[0];
    return atlas.domains.find((x) => x.key === key)?.color ?? null;
  }

  /**
   * Group colour. In domain mode every nested package keeps its domain hue but
   * steps lighter with depth; in package mode each package gets its own ramp
   * position so siblings are easy to tell apart.
   */
  private groupColor(n: RNode, s: Settings, dark: boolean): string {
    const d = n.data;
    const key = d.pkg ?? d.name;
    const base = this.domainColorOf(key);
    if (s.colorMode === 'language') {
      const languages = new Set(n.descendants().map((node) => this.cls(node)?.language).filter(Boolean));
      return languages.size === 1 ? languageColor([...languages][0]!) : dark ? '#39414f' : '#cfd6e2';
    }
    if (s.colorMode === 'package') {
      const depth = this.packageDepthOf(key);
      const own = sampleRamp(s.palette, (hashCode(key) % 100) / 100);
      return depth <= 1 ? base ?? own : lighten(own, Math.min(0.3, (depth - 1) * 0.08));
    }
    if (!base) return sampleRamp(s.palette, (hashCode(d.name) % 100) / 100);
    const step = Math.max(0, n.depth - (this.zoomRoot?.depth ?? 0) - 1);
    return step === 0 ? base : lighten(base, Math.min(0.5, step * 0.12));
  }

  private packageDepthOf(path: string): number {
    const root = this.atlas!.packageRoot;
    const parts = path.split('.');
    return root && parts[0] === root ? parts.length - 1 : parts.length;
  }

  private classColor(c: ClassRec | null, s: Settings, dark: boolean, n?: RNode): string {
    const atlas = this.atlas!;
    const mode = s.colorMode;
    if (c && s.colorMode === 'language') return languageColor(c.language ?? 'java');
    if (!c) return sampleRamp(s.palette, 0.3);
    if (mode === 'kind') return (dark ? KIND_COLORS.dark : KIND_COLORS.light)[c.kind];
    if (mode === 'stereotype') return sampleRamp(s.palette, (hashCode(c.stereotype) % 100) / 100);
    if (mode === 'lua') return c.luaExposed ? '#c586c0' : dark ? '#39414f' : '#cfd6e2';
    if (mode === 'fanIn' || mode === 'fanOut' || mode === 'complexity' || mode === 'density') {
      return sampleRamp(s.palette, Math.min(1, Math.sqrt(metricValue(c, mode) / (atlas.max[mode] || 1))));
    }
    if (mode === 'depth') return sampleRamp(s.palette, Math.min(1, (n?.depth ?? 0) / 5));
    if (mode === 'package') {
      const own = sampleRamp(s.palette, (hashCode(c.pkg) % 100) / 100);
      const depth = this.packageDepthOf(c.pkg);
      return depth <= 1 ? this.domainColorOf(c.pkg) ?? own : lighten(own, Math.min(0.3, (depth - 1) * 0.08));
    }
    // domain (default)
    return this.domainColorOf(c.pkg) ?? '#6e9efe';
  }

  /** -------------------------------------------------------------- pointer */

  private nodeAt(px: number, py: number): RNode | null {
    // deepest node containing the point; children are drawn after parents
    let best: RNode | null = null;
    for (const n of this.nodes) {
      if (px >= n.x0 && px < n.x1 && py >= n.y0 && py < n.y1) {
        if (!best || n.depth >= best.depth) best = n;
      }
    }
    return best;
  }

  private bindEvents() {
    const cv = this.canvas;

    // The treemap and the dependency graph share one <canvas> and one tooltip
    // element, so every handler must check that the treemap is the active view.
    // Without this, dragging the package graph still ran the treemap's hit test
    // against its stale rectangles: it popped a class tooltip under the cursor,
    // and a click would silently reselect a type in the inspector.
    const inactive = () => store.state.view !== 'treemap';

    cv.addEventListener('mousemove', (e) => {
      if (inactive()) return;
      const r = cv.getBoundingClientRect();
      const n = this.nodeAt(e.clientX - r.left, e.clientY - r.top);
      if (n !== this.hover) {
        this.hover = n;
        this.dirty = true;
        this.onHoverChange?.(n?.data ?? null);
      }
      if (n) this.showTooltip(n, e.clientX - r.left, e.clientY - r.top);
      else this.hideTooltip();
      cv.style.cursor = n ? (n.children?.length ? 'zoom-in' : 'pointer') : 'default';
    });

    cv.addEventListener('mouseleave', () => {
      if (inactive()) return;
      this.hover = null;
      this.hideTooltip();
      this.onHoverChange?.(null);
      this.dirty = true;
    });

    cv.addEventListener('click', (e) => {
      if (inactive()) return;
      const r = cv.getBoundingClientRect();
      const n = this.nodeAt(e.clientX - r.left, e.clientY - r.top);
      if (!n) {
        this.onSelect(null);
        return;
      }
      if (n.data.kind === 'class') {
        const id = n.data.classId!;
        this.onSelect(n.data);
      } else if (n.children?.length) {
        // single click on a group selects the group, double click zooms
        this.onSelect(n.data);
      }
    });

    cv.addEventListener('dblclick', (e) => {
      if (inactive()) return;
      const r = cv.getBoundingClientRect();
      const n = this.nodeAt(e.clientX - r.left, e.clientY - r.top);
      if (n && n.children?.length) this.zoomTo(n);
      else if (n?.data.classId != null) this.onSelect(n.data);
    });

    cv.addEventListener('contextmenu', (e) => {
      if (inactive()) return;
      e.preventDefault();
      this.zoomOut();
    });

  }

  onHoverChange: ((n: TNode | null) => void) | null = null;

  /**
   * Zoom into a node of the layout currently on screen.
   *
   * The node belongs to the zoomed subtree, so walking up to `this.root` only
   * yields the last leg of the journey. It has to be appended to the zoom
   * already in effect: `selection.zoom` is an absolute path that is re-resolved
   * from the full tree on every layout, so emitting the leg on its own names a
   * group that is not a child of the root — the walk stops at the first id and
   * the map snaps back to the root instead of zooming in.
   */
  zoomTo(n: RNode) {
    const leg: string[] = [];
    let cur: RNode | null = n;
    while (cur && cur !== this.root) {
      leg.unshift(cur.data.id);
      cur = cur.parent as RNode | null;
    }
    if (cur !== this.root) return; // not part of the laid-out tree
    this.onZoom([...this.currentZoom, ...leg]);
  }

  zoomUp() {
    this.onZoom(this.currentZoom.slice(0, -1));
  }

  zoomOut() {
    this.onZoom([]);
  }

  /**
   * Zoom path in effect — the prefix of the requested path that resolved
   * against the tree, rewritten by `layout()` on every pass.
   */
  private currentZoom: string[] = [];

  /** Apply a zoom path coming from the store (also used by breadcrumbs). */
  setZoom(path: string[]) {
    this.currentZoom = path;
  }

  /** Expose the laid-out node for a class id (used to sync selection). */
  nodeForClass(id: number): RNode | null {
    return this.nodes.find((n) => n.data.classId === id) ?? null;
  }

  focusClass(id: number): boolean {
    const n = this.nodeForClass(id);
    if (!n) return false;
    this.selectedClassId = id;
    this.dirty = true;
    return true;
  }

  /** ------------------------------------------------------------- tooltip */

  private showTooltip(n: RNode, px: number, py: number) {
    const d = n.data;
    const c = this.cls(n);
    const atlas = this.atlas!;
    const parts: string[] = [];
    parts.push(`<div class="tt-title">${esc(d.kind === 'member' ? `${d.member?.name}` : d.name)}</div>`);
    const path =
      c != null
        ? `${c.fqn}${d.kind === 'member' ? msg(" · line {0}", d.member?.line) : msg(" · line {0}", c.declLine)}`
        : d.pkg ?? d.id.replace(/^[a-z]+:/, '');
    parts.push(`<div class="tt-path">${esc(path)}</div>`);

    const rows: [string, string][] = [];
    if (c && d.kind !== 'member') {
      rows.push([msg("kind"), `${trLabel(KIND_NAMES[c.kind])} · ${trLabel(c.stereotype)}`]);
      rows.push([msg("code"), msg("{0} lines", fmtInt(c.code))]);
      if (c.comment) rows.push([msg("comments"), fmtInt(c.comment)]);
      rows.push([msg("members"), msg("{0} methods · {1} fields", c.methods, c.fields)]);
      rows.push([msg("complexity"), fmtInt(c.complexity)]);
      rows.push([msg("fan-in / out"), `${c.fanIn} / ${c.fanOut}`]);
      if (c.luaExposed) rows.push([msg("lua"), `${c.annotations.join(', ') || msg("exposed")}`]);
      if (c.enumConstants) rows.push([msg("constants"), String(c.enumConstants)]);
      rows.push([msg("size on map"), pct((n.value ?? 0) / (this.root?.value || 1))]);
    } else if (d.kind === 'member' && d.member) {
      const m = d.member;
      rows.push([msg("signature"), `${m.type || ''} ${m.name}(${m.params.join(', ')})`.trim()]);
      rows.push([msg("line"), String(m.line)]);
      rows.push([msg("modifiers"), m.modifiers || '—']);
      if (m.kind === 'method') rows.push([msg("complexity"), String(m.complexity)]);
      if (m.annotations.length) rows.push([msg("annotations"), m.annotations.join(', ')]);
    } else if (d.agg) {
      rows.push([msg("types"), fmtInt(d.agg.types)]);
      rows.push([msg("code"), msg("{0} lines", fmtInt(d.agg.code))]);
      rows.push([msg("methods"), fmtInt(d.agg.methods)]);
      rows.push([msg("complexity"), fmtInt(d.agg.complexity)]);
      rows.push([msg("lua-exposed"), String(d.agg.lua)]);
      rows.push([msg("share"), pct((n.value ?? 0) / (this.root?.value || 1))]);
    }
    parts.push(
      `<table>${rows
        .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`)
        .join('')}</table>`
    );
    if (c?.doc) parts.push(`<div class="tt-doc">${esc(c.doc.split('\n').slice(0, 4).join(' '))}</div>`);

    this.tooltip.innerHTML = parts.join('');
    this.tooltip.hidden = false;
    const tw = this.tooltip.offsetWidth;
    const th = this.tooltip.offsetHeight;
    this.tooltip.style.left = `${Math.max(4, Math.min(this.w - tw - 4, px + 14))}px`;
    this.tooltip.style.top = `${Math.max(4, Math.min(this.h - th - 4, py + 16))}px`;
  }

  private hideTooltip() {
    this.tooltip.hidden = true;
  }

  /** Load member shards for the packages currently in play (for search + member level). */
  async ensureMembers(state: AppState) {
    const atlas = this.atlas;
    if (!atlas) return false;
    const need = new Set<string>();
    const f = state.settings.filters;
    const wantsMembers = state.settings.showMembers || f.query.trim().length > 1;
    if (!wantsMembers) return false;
    const zoomPkg = state.selection.zoom.filter((z) => z.startsWith('p:')).at(-1)?.slice(2);
    if (state.settings.showMembers) {
      if (zoomPkg) need.add(zoomPkg);
      else {
        // only the largest packages, to keep the member level responsive
        const top = [...atlas.pkgByPath.values()]
          .filter((p) => p.ownIds.length)
          .sort((a, b) => (b.metrics?.code ?? 0) - (a.metrics?.code ?? 0))
          .slice(0, 12);
        for (const p of top) need.add(p.path);
      }
    } else {
      for (const p of atlas.pkgByPath.keys()) need.add(p);
    }
    let loaded = false;
    await Promise.all(
      [...need].map(async (pkg) => {
        try {
          const m = await loadMembers('data', pkg);
          for (const [id, list] of m) {
            this.memberLists.set(id, list);
            this.memberNames.set(id, list.map((x) => x.name.toLowerCase()));
          }
          loaded = true;
        } catch {
          /* shard missing — ignore */
        }
      })
    );
    return loaded;
  }
}
