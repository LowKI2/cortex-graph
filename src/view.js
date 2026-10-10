import { ItemView, Menu, Modal, Setting, Notice, TFile, prepareFuzzySearch, setIcon, debounce, Platform, moment } from 'obsidian';
import { GraphRenderer } from './renderer';
import { buildGraph, assignColors, deepestFolderValue, importance, shortestPath, signature, heatOf, PROBLEM_COLORS } from './model';
import { t } from './i18n';
import SIM_SRC from './sim.worker.js';

export const VIEW_TYPE = 'cortex-graph-view';

export const STYLE_KEYS = ['center', 'repel', 'link', 'dist', 'range', 'nodeSize', 'degSize', 'glow', 'line', 'font', 'fontGrow', 'boldFrom', 'labelFrom', 'maxLabels', 'dimOthers', 'shapeSize', 'shapeGroup', 'hubPull', 'taper', 'taperBright', 'taperLen', 'nodeBright', 'nodeOpacity', 'shStern', 'shRaute', 'shQuadrat', 'shRing'];
const SHAPE_KEYS = new Set(['shStern', 'shRaute', 'shQuadrat', 'shRing']);
const FORCE_KEYS = new Set(['center', 'repel', 'link', 'dist', 'range', 'shapeSize', 'shapeGroup', 'hubPull']);
const PANEL = [
  ['secForces'], ['shapeSize', 0.4, 2.5, 0.05], ['shapeGroup', 0, 1, 0.05], ['hubPull', 0, 1, 0.05], ['center', 0, 5, 0.05], ['range', 60, 2000, 10], ['repel', 0, 20, 0.1], ['link', 0, 1, 0.01], ['dist', 8, 150, 1],
  ['secNodes'], ['nodeSize', 0.3, 3, 0.05], ['dimOthers', 0, 0.6, 0.01], ['degSize', 0, 3, 0.05], ['nodeBright', 0.1, 1.5, 0.05], ['nodeOpacity', 0, 1, 0.05], ['glow', 0, 2.5, 0.05], ['line', 0.2, 3, 0.05], ['taper', 0, 3, 0.05], ['taperLen', 0.2, 3, 0.05], ['taperBright', 0, 2, 0.05],
  ['secLabels'], ['font', 2, 10, 0.5], ['fontGrow', 0, 3, 0.05], ['labelFrom', 0, 60, 1], ['boldFrom', 1, 60, 1], ['maxLabels', 0, 200, 5],
  ['secShapes'], ['shStern', 0, 25, 0.5], ['shRaute', 0, 25, 0.5], ['shQuadrat', 0, 25, 0.5], ['shRing', 0, 25, 0.5],
];
/* playback speed: vault time per second of playback */
const TL_RATES = [[1000, 'tlRateSec'], [60000, 'tlRateMin'], [3600000, 'tlRateHour'], [86400000, 'tlRateDay'], [604800000, 'tlRateWeek'], [2592000000, 'tlRateMonth']];
/* keyboard + mouse bindings (user-editable in the panel) */
export const KEY_ACTIONS = ['zin', 'zout', 'up', 'down', 'left', 'right', 'rl', 'rr', 'tu', 'td', 'fit', 'names', 'search'];
export const DEFAULT_KEYS = { zin: ['+', '='], zout: ['-', ''], up: ['ArrowUp', 'w'], down: ['ArrowDown', 's'], left: ['ArrowLeft', 'a'], right: ['ArrowRight', 'd'],
  rl: ['q', ''], rr: ['e', ''], tu: ['PageUp', 'r'], td: ['PageDown', 'v'], fit: ['0', 'f'], names: ['n', ''], search: ['/', ''] };
export const DEFAULT_MOUSE = { left: 'rotate', right: 'pan', middle: 'pan', shift: 'link', invert: false, rotSpeed: 1, rotPause: 1 };
const KEY_NAMES = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', ' ': 'Space', PageUp: 'PgUp', PageDown: 'PgDn', Home: 'Pos1', End: 'Ende', Insert: 'Einfg' };
const normKey = (k) => (k && k.length === 1 ? k.toLowerCase() : k);
const keyLabel = (k) => (!k ? '·' : KEY_NAMES[k] || (k.length === 1 ? k.toUpperCase() : k));

export class CortexGraphView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.mode = 'global'; // 'global' | 'local'
    this.focusPath = null; // fixed focus (local graph of a chosen note) inside global mode
    this.depth = plugin.settings.depth;
    this.activity = plugin.settings.activity;
    this.problems = false;
    this.G = { nodes: [], edges: [], adj: [], idx: new Map(), stats: {} };
    this.sig = '';
    this.worker = null; this.workerUrl = null;
    this.sel = -1; this.pathFrom = -1; this.pathPending = false;
    this.navMini = false;
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return this.mode === 'local' ? t('viewTitleLocal') : t('viewTitle'); }
  getIcon() { return 'orbit'; }

  getState() { return Object.assign(super.getState(), { mode: this.mode, depth: this.depth }); }
  async setState(state, result) {
    if (state && state.mode) this.mode = state.mode;
    if (state && state.depth) this.depth = state.depth;
    if (this.R) { this.updateToolbar(); this.rebuild(true); }
    return super.setState(state, result);
  }

  async onOpen() {
    const root = this.contentEl.createDiv({ cls: 'cg-root' });
    this.rootEl = root;
    if (Platform.isMobile) root.addClass('is-mobile');
    this.canvas = root.createEl('canvas', { cls: 'cg-canvas' });
    this.labels = root.createDiv({ cls: 'cg-labels' });
    this.anchor = root.createDiv({ cls: 'cg-anchor' });
    this.info = root.createDiv({ cls: 'cg-info' });
    this.hint = root.createDiv({ cls: 'cg-hint' }); this.hint.toggle(false);
    this.legend = root.createDiv({ cls: 'cg-legend' }); this.legend.toggle(false);
    this.buildToolbar(root);
    this.buildNav(root);
    this.buildSheet(root);
    this.buildPanel(root);
    this.buildTimeline(root);
    this.tip = root.createDiv({ cls: 'cg-tip' }); this.tip.toggle(false);

    this.R = new GraphRenderer(this.canvas, this.labels, this.anchor);
    this.R.mouse = this.plugin.settings.mouse;
    if (!this.R.active) { root.createDiv({ cls: 'cg-empty', text: t('noWebgl') }); return; }
    this.R.showLabels = this.plugin.settings.labels;
    this.R.setStyle(this.styleObj());
    this.applyTheme();
    this.R.onTap = (k, dbl, e) => this.onTap(k, dbl, e);
    this.R.onDrag = (k, x, y, z) => this.simSend({ cmd: 'pin', i: k, x, y, z });
    this.R.onDragEnd = (k) => this.simSend({ cmd: 'unpin', i: k });
    this.R.onHover = (k, e) => this.onHover(k, e);
    this.R.onContext = (k, e) => this.onContext(k, e);
    this.R.onContextEmpty = (e) => this.onContextEmpty(e);
    this.R.onLink = (a, b) => this.linkNotes(a, b);

    const ro = new ResizeObserver(() => this.R && this.R.resize());
    ro.observe(root); this.register(() => ro.disconnect());

    this.requestRebuild = debounce(() => this.rebuild(false), 700, true);
    this.registerEvent(this.app.metadataCache.on('resolved', () => this.requestRebuild()));
    this.registerEvent(this.app.vault.on('rename', () => this.requestRebuild()));
    this.registerEvent(this.app.vault.on('delete', () => this.requestRebuild()));
    this.registerEvent(this.app.vault.on('modify', () => { if (this.activity) this.requestHeat(); }));
    this.requestHeat = debounce(() => this.applyHeat(), 1500, true);
    this.registerEvent(this.app.workspace.on('file-open', () => { if (this.mode === 'local') this.rebuild(false); }));
    this.registerEvent(this.app.workspace.on('css-change', () => this.applyTheme()));
    this.registerInterval(window.setInterval(() => { if (this.activity) this.applyHeat(); }, 60000));
    this.registerDomEvent(root, 'keydown', (e) => this.onKey(e));
    // hovering a file or folder in the file explorer lights up its nodes
    // clicking a folder open keeps it lit until it is closed again
    let hlPath = null;
    this.pinned = null;
    const hlFrom = (el) => {
      const it = el instanceof Element ? el.closest('.nav-file-title[data-path], .nav-folder-title[data-path]') : null;
      return it && !this.contentEl.contains(it) ? it : null;
    };
    const showPinned = () => { if (this.pinned) this.highlightPath(this.pinned, true); else this.highlightPath(null); };
    this.registerDomEvent(document, 'mouseover', (e) => {
      const it = hlFrom(e.target);
      const p = it ? it.getAttribute('data-path') : null;
      if (p === hlPath) return;
      hlPath = p;
      if (p) this.highlightPath(p, it.hasClass('nav-folder-title')); else showPinned();
    });
    this.registerDomEvent(document, 'mouseleave', () => { hlPath = null; showPinned(); });
    this.registerDomEvent(document, 'click', (e) => {
      const it = hlFrom(e.target);
      if (!it || !it.hasClass('nav-folder-title')) return;
      const p = it.getAttribute('data-path');
      window.setTimeout(() => {
        const open = it.parentElement && !it.parentElement.hasClass('is-collapsed');
        if (open) this.pinned = p;
        else if (this.pinned && (this.pinned === p || this.pinned.startsWith(p + '/'))) this.pinned = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : null;
        if (!hlPath || hlPath === p) { if (open) this.highlightPath(p, true); else if (hlPath === p) this.highlightPath(p, true); else showPinned(); }
      }, 60);
    }, true);
    root.tabIndex = 0;

    this.updateToolbar();
    await this.rebuild(true);
  }

  async onClose() {
    this.stopPlay();
    if (this.R && this.R.rec) await this.finishRecording();
    this.stopWorker();
    if (this.R) this.R.dispose();
    this.R = null;
  }

  styleObj() { const s = this.plugin.settings; const o = { rotate: s.rotate, labelFont: s.labelFont || 'ui', labelStyle: s.labelStyle || 'glow' }; for (const k of STYLE_KEYS) o[k] = s.style[k]; return o; }
  simParams() {
    const ps = this.plugin.settings, s = ps.style, free = this.mode === 'local' || !!this.focusPath;
    return { center: s.center, repel: s.repel, link: s.link, dist: s.dist, range: s.range,
      shape: free ? 'free' : ps.shape || 'free', shapeSize: s.shapeSize, shapeGroup: s.shapeGroup, hubPull: s.hubPull, ngroups: this.groupCount || 0 };
  }

  /* pyramid height per node (0 = apex .. 1 = base): link distance from the most important note, ties by importance;
     spread so that each layer gets as many notes as the pyramid has room for (volume grows with depth^3, area with depth^2) */
  pyramidLevels(weights, flat) {
    const G = this.G, n = G.nodes.length, lv = new Float32Array(n).fill(-1);
    let root = -1;
    for (let k = 0; k < n; k++) if (weights[k] > 0 && (root < 0 || weights[k] > weights[root])) root = k;
    if (root < 0) return lv;
    const depth = new Int32Array(n).fill(-1), q = [root]; depth[root] = 0;
    for (let h = 0; h < q.length; h++) { const a = q[h]; for (const b of G.adj[a]) if (depth[b] < 0) { depth[b] = depth[a] + 1; q.push(b); } }
    let maxD = 0; for (let k = 0; k < n; k++) if (depth[k] > maxD) maxD = depth[k];
    const ks = []; for (let k = 0; k < n; k++) if (!G.nodes[k].anchor && !G.nodes[k].hidden) ks.push(k);
    const key = (k) => (depth[k] < 0 ? maxD + 2 : depth[k]) + (1 - weights[k]) * 0.95;
    ks.sort((a, b) => key(a) - key(b));
    const p = flat ? 0.5 : 1 / 3;
    ks.forEach((k, i) => { lv[k] = Math.pow((i + 0.5) / ks.length, p); });
    return lv;
  }

  /* top-level folder index per node, biggest folder first (for the base form regions) */
  groupArray() {
    const nodes = this.G.nodes, top = (nd) => nd.note ? nd.note.folder || '' : nd.anchor && nd.key ? String(nd.key).slice(7).split('/')[0] : '';
    const cnt = new Map();
    for (const nd of nodes) { const f = top(nd); if (f && !nd.hidden) cnt.set(f, (cnt.get(f) || 0) + 1); }
    const order = [...cnt.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0]);
    this.groupNames = order; this.groupCount = order.length;
    const idx = new Map(order.map((f, i) => [f, i]));
    const g = new Int32Array(nodes.length);
    nodes.forEach((nd, k) => { const f = top(nd); g[k] = f && idx.has(f) ? idx.get(f) : -1; });
    return g;
  }

  applyTheme() {
    if (!this.R || !this.R.active) return;
    let bg = '#1e1e1e';
    for (const el of [this.contentEl, this.containerEl, document.body]) {
      const c = getComputedStyle(el).backgroundColor;
      if (c && !/rgba\([^)]*,\s*0\)$/.test(c) && c !== 'transparent') { bg = c; break; }
    }
    const light = document.body.hasClass('theme-light');
    const space = this.plugin.settings.background !== 'theme';
    this.rootEl.toggleClass('is-space', space);
    this.R.setTheme({ space, bg: toHex(bg), light });
  }

  // ============================================================ data
  collect() { return this.plugin.collect(); }
  readGraphCfg() { return this.plugin.readGraphCfg(); }

  async rebuild(force) {
    if (!this.R || !this.R.active) return;
    const s = this.plugin.settings;
    const { notes, byPath } = this.collect();
    const cfg = await this.readGraphCfg();
    assignColors(notes, cfg, s.colorBy, s.folderColors);
    this.notes = notes; this.byPath = byPath;
    let focus = null;
    if (this.mode === 'local') {
      const f = this.app.workspace.getActiveFile();
      const n = f && byPath.get(f.path);
      focus = n ? n.i : null;
      if (focus == null && !force && this.G.nodes.length) return; // keep last local graph
    } else if (this.focusPath && byPath.has(this.focusPath)) focus = byPath.get(this.focusPath).i;
    const folderLinks = s.folderLinks !== 'off' && focus == null;
    const G = buildGraph(notes, { focus, depth: this.depth, orphans: s.orphans || folderLinks, filter: s.filters && cfg.has ? cfg : null, problems: this.problems, keepHidden: true,
      exclude: (n) => (s.hiddenFolders || []).some((f) => n.path.startsWith(f + '/')) });
    if (folderLinks) addFolderAnchors(G);
    this.R.anchorLines = s.folderLinks === 'lines';
    const fw = s.folderWeights || {};
    const nw = s.noteWeights || {};
    for (const nd of G.nodes) nd.w = nd.note ? nw[nd.note.path] || deepestFolderValue(fw, nd.note.path) || 1 : 1;
    if (s.rankBy !== 'links') importance(G.nodes); else for (const nd of G.nodes) nd.rank = null;
    this.assignShapes(G.nodes);
    const sig = signature(G) + '|' + this.mode + '|' + s.layout + '|' + (s.hiddenFolders || []).join(',') + '|' + s.folderLinks + '|' + s.rankBy;
    const prevSel = this.sel >= 0 && this.G.nodes[this.sel] ? this.G.nodes[this.sel].key : null;
    if (!force && sig === this.sig) { // same structure: refresh colors + heat only
      G.nodes.forEach((nd, k) => { if (this.G.nodes[k]) { this.G.nodes[k].note = nd.note; this.G.nodes[k].kind = nd.kind; this.G.nodes[k].w = nd.w; this.G.nodes[k].rank = nd.rank; this.G.nodes[k].shape = nd.shape; } }); this.R.applyShapes(); this.R.maxDeg = Math.max(1, ...this.G.nodes.filter((nd) => !nd.hidden && !nd.anchor).map((nd) => (nd.rank != null ? nd.rank : nd.deg) * (nd.w || 1))); this.G.stats = G.stats;
      this.R.refreshColors(); this.applyHeat(); this.applyOverlay(); this.updateInfo(); this.applyMask();
      return;
    }
    // keep positions of known nodes
    const old = new Map(this.G.nodes.map((nd) => [nd.key, nd]));
    this.G = G; this.sig = sig;
    this.sel = -1; this.pathFrom = -1; this.pathPending = false; this.R.setPath(null); this.hideSheet();
    await this.layout(old, focus);
    if (prevSel && G.idx.has(prevSel)) this.select(G.idx.get(prevSel), false);
    else if (focus != null) { const k = G.idx.get(notes[focus].path); if (k != null) this.select(k, false); }
    this.applyHeat(); this.applyOverlay(); this.updateInfo(); if (this.tlOn) this.fillTags(); this.applyMask();
    if (this.problems) { this.suggestions = null; this.applyOverlay(); }
    if (this.reviewFn) this.refreshReview();
  }

  async layout(old, focus) {
    this.stopWorker();
    const G = this.G, n = G.nodes.length, flat = this.plugin.settings.layout === 'flat';
    const saved = focus == null ? await this.plugin.loadPositions(flat) : {};
    const pos = new Float32Array(3 * n);
    let have = 0;
    for (let k = 0; k < n; k++) {
      const nd = G.nodes[k], o = old.get(nd.key), s = saved[nd.key];
      const src = o ? [o.x, o.y, o.z || 0] : s;
      if (src) { pos[3 * k] = src[0]; pos[3 * k + 1] = src[1]; pos[3 * k + 2] = flat ? 0 : (src[2] || 0); have++; }
      else {
        const r = 60 * Math.cbrt(Math.random()) + 8 * Math.cbrt(n), th = Math.random() * 6.283, ph = Math.acos(2 * Math.random() - 1);
        pos[3 * k] = r * Math.sin(ph) * Math.cos(th); pos[3 * k + 1] = r * Math.sin(ph) * Math.sin(th); pos[3 * k + 2] = flat ? 0 : r * Math.cos(ph);
      }
    }
    if (have) for (let k = 0; k < n; k++) {
      const nd = G.nodes[k]; if (old.has(nd.key) || saved[nd.key]) continue;
      const nb = G.adj[k].find((j) => old.has(G.nodes[j].key) || saved[G.nodes[j].key]);
      if (nb != null) for (let d = 0; d < (flat ? 2 : 3); d++) pos[3 * k + d] = pos[3 * nb + d] + (Math.random() - 0.5) * 30;
    }
    for (let k = 0; k < n; k++) { G.nodes[k].x = pos[3 * k]; G.nodes[k].y = pos[3 * k + 1]; G.nodes[k].z = pos[3 * k + 2]; }
    const keepCam = old.size > 0 && have > n * 0.8;
    this.R.setGraph(G.nodes, G.edges, G.adj);
    if (!keepCam) { this.R.resetView(); this.R.fit(true); }
    if (this.sideView) { this.sideView = false; this.R.yaw = 0; this.R.pitch = 0.08; }
    if (!n) return;
    const alpha0 = have > n * 0.9 ? 0.12 : 1;
    const edges = new Int32Array(G.edges.length * 2);
    G.edges.forEach(([a, b], k) => { edges[2 * k] = a; edges[2 * k + 1] = b; });
    try {
      this.workerUrl = URL.createObjectURL(new Blob([SIM_SRC], { type: 'text/javascript' }));
      this.worker = new Worker(this.workerUrl);
    } catch { this.worker = null; return; }
    const w = this.worker;
    w.onmessage = (ev) => {
      if (w !== this.worker || !this.R) return;
      this.R.setPositions(ev.data.pos);
      if (ev.data.done && focus == null) this.savePositions();
    };
    const groups = this.groupArray();
    // importance 0..1: hubs are pulled to the middle so the graph grows outward from its core
    const weights = new Float32Array(n);
    let wmax = 0;
    G.nodes.forEach((nd, k) => { const v = nd.anchor || nd.hidden ? 0 : Math.sqrt((nd.rank ?? nd.deg) * (nd.w || 1)); weights[k] = v; if (v > wmax) wmax = v; });
    if (wmax > 0) for (let k = 0; k < n; k++) weights[k] /= wmax;
    const levels = this.pyramidLevels(weights, flat);
    w.postMessage({ cmd: 'init', n, dim: flat ? 2 : 3, edges, pos, groups, weights, levels, params: this.simParams(), alpha: alpha0 });
  }

  savePositions() {
    const s = {};
    for (const nd of this.G.nodes) if (!nd.ghost) s[nd.key] = [Math.round(nd.x), Math.round(nd.y), Math.round(nd.z || 0)];
    this.plugin.savePositions(this.plugin.settings.layout === 'flat', s);
  }

  stopWorker() {
    if (this.worker) { this.worker.terminate(); this.worker = null; }
    if (this.workerUrl) { URL.revokeObjectURL(this.workerUrl); this.workerUrl = null; }
  }
  simSend(msg) { if (this.worker) this.worker.postMessage(msg); }

  relayout() {
    this.plugin.savePositions(this.plugin.settings.layout === 'flat', null).then(() => { this.sig = ''; this.G = { nodes: [], edges: [], adj: [], idx: new Map(), stats: {} }; this.rebuild(true); });
  }

  applyHeat() {
    if (!this.R || !this.R.points) return;
    this.applyStale();
    if (!this.activity) { this.R.setHeat(null); return; }
    const now = Date.now(), hl = this.plugin.settings.halfLife, n = this.G.nodes.length;
    const h = new Float32Array(n), mt = new Float64Array(n);
    this.G.nodes.forEach((nd, k) => {
      const f = nd.note && this.app.vault.getAbstractFileByPath(nd.note.path);
      mt[k] = f instanceof TFile ? f.stat.mtime : 0;
      h[k] = heatOf(mt[k], now, hl);
    });
    // keep it meaningful after bulk edits: only the most recently changed notes may glow fully
    const order = [...mt.keys()].sort((a, b) => mt[b] - mt[a]);
    const full = Math.max(5, Math.round(n * 0.06)), none = Math.max(12, Math.round(n * 0.18));
    order.forEach((k, r) => { if (r >= none) h[k] = 0; else if (r > full) h[k] *= 1 - (r - full) / (none - full); });
    this.R.setHeat(h);
  }
  /* notes nobody touched for a long time fade out */
  applyStale() {
    const days = this.plugin.settings.staleDays || 0, now = Date.now();
    for (const nd of this.G.nodes) {
      if (!days || !nd.note) { nd.stale = 0; continue; }
      const age = (now - nd.note.mtime) / 86400000;
      nd.stale = age <= days ? 0 : Math.min(1, (age - days) / (days * 2));
    }
  }

  assignShapes(nodes) {
    const s = this.plugin.settings, st = s.style || {}, MAP = { kreis: 0, circle: 0, ring: 1, stern: 2, star: 2, raute: 3, diamond: 3, quadrat: 4, square: 4 };
    const def = MAP[s.shapeDefault] ?? 0;
    const score = (nd) => (nd.rank ?? nd.deg) * (nd.w || 1);
    /* automatic tiers by importance: top shStern % stars, next shRaute % diamonds, then squares, then rings */
    const auto = new Map();
    if (s.hubStars) {
      const ranked = nodes.filter((nd) => nd.note && !nd.hidden && !nd.anchor).sort((a, b) => score(b) - score(a));
      let at = 0;
      for (const [key, shape] of [['shStern', 2], ['shRaute', 3], ['shQuadrat', 4], ['shRing', 1]]) {
        const n = Math.round(ranked.length * (Number(st[key]) || 0) / 100);
        for (let i = at; i < Math.min(ranked.length, at + n); i++) if (score(ranked[i]) > 0) auto.set(ranked[i], shape);
        at += n;
      }
    }
    const ns = s.noteShapes || {};
    for (const nd of nodes) {
      if (!nd.note) { nd.shape = 0; continue; }
      const own = ns[nd.note.path];
      const fmv = nd.note.fm && (nd.note.fm.form ?? nd.note.fm.shape);
      const fromFm = own ? MAP[own] : fmv != null ? MAP[String(fmv).toLowerCase()] : undefined;
      const fromFolder = deepestFolderValue(s.folderShapes || {}, nd.note.path);
      nd.shape = fromFm ?? (fromFolder != null ? MAP[fromFolder] ?? 0 : auto.get(nd) ?? def);
    }
  }

  reshape() { if (!this.R) return; this.assignShapes(this.G.nodes); this.R.applyShapes(); }


  applyOverlay() {
    if (!this.R) return;
    this.legend.empty(); this.legend.toggle(this.problems);
    if (!this.problems) { this.R.setOverlay(null, null); this.R.setSuggestions(null); this.suggestions = null; return; }
    if (!this.suggestions) this.computeSuggestions();
    const colors = [], bright = new Set();
    this.G.nodes.forEach((nd, k) => { if (nd.kind) { colors[k] = PROBLEM_COLORS[nd.kind]; bright.add(k); } else colors[k] = null; });
    // edges into unresolved ghosts: keep source visible
    for (const [a, b] of this.G.edges) if (this.G.nodes[b].ghost) bright.add(a);
    if (this.suggestions) for (const x of this.suggestions) { const k = this.G.idx.get(x.from); if (k != null && !colors[k]) { colors[k] = '#ffc04d'; bright.add(k); } }
    this.R.setOverlay(colors, bright);
    for (const kind of ['orphan', 'deadEnd', 'unresolved']) {
      const row = this.legend.createDiv({ cls: 'cg-legend-row' });
      row.createSpan({ cls: 'cg-dot' }).setCssStyles({ background: PROBLEM_COLORS[kind] });
      row.createSpan({ text: t(kind) + ' ' });
      row.createEl('b', { text: String(this.G.stats[kind] || 0) });
    }
    const row = this.legend.createDiv({ cls: 'cg-legend-row' });
    row.createSpan({ cls: 'cg-dash' });
    row.createSpan({ text: t('suggestions') + ' ' });
    this.sugCount = row.createEl('b', { text: this.suggestions ? String(this.suggestions.length) : '…' });
  }

  onActivity(path, op) {
    const k = this.G.idx.get(path);
    if (k == null || !this.R || !this.R.active) return;
    this.R.flash(k, op);
    if (this.reviewKey === 'reviewClaude') this.refreshReview();
  }

  // ============================================================ link suggestions
  /* finds notes that mention the name (or an alias) of another note without linking it */
  async computeSuggestions() {
    const token = (this.sugToken = (this.sugToken || 0) + 1);
    this.suggestions = [];
    const names = new Map();
    for (const nd of this.G.nodes) {
      if (!nd.note || nd.hidden) continue;
      const add = (x) => { x = String(x || '').trim(); if (x.length >= 4 && !names.has(x.toLowerCase())) names.set(x.toLowerCase(), nd.note.path); };
      add(nd.note.name);
      const al = nd.note.fm && nd.note.fm.aliases;
      (Array.isArray(al) ? al : al ? [al] : []).forEach(add);
    }
    if (!names.size) return;
    const esc = [...names.keys()].sort((a, b) => b.length - a.length).map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const re = new RegExp('(^|[^\\p{L}\\p{N}])(' + esc.join('|') + ')(?![\\p{L}\\p{N}])', 'giu');
    const out = [];
    for (const nd of this.G.nodes) {
      if (!nd.note || nd.hidden || !(nd.note.file instanceof TFile)) continue;
      let txt = await this.app.vault.cachedRead(nd.note.file);
      if (token !== this.sugToken) return;
      txt = txt.replace(/^---\n[\s\S]*?\n---/, '').replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ')
        .replace(/!?\[\[[^\]]*\]\]/g, ' ').replace(/\[[^\]]*\]\([^)]*\)/g, ' ').replace(/https?:\/\/\S+/g, ' ');
      const seen = new Set();
      let m;
      re.lastIndex = 0;
      while ((m = re.exec(txt))) {
        const target = names.get(m[2].toLowerCase());
        if (!target || target === nd.note.path || seen.has(target)) continue;
        const tn = this.byPath.get(target);
        if (!tn || nd.note.out.has(tn.i)) continue;
        seen.add(target);
        out.push({ from: nd.note.path, to: target, text: m[2] });
      }
    }
    if (token !== this.sugToken || !this.problems) return;
    // drop names that appear unlinked almost everywhere (person names, generic words) and pairs already close in the graph
    const per = new Map();
    for (const x of out) per.set(x.to, (per.get(x.to) || 0) + 1);
    const real = this.G.nodes.filter((nd) => nd.note && !nd.hidden).length;
    const limit = Math.max(8, Math.round(real * 0.03));
    const near = (a, b) => {
      const na = this.byPath.get(a), nb = this.byPath.get(b);
      if (!na || !nb) return false;
      for (const j of [...na.out, ...na.back]) { const m = this.notes[j]; if (m.out.has(nb.i) || m.back.has(nb.i)) return true; }
      return false;
    };
    this.suggestions = out.filter((x) => per.get(x.to) <= limit && !near(x.from, x.to));
    this.applyOverlay();
    this.showSuggestLines();
    if (this.sugCount) this.sugCount.setText(String(this.suggestions.length));
    if (this.sel >= 0) this.showSheet(this.sel);
  }

  /* dashed lines only for the selected note (all at once would be unreadable) */
  showSuggestLines() {
    if (!this.R) return;
    const nd = this.sel >= 0 ? this.G.nodes[this.sel] : null;
    if (!this.problems || !this.suggestions || !nd || !nd.note) { this.R.setSuggestions(null); return; }
    const p = nd.note.path;
    this.R.setSuggestions(this.suggestions.filter((x) => x.from === p || x.to === p)
      .map((x) => [this.G.idx.get(x.from), this.G.idx.get(x.to)]).filter(([a, b]) => a != null && b != null));
  }

  /* turns the first plain mention into a link */
  async applySuggestion(sg) {
    const f = this.app.vault.getAbstractFileByPath(sg.from), tf = this.app.vault.getAbstractFileByPath(sg.to);
    if (!(f instanceof TFile) || !(tf instanceof TFile)) return;
    const lt = this.app.metadataCache.fileToLinktext(tf, f.path, true);
    let done = false;
    this.plugin.markSelf(f.path);
    await this.app.vault.process(f, (txt) => {
      const esc = sg.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp('(\\[\\[[^\\]]*\\]\\]|```[\\s\\S]*?```|`[^`\\n]*`)|(^|[^\\p{L}\\p{N}])(' + esc + ')(?![\\p{L}\\p{N}])', 'giu');
      return txt.replace(re, (all, skip, pre, hit) => {
        if (skip || done) return all;
        done = true;
        return pre + (hit.toLowerCase() === lt.toLowerCase() ? '[[' + hit + ']]' : '[[' + lt + '|' + hit + ']]');
      });
    });
    if (done) { new Notice(t('sugDone', sg.text)); this.suggestions = this.suggestions.filter((x) => x !== sg); }
  }

  // ============================================================ create + link notes
  async linkNotes(a, b) {
    const na = this.noteOf(a), nb = this.noteOf(b);
    if (!na || !nb) return;
    const lt = this.app.metadataCache.fileToLinktext(nb.file, na.path, true);
    this.plugin.markSelf(na.path);
    await this.app.vault.process(na.file, (txt) => txt.replace(/\s*$/, '') + '\n\n[[' + lt + ']]\n');
    new Notice(t('linkDone', na.name, nb.name));
  }

  async createNote(near) {
    const base = near && near.note ? near.note.file.parent : this.app.fileManager.getNewFileParent('');
    new NameModal(this.app, near ? t('newLinked', near.label) : t('newNote'), '', async (name) => {
      const folder = base && base.path !== '/' ? base.path + '/' : '';
      let path = folder + name.replace(/[\\/:*?"<>|]/g, '-') + '.md', i = 1;
      while (this.app.vault.getAbstractFileByPath(path)) path = folder + name + ' ' + (++i) + '.md';
      const body = near && near.note ? '\n\n' + t('relatedTo') + ' [[' + this.app.metadataCache.fileToLinktext(near.note.file, path, true) + ']]\n' : '';
      this.plugin.markSelf(path);
      const f = await this.app.vault.create(path, '# ' + name + body);
      await this.app.workspace.getLeaf('tab').openFile(f);
    }).open();
  }

  onContextEmpty(e) {
    const menu = new Menu();
    menu.addItem((i) => i.setTitle(t('newNote')).setIcon('file-plus').onClick(() => this.createNote(null)));
    if (this.R.camBefore) menu.addItem((i) => i.setTitle(t('camBack')).setIcon('undo-2').onClick(() => this.R.restoreCamera()));
    menu.addItem((i) => i.setTitle(t('fit')).setIcon('maximize').onClick(() => this.R.resetView()));
    menu.showAtMouseEvent(e);
  }

  // ============================================================ session review
  reviewMenu(e) {
    const menu = new Menu(), day = 86400000, now = Date.now();
    const start = moment().startOf('day').valueOf();
    const opts = [['reviewToday', (n) => n.mtime >= start], ['reviewSession', (n) => n.mtime >= this.plugin.startedAt],
      ['reviewWeek', (n) => n.mtime >= now - 7 * day], ['reviewClaude', (n) => this.plugin.externalWrites.has(n.path)]];
    for (const [key, fn] of opts) menu.addItem((i) => i.setTitle(t(key)).setChecked(this.reviewKey === key).onClick(() => this.setReview(key, fn)));
    if (this.reviewKey) { menu.addSeparator(); menu.addItem((i) => i.setTitle(t('reviewOff')).setIcon('x').onClick(() => this.setReview(null))); }
    menu.showAtMouseEvent(e);
  }

  setReview(key, fn) {
    this.reviewKey = key; this.reviewFn = fn || null;
    this.refreshReview();
    this.updateToolbar();
  }

  refreshReview() {
    if (!this.reviewFn) { this.reviewSet = null; this.R.setHighlight(null); this.hint.toggle(false); return; }
    const set = new Set();
    this.G.nodes.forEach((nd, k) => { if (nd.note && this.reviewFn(nd.note)) set.add(k); });
    this.reviewSet = set;
    this.R.setHighlight(set);
    this.hint.setText(t('reviewCount', set.size)); this.hint.toggle(set.size === 0);
    if (set.size) this.R.fitTo([...set]);
  }

  updateInfo() {
    const G = this.G;
    const vis = (nd) => !nd.ghost && !nd.hidden && !nd.anchor;
    const real = G.nodes.filter(vis).length;
    const links = G.edges.filter(([a, b]) => vis(G.nodes[a]) && vis(G.nodes[b])).length;
    this.info.setText(real + ' ' + t('notes') + ' · ' + links + ' ' + t('links'));
  }

  highlightPath(path, folder) {
    if (!this.R || !this.R.active) return;
    if (!path) { this.R.setHighlight(this.reviewSet || null); this.R.setGalaxy(null); this.hint.toggle(false); return; }
    const set = new Set();
    if (folder) { const pre = path === '/' ? '' : path + '/'; this.G.nodes.forEach((nd, k) => { if (nd.note && nd.note.path.startsWith(pre)) set.add(k); }); }
    else { const k = this.G.idx.get(path); if (k != null) set.add(k); }
    this.R.setHighlight(set);
    const name = path.split('/').pop().replace(/\.md$/, '');
    if (folder && this.plugin.settings.galaxies !== false) {
      const vis = new Set([...set].filter((k) => !this.G.nodes[k].hidden));
      const fc = this.plugin.fc && this.plugin.fc.colorOf(path.split('/')[0]);
      const first = [...vis].map((k) => this.G.nodes[k].note && this.G.nodes[k].note.color).find(Boolean);
      this.R.setGalaxy({ set: vis.size ? vis : set, color: (this.plugin.settings.folderColors || {})[path] || fc || first, name });
    } else this.R.setGalaxy(null);
    this.hint.setText(t(folder ? 'hintFolderHidden' : 'hintHidden', name));
    this.hint.toggle(set.size === 0);
  }

  // ============================================================ interaction
  noteOf(k) { const nd = this.G.nodes[k]; return nd && nd.note; }

  async openNote(k, newTab) {
    const n = this.noteOf(k); if (!n) return;
    const leaf = this.app.workspace.getLeaf(newTab ? 'tab' : false);
    // never replace the graph itself
    const target = leaf === this.leaf ? this.app.workspace.getLeaf('tab') : leaf;
    await target.openFile(n.file);
  }

  onTap(k, dbl, e) {
    if (k < 0) { if (this.pathPending) return; this.select(-1); this.R.restoreCamera(); return; }
    if (this.pathPending) { this.finishPath(k); return; }
    const mod = e && (e.ctrlKey || e.metaKey);
    if (this.noteOf(k) && (mod || dbl || this.plugin.settings.clickOpens)) { this.openNote(k, mod); if (!this.plugin.settings.clickOpens) return; }
    this.select(k, true);
  }

  select(k, fly) {
    this.sel = k;
    if (this.R.pathSet) this.R.setPath(null);
    this.R.setSelected(k);
    this.showSuggestLines();
    if (k < 0) { this.hideSheet(); return; }
    if (fly && (Platform.isMobile || this.plugin.settings.focusCamera !== false)) this.R.focusNode(k);
    this.showSheet(k);
  }

  onHover(k, e) {
    this.anchor.toggleClass('is-active', k >= 0);
    this.showTip(k, e);
    const n = k >= 0 ? this.noteOf(k) : null;
    if (!n) return;
    this.app.workspace.trigger('hover-link', { event: e, source: VIEW_TYPE, hoverParent: this, targetEl: this.anchor, linktext: n.path });
  }

  onContext(k, e) {
    const n = this.noteOf(k);
    const menu = new Menu();
    if (n) {
      menu.addItem((i) => i.setTitle(t('open')).setIcon('file').onClick(() => this.openNote(k, false)));
      menu.addItem((i) => i.setTitle(t('openTab')).setIcon('file-plus').onClick(() => this.openNote(k, true)));
      menu.addItem((i) => i.setTitle(t('focus')).setIcon('git-fork').onClick(() => this.focusOn(n.path)));
      menu.addItem((i) => i.setTitle(t('newLinkedShort')).setIcon('file-plus-2').onClick(() => this.createNote(this.G.nodes[k])));
    }
    menu.addItem((i) => i.setTitle(t('pathFrom')).setIcon('route').onClick(() => this.startPath(k)));
    if (n) { menu.addSeparator(); this.app.workspace.trigger('file-menu', menu, n.file, 'cortex-graph-context-menu', this.leaf); }
    menu.showAtMouseEvent(e);
  }

  focusOn(path) {
    this.focusPath = path; this.mode = 'global';
    this.updateToolbar(); this.rebuild(true);
  }

  startPath(k) {
    this.pathFrom = k; this.pathPending = true;
    this.R.setPath(null); this.R.setSelected(k);
    this.sheetTitle.setText(this.G.nodes[k].label);
    this.sheetMeta.setText(t('pathPick'));
    this.sheetBtns.toggle(false); this.sheetPathBtns.toggle(true);
    this.sheet.toggle(true); this.syncSheetSpace();
  }

  finishPath(k) {
    this.pathPending = false;
    const p = shortestPath(this.G.adj, this.pathFrom, k);
    this.sel = -1; this.R.setSelected(-1);
    if (!p) { new Notice(t('pathNone')); this.hideSheet(); return; }
    this.R.setPath(p);
    this.R.fitTo(p);
    this.sheetTitle.setText(this.G.nodes[this.pathFrom].label + ' → ' + this.G.nodes[k].label);
    this.sheetMeta.setText(t('pathFound', p.length - 1) + ': ' + p.map((j) => this.G.nodes[j].label).join(' › '));
    this.sheetBtns.toggle(false); this.sheetPathBtns.toggle(true);
    this.sheet.toggle(true); this.syncSheetSpace();
  }

  /* path from the command palette (paths of notes) */
  showPathBetween(pa, pb) {
    const a = this.G.idx.get(pa), b = this.G.idx.get(pb);
    if (a == null || b == null) { new Notice(t('notInGraph')); return; }
    this.pathFrom = a; this.finishPath(b);
  }

  flyTo(path) {
    const k = this.G.idx.get(path);
    if (k == null || this.G.nodes[k].hidden || this.G.nodes[k].anchor) { new Notice(t('notInGraph')); return; }
    this.select(k, false); this.R.focusNode(k);
  }

  onKey(e) {
    if (e.target instanceof HTMLInputElement) return;
    if (e.key === 'Escape') { if (this.pathPending || this.R.pathSet) { this.pathPending = false; this.R.setPath(null); this.hideSheet(); } else this.select(-1); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const key = normKey(e.key), keys = this.plugin.settings.keys || DEFAULT_KEYS;
    const a = KEY_ACTIONS.find((x) => (keys[x] || []).some((k) => k && normKey(k) === key));
    if (!a) return;
    e.preventDefault();
    if (a === 'names') { this.btnLabels.click(); return; }
    if (a === 'search') { this.searchInput.focus(); return; }
    this.navStep(a, a === 'fit' ? 1 : 6);
  }

  showTip(k, e) {
    const tip = this.tip;
    if (k < 0 || !this.G.nodes[k]) { tip.toggle(false); return; }
    const nd = this.G.nodes[k], n = nd.note;
    tip.empty();
    tip.createDiv({ cls: 'cg-tip-title', text: nd.label });
    if (n) {
      const fold = n.path.includes('/') ? n.path.slice(0, n.path.lastIndexOf('/')) : t('root');
      tip.createDiv({ cls: 'cg-tip-row', text: fold });
      tip.createDiv({ cls: 'cg-tip-row', text: n.out.size + ' ' + t('links') + ' · ' + n.back.size + ' ' + t('backlinks') + ' · ' + t('modified') + ' ' + moment(n.mtime).fromNow() });
      if (n.tags.length) {
        const tg = tip.createDiv({ cls: 'cg-tip-tags' });
        for (const x of n.tags.slice(0, 8)) tg.createSpan({ cls: 'cg-tip-tag', text: '#' + x });
      }
    } else tip.createDiv({ cls: 'cg-tip-row', text: t('unresolved') });
    const r = this.rootEl.getBoundingClientRect();
    let x = e.clientX - r.left + 14, y = e.clientY - r.top + 14;
    tip.toggle(true);
    if (x + tip.offsetWidth > r.width - 8) x = e.clientX - r.left - tip.offsetWidth - 14;
    if (y + tip.offsetHeight > r.height - 8) y = e.clientY - r.top - tip.offsetHeight - 14;
    tip.setCssStyles({ left: x + 'px', top: y + 'px' });
  }

  // ============================================================ time lapse + tag filter
  buildTimeline(root) {
    const bar = root.createDiv({ cls: 'cg-time' }); bar.toggle(false);
    this.timeBar = bar;
    this.tl = { mode: 'ctime', from: 0, to: 1, pos: 1, tag: '', rate: 3600000, playing: false };
    const row1 = bar.createDiv({ cls: 'cg-time-row' });
    this.playBtn = row1.createEl('button', { cls: 'cg-time-play clickable-icon', attr: { 'aria-label': t('tlPlay') } }); setIcon(this.playBtn, 'play');
    this.playBtn.onclick = () => (this.tl.playing ? this.stopPlay() : this.startPlay());
    const mode = row1.createEl('select', { cls: 'dropdown' });
    this.modeSel = mode;
    mode.onchange = () => { this.tl.mode = mode.value; this.initRange(); this.applyMask(); };
    this.tagSel = row1.createEl('select', { cls: 'dropdown' });
    this.tagSel.onchange = () => { this.tl.tag = this.tagSel.value; this.applyMask(); };
    const spd = row1.createEl('select', { cls: 'dropdown', attr: { 'aria-label': t('tlSpeed') } });
    this.speedSel = spd;
    for (const [v, key] of TL_RATES) spd.createEl('option', { value: String(v), text: t(key) });
    spd.onchange = () => { this.tl.rate = Number(spd.value); this.restartIfPlaying(); };
    const mul = row1.createEl('select', { cls: 'dropdown', attr: { 'aria-label': t('tlFactor') } });
    for (const f of [0.1, 0.25, 0.5, 1, 2, 3, 5, 10]) mul.createEl('option', { value: String(f), text: '× ' + String(f).replace('.', ',') });
    mul.value = '1'; this.tl.factor = 1;
    mul.onchange = () => { this.tl.factor = Number(mul.value); this.restartIfPlaying(); };
    this.recBtn = row1.createEl('button', { cls: 'cg-time-rec clickable-icon', attr: { 'aria-label': t('tlRecord') } }); setIcon(this.recBtn, 'circle');
    this.recBtn.onclick = () => (this.R.rec ? this.finishRecording() : this.startRecording());
    this.tlCount = row1.createSpan({ cls: 'cg-time-count' });
    const x = bar.createEl('button', { cls: 'clickable-icon cg-time-close', attr: { 'aria-label': t('close') } }); setIcon(x, 'x');
    x.onclick = () => { if (this.R.rec) this.finishRecording(); this.toggleTimeline(false); };
    // left: range (From / To), right: timeline with the playhead
    const row2 = bar.createDiv({ cls: 'cg-time-row cg-time-row2' });
    const left = row2.createDiv({ cls: 'cg-time-left' });
    const right = row2.createDiv({ cls: 'cg-time-right' });
    const mk = (parent, lbl, cls) => {
      const w = parent.createDiv({ cls: 'cg-time-range' + (cls ? ' ' + cls : '') });
      const top = w.createDiv({ cls: 'cg-time-label' }); top.createSpan({ text: lbl }); const out = top.createEl('b');
      const rg = w.createEl('input', { type: 'range', attr: { min: 0, max: 1000, step: 1 } });
      return { rg, out };
    };
    this.tlFrom = mk(left, t('tlFrom')); this.tlTo = mk(left, t('tlTo'));
    this.tlPos = mk(right, t('tlTimeline'), 'cg-time-pos');
    this.tlFrom.rg.oninput = () => {
      const tl = this.tl; tl.from = Math.min(Number(this.tlFrom.rg.value), Number(this.tlTo.rg.value)) / 1000;
      this.tlFrom.rg.value = String(tl.from * 1000); if (tl.pos < tl.from) tl.pos = tl.from; this.syncPos(); this.applyMask();
    };
    this.tlTo.rg.oninput = () => {
      const tl = this.tl; tl.to = Math.max(Number(this.tlTo.rg.value), Number(this.tlFrom.rg.value)) / 1000;
      this.tlTo.rg.value = String(tl.to * 1000); if (tl.pos > tl.to || !tl.playing) tl.pos = tl.to; this.syncPos(); this.applyMask();
    };
    this.tlPos.rg.oninput = () => {
      const tl = this.tl; tl.pos = Math.max(tl.from, Math.min(tl.to, Number(this.tlPos.rg.value) / 1000)); this.syncPos(); this.applyMask();
    };
  }

  /* timeline slider covers From..To */
  syncPos() {
    const tl = this.tl, span = Math.max(1e-6, tl.to - tl.from);
    this.tlPos.rg.value = String(Math.round((tl.pos - tl.from) / span * 1000));
  }

  toggleTimeline(on) {
    this.tlOn = on == null ? !this.tlOn : on;
    this.timeBar.toggle(this.tlOn);
    this.rootEl.toggleClass('has-time', this.tlOn);
    if (this.tlOn) { this.fillModes(); this.fillTags(); this.initRange(); } else this.stopPlay();
    this.applyMask(); this.updateToolbar();
  }

  fillModes() {
    const sel = this.modeSel, cur = this.tl.mode;
    sel.empty();
    sel.createEl('option', { value: 'ctime', text: t('tlCreated') }); sel.createEl('option', { value: 'mtime', text: t('tlModified') });
    const keys = new Map();
    for (const nd of this.G.nodes) if (nd.note && !nd.hidden) for (const k in nd.note.fm) if (/^\d{4}-\d{2}-\d{2}/.test(String(nd.note.fm[k]))) keys.set(k, (keys.get(k) || 0) + 1);
    for (const [k] of [...keys.entries()].sort((a, b) => b[1] - a[1])) sel.createEl('option', { value: 'fm:' + k, text: t('tlProperty', k) });
    sel.value = [...sel.options].some((o) => o.value === cur) ? cur : 'ctime'; this.tl.mode = sel.value;
  }

  timeOf(n) {
    const m = this.tl.mode;
    if (m.startsWith('fm:')) { const v = Date.parse(String(n.fm[m.slice(3)] || '')); return isNaN(v) ? NaN : v; }
    return n[m];
  }

  fillTags() {
    const cnt = new Map();
    for (const nd of this.G.nodes) if (nd.note && !nd.hidden) for (const x of nd.note.tags) cnt.set(x, (cnt.get(x) || 0) + 1);
    const sel = this.tagSel, cur = this.tl.tag;
    sel.empty();
    sel.createEl('option', { value: '', text: t('tlAllTags') });
    for (const [x, c] of [...cnt.entries()].sort((a, b) => a[0].localeCompare(b[0]))) sel.createEl('option', { value: x, text: '#' + x + ' (' + c + ')' });
    sel.value = cnt.has(cur) ? cur : ''; this.tl.tag = sel.value;
  }

  initRange() {
    let lo = Infinity, hi = -Infinity;
    for (const nd of this.G.nodes) if (nd.note && !nd.hidden) { const v = this.timeOf(nd.note); if (isNaN(v)) continue; if (v < lo) lo = v; if (v > hi) hi = v; }
    if (!isFinite(lo)) { lo = 0; hi = 1; }
    this.tl.lo = lo; this.tl.hi = Math.max(hi, lo + 1);
    this.tl.from = 0; this.tl.to = 1; this.tl.pos = 1;
    this.tlFrom.rg.value = '0'; this.tlTo.rg.value = '1000'; this.syncPos();
    // pick the playback speed that plays the whole range in roughly 20 seconds
    const span = this.tl.hi - this.tl.lo;
    let best = TL_RATES[0][0];
    for (const [v] of TL_RATES) if (Math.abs(Math.log(span / v / 20)) < Math.abs(Math.log(span / best / 20))) best = v;
    this.tl.rate = best; this.speedSel.value = String(best);
  }

  timeAt(f) { return this.tl.lo + (this.tl.hi - this.tl.lo) * f; }

  applyMask() {
    if (!this.R || !this.R.active || !this.timeBar) return;
    if (!this.tlOn) { this.R.fresh = null; this.R.setMask(null); return; }
    const tl = this.tl, a = this.timeAt(tl.from), b = this.timeAt(tl.pos), tag = tl.tag;
    const set = new Set(), fresh = new Set(), freshFrom = b - (tl.hi - tl.lo) * 0.03;
    this.G.nodes.forEach((nd, k) => {
      const n = nd.note; if (!n) return;
      const v = this.timeOf(n);
      if (isNaN(v) || v < a || v > b) return;
      if (tag && !n.tags.some((x) => x === tag || x.startsWith(tag + '/'))) return;
      set.add(k);
      if (tl.playing && v >= freshFrom) fresh.add(k);
    });
    this.G.nodes.forEach((nd, k) => { if (nd.ghost && this.G.adj[k].some((j) => set.has(j))) set.add(k); });
    this.R.fresh = fresh.size ? fresh : null;
    this.R.setMask(set);
    const fmt = (v) => moment(v).format(tl.hi - tl.lo < 4 * 86400000 ? 'DD.MM. HH:mm' : 'DD.MM.YYYY');
    this.tlFrom.out.setText(fmt(a)); this.tlTo.out.setText(fmt(this.timeAt(tl.to))); this.tlPos.out.setText(fmt(b));
    this.tlCount.setText(set.size + ' ' + t('notes'));
  }

  /* changing speed while playing starts the playback over from "From" */
  restartIfPlaying() {
    const tl = this.tl;
    if (!tl.playing) return;
    tl.pos = tl.from; this.syncPos();
    this.applyMask();
  }

  startPlay() {
    const tl = this.tl;
    if (tl.pos >= tl.to - 0.001) tl.pos = tl.from;
    tl.playing = true; setIcon(this.playBtn, 'pause');
    let last = performance.now();
    const step = (ts) => {
      if (!tl.playing) return;
      const dt = (ts - last) / 1000; last = ts;
      tl.pos = Math.min(tl.to, tl.pos + dt * tl.rate * (tl.factor || 1) / Math.max(1, tl.hi - tl.lo));
      this.syncPos();
      this.applyMask();
      if (tl.pos >= tl.to) { this.stopPlay(); if (this.R.rec) window.setTimeout(() => this.finishRecording(), 1500); return; }
      this.playRaf = window.requestAnimationFrame(step);
    };
    this.playRaf = window.requestAnimationFrame(step);
  }

  startRecording() {
    const tl = this.tl;
    const fmt = (v) => moment(v).format(tl.hi - tl.lo < 4 * 86400000 ? 'DD.MM.YYYY HH:mm' : 'DD.MM.YYYY');
    const ok = this.R.startCapture(() => fmt(this.timeAt(tl.pos)) + (tl.tag ? '   #' + tl.tag : '') + '   ' + (this.R.mask ? this.R.mask.size : '') + ' ' + t('notes'));
    if (!ok) { new Notice(t('tlRecNo')); return; }
    this.recBtn.addClass('is-recording'); setIcon(this.recBtn, 'square');
    tl.pos = tl.from; this.syncPos();
    this.applyMask();
    window.setTimeout(() => this.startPlay(), 600);
  }

  async finishRecording() {
    if (!this.R.rec) return;
    this.stopPlay();
    this.recBtn.removeClass('is-recording'); setIcon(this.recBtn, 'circle');
    const blob = await this.R.stopCapture();
    if (!blob || !blob.size) return;
    const ext = blob.type.includes('mp4') ? 'mp4' : 'webm';
    const name = 'Cortex Graph ' + moment().format('YYYY-MM-DD HH-mm-ss') + '.' + ext;
    if (this.plugin.settings.recSave === 'auto') { await this.saveToVault(blob, name, true); return; }
    new RecordingModal(this, blob, name).open();
  }

  async saveToVault(blob, name, open) {
    let path = name;
    try { path = await this.app.fileManager.getAvailablePathForAttachment(name); } catch { /* use vault root */ }
    const f = await this.app.vault.createBinary(path, await blob.arrayBuffer());
    new Notice(t('tlRecSaved', f.path));
    if (open) this.app.workspace.getLeaf('tab').openFile(f);
    return f;
  }


  stopPlay() {
    if (!this.tl) return;
    this.tl.playing = false; window.cancelAnimationFrame(this.playRaf);
    if (this.playBtn) setIcon(this.playBtn, 'play');
    if (this.R) { this.R.fresh = null; if (this.R.active) this.R.paint(); }
  }

  // ============================================================ saved views
  captureView() {
    return {
      cam: this.R.getCamera(), mode: this.mode, focusPath: this.focusPath, depth: this.depth, problems: this.problems,
      activity: this.activity, labels: this.plugin.settings.labels, pinned: this.pinned,
      tl: this.tlOn ? { mode: this.tl.mode, tag: this.tl.tag, from: this.tl.from, to: this.tl.to, pos: this.tl.pos } : null,
    };
  }

  async restoreView(v) {
    this.stopPlay();
    this.mode = v.mode || 'global'; this.focusPath = v.focusPath || null; this.depth = v.depth || 1;
    this.problems = !!v.problems; this.activity = v.activity !== false;
    if (v.labels != null && v.labels !== this.plugin.settings.labels) { this.plugin.settings.labels = v.labels; this.R.showLabels = v.labels; }
    this.updateToolbar();
    await this.rebuild(true);
    this.applyHeat();
    this.pinned = v.pinned || null;
    if (this.pinned) this.highlightPath(this.pinned, true); else this.highlightPath(null);
    if (v.tl) {
      this.toggleTimeline(true);
      this.tl.mode = v.tl.mode; this.modeSel.value = v.tl.mode; this.initRange();
      this.tl.tag = v.tl.tag || ''; this.tagSel.value = this.tl.tag;
      this.tl.from = v.tl.from; this.tl.to = v.tl.to;
      this.tl.pos = v.tl.pos != null ? v.tl.pos : v.tl.to;
      this.tlFrom.rg.value = String(v.tl.from * 1000); this.tlTo.rg.value = String(v.tl.to * 1000); this.syncPos();
      this.applyMask();
    } else if (this.tlOn) this.toggleTimeline(false);
    window.setTimeout(() => this.R.setCamera(v.cam), 50);
    this.updateToolbar();
  }

  viewsMenu(e) {
    const views = this.plugin.settings.views || (this.plugin.settings.views = []);
    const menu = new Menu();
    for (const v of views) menu.addItem((i) => i.setTitle(v.name).setIcon('bookmark').onClick(() => this.restoreView(v.state)));
    if (views.length) menu.addSeparator();
    menu.addItem((i) => i.setTitle(t('viewSave')).setIcon('bookmark-plus').onClick(() => {
      new NameModal(this.app, t('viewSave'), '', async (name) => {
        const at = views.findIndex((v) => v.name === name);
        const entry = { name, state: this.captureView() };
        if (at >= 0) views[at] = entry; else views.push(entry);
        await this.plugin.saveSettings(); new Notice(t('viewSaved', name));
      }).open();
    }));
    for (const v of views) menu.addItem((i) => i.setTitle(t('viewDelete', v.name)).setIcon('trash').onClick(async () => {
      views.splice(views.indexOf(v), 1); await this.plugin.saveSettings();
    }));
    menu.showAtMouseEvent(e);
  }

  // ============================================================ UI parts
  buildToolbar(root) {
    const bar = root.createDiv({ cls: 'cg-bar' });
    const sw = bar.createDiv({ cls: 'cg-search' });
    this.searchInput = sw.createEl('input', { type: 'search', placeholder: t('search') });
    this.searchList = sw.createDiv({ cls: 'cg-suggest' }); this.searchList.toggle(false);
    let hits = [], hi = 0;
    const render = () => {
      this.searchList.empty();
      hits.forEach((h, i) => {
        const it = this.searchList.createDiv({ cls: 'cg-suggest-item' + (i === hi ? ' is-selected' : '') });
        it.createSpan({ cls: 'cg-dot' }).setCssStyles({ background: h.n.color });
        it.createSpan({ text: h.n.name });
        it.createSpan({ cls: 'cg-suggest-path', text: h.n.folder });
        it.addEventListener('pointerdown', (ev) => { ev.preventDefault(); go(i); });
      });
      this.searchList.toggle(hits.length > 0);
    };
    const go = (i) => { const h = hits[i]; if (!h) return; this.searchInput.value = ''; hits = []; render(); this.searchInput.blur(); this.flyTo(h.n.path); };
    this.registerDomEvent(this.searchInput, 'input', () => {
      const q = this.searchInput.value.trim();
      hits = [];
      if (q && this.notes) {
        const fz = prepareFuzzySearch(q);
        for (const n of this.notes) { const gk = this.G.idx.get(n.path); if (gk == null || this.G.nodes[gk].hidden) continue; const r = fz(n.name); if (r) hits.push({ n, s: r.score }); }
        hits.sort((a, b) => b.s - a.s); hits = hits.slice(0, 8);
      }
      hi = 0; render();
    });
    this.registerDomEvent(this.searchInput, 'keydown', (e) => {
      if (e.key === 'ArrowDown') { hi = Math.min(hits.length - 1, hi + 1); render(); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { hi = Math.max(0, hi - 1); render(); e.preventDefault(); }
      else if (e.key === 'Enter') { go(hi); e.preventDefault(); }
      else if (e.key === 'Escape') { this.searchInput.value = ''; hits = []; render(); this.searchInput.blur(); }
    });
    this.registerDomEvent(this.searchInput, 'blur', () => window.setTimeout(() => { hits = []; render(); }, 150));

    const seg = bar.createDiv({ cls: 'cg-seg' });
    this.btnGlobal = seg.createEl('button', { text: t('global') });
    this.btnLocal = seg.createEl('button', { text: t('local') });
    this.btnGlobal.onclick = () => { this.mode = 'global'; this.focusPath = null; this.updateToolbar(); this.rebuild(true); this.app.workspace.requestSaveLayout(); };
    this.btnLocal.onclick = () => { this.mode = 'local'; this.focusPath = null; this.updateToolbar(); this.rebuild(true); this.app.workspace.requestSaveLayout(); };
    this.depthSeg = bar.createDiv({ cls: 'cg-seg cg-depth' });
    this.depthBtns = [1, 2, 3].map((d) => {
      const b = this.depthSeg.createEl('button', { text: String(d) });
      b.onclick = () => { this.depth = d; this.updateToolbar(); this.rebuild(true); this.app.workspace.requestSaveLayout(); };
      return b;
    });
    const tb = (icon, label, fn) => { const b = bar.createEl('button', { cls: 'cg-tool clickable-icon', attr: { 'aria-label': label } }); setIcon(b, icon); b.onclick = fn; return b; };
    this.btnLabels = tb('type', t('sLabels'), () => { this.plugin.settings.labels = !this.plugin.settings.labels; this.plugin.saveSettings(); this.plugin.refreshViews('style'); this.plugin.views().forEach((v) => v.updateToolbar()); });
    this.btnRotate = tb('rotate-3d', t('rotate'), () => { this.plugin.settings.rotate = !this.plugin.settings.rotate; this.plugin.saveSettings(); this.plugin.refreshViews('style'); });
    this.btnActivity = tb('flame', t('activity'), () => { this.activity = !this.activity; this.plugin.settings.activity = this.activity; this.plugin.saveSettings(); this.updateToolbar(); this.applyHeat(); });
    this.btnReview = tb('calendar-clock', t('reviewTitle'), (e) => this.reviewMenu(e));
    this.btnViews = tb('bookmark', t('viewsTitle'), (e) => this.viewsMenu(e));
    this.btnTime = tb('history', t('tlTitle'), () => this.toggleTimeline());
    this.btnProblems = tb('stethoscope', t('problems'), async () => { this.problems = !this.problems; this.updateToolbar(); await this.rebuild(true); this.R.resetView(); });
    this.btnPanel = tb('sliders-horizontal', t('panel'), () => { const v = !this.panel.isShown(); this.panel.toggle(v); if (v) { this.fillPanel(); this.hideSheet(); } this.updateToolbar(); });
  }

  updateToolbar() {
    if (!this.btnGlobal) return;
    const local = this.mode === 'local' || !!this.focusPath;
    this.btnGlobal.toggleClass('is-active', !local);
    this.btnLocal.toggleClass('is-active', local);
    this.depthSeg.toggle(local);
    this.depthBtns.forEach((b, i) => b.toggleClass('is-active', i + 1 === this.depth));
    this.btnActivity.toggleClass('is-active', this.activity);
    this.btnLabels.toggleClass('is-active', this.plugin.settings.labels);
    this.btnRotate.toggleClass('is-active', !!this.plugin.settings.rotate);
    this.btnProblems.toggleClass('is-active', this.problems);
    this.btnTime.toggleClass('is-active', !!this.tlOn);
    this.btnReview.toggleClass('is-active', !!this.reviewKey);
    if (this.panel) this.btnPanel.toggleClass('is-active', this.panel.isShown());
  }

  buildNav(root) {
    const nav = root.createDiv({ cls: 'cg-nav' });
    this.navMini = !!this.plugin.settings.navMini;
    nav.toggleClass('is-mini', this.navMini);
    const btn = (parent, a, icon, label, cls) => {
      const b = parent.createEl('button', { cls: 'cg-nb' + (cls ? ' ' + cls : ''), attr: { 'aria-label': label, 'data-a': a } });
      setIcon(b, icon); return b;
    };
    const pad = nav.createDiv({ cls: 'cg-pad' });
    pad.createSpan(); btn(pad, 'up', 'chevron-up', t('up')); pad.createSpan();
    btn(pad, 'left', 'chevron-left', t('left')); btn(pad, 'fit', 'maximize', t('fit'), 'cg-fit'); btn(pad, 'right', 'chevron-right', t('right'));
    btn(pad, 'rl', 'rotate-ccw', t('rotL')); btn(pad, 'down', 'chevron-down', t('down')); btn(pad, 'rr', 'rotate-cw', t('rotR'));
    btn(pad, 'zout', 'minus', t('zoomOut')); btn(pad, 'hide', 'move', t('navToggle'), 'cg-navtoggle'); btn(pad, 'zin', 'plus', t('zoomIn'));
    let holdA = null, holdBtn = null, raf = 0, last = 0;
    const loop = (ts) => { if (!holdA) return; const k = Math.min(4, (ts - last) / 16.7); last = ts; this.navStep(holdA, k); raf = window.requestAnimationFrame(loop); };
    const stop = () => { holdA = null; window.cancelAnimationFrame(raf); if (holdBtn) holdBtn.removeClass('is-held'); holdBtn = null; };
    this.registerDomEvent(nav, 'pointerdown', (e) => {
      const b = e.target instanceof Element ? e.target.closest('.cg-nb') : null; if (!b) return;
      e.preventDefault(); e.stopPropagation();
      const a = b.getAttribute('data-a');
      if (a === 'hide') { this.navMini = !this.navMini; nav.toggleClass('is-mini', this.navMini); this.plugin.settings.navMini = this.navMini; this.plugin.saveSettings(); return; }
      if (a === 'fit') { this.navStep('fit', 1); return; }
      stop(); holdA = a; holdBtn = b; b.addClass('is-held');
      try { b.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      this.navStep(a, 8);
      window.setTimeout(() => { if (holdA === a) { last = performance.now(); raf = window.requestAnimationFrame(loop); } }, 220);
    });
    for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) this.registerDomEvent(nav, ev, stop);
    this.register(stop);
  }

  navStep(a, k) {
    const R = this.R; if (!R || !R.active) return;
    const step = 9 * k, zf = Math.pow(1.025, k);
    if (a === 'fit') R.resetView();
    else if (a === 'zin') R.zoomBy(1 / zf); else if (a === 'zout') R.zoomBy(zf);
    else if (a === 'up') R.panBy(0, -step); else if (a === 'down') R.panBy(0, step);
    else if (a === 'left') R.panBy(-step, 0); else if (a === 'right') R.panBy(step, 0);
    else if (a === 'rl') R.orbitBy(0.02 * k, 0); else if (a === 'rr') R.orbitBy(-0.02 * k, 0);
    else if (a === 'tu') R.orbitBy(0, 0.02 * k); else if (a === 'td') R.orbitBy(0, -0.02 * k);
  }

  buildSheet(root) {
    const sh = root.createDiv({ cls: 'cg-sheet' }); sh.toggle(false);
    this.sheet = sh;
    this.sheetTitle = sh.createDiv({ cls: 'cg-sheet-title' });
    this.sheetMeta = sh.createDiv({ cls: 'cg-sheet-meta' });
    this.sheetBtns = sh.createDiv({ cls: 'cg-sheet-btns' });
    const b = (p, txt, fn, cta) => { const el = p.createEl('button', { text: txt, cls: cta ? 'mod-cta' : '' }); el.onclick = fn; return el; };
    b(this.sheetBtns, t('open'), () => { if (this.sel >= 0) this.openNote(this.sel, false); }, true);
    b(this.sheetBtns, t('focus'), () => { const n = this.noteOf(this.sel); if (n) this.focusOn(n.path); });
    b(this.sheetBtns, t('pathFrom'), () => { if (this.sel >= 0) this.startPath(this.sel); });
    this.sheetPathBtns = sh.createDiv({ cls: 'cg-sheet-btns' }); this.sheetPathBtns.toggle(false);
    this.sheetSug = sh.createDiv({ cls: 'cg-sug' });
    b(this.sheetPathBtns, t('pathClear'), () => { this.pathPending = false; this.R.setPath(null); this.hideSheet(); });
  }

  showSheet(k) {
    const nd = this.G.nodes[k];
    if (this.panel.isShown()) return;
    this.sheetTitle.setText(nd.label);
    if (nd.note) {
      const n = nd.note;
      const fold = n.path.includes('/') ? n.path.slice(0, n.path.lastIndexOf('/')) : t('root');
      const when = moment(n.file.stat.mtime).fromNow();
      this.sheetMeta.setText(fold + ' · ' + n.out.size + ' ' + t('links') + ', ' + n.back.size + ' ' + t('backlinks') + (when ? ' · ' + t('modified') + ' ' + when : ''));
      this.sheetBtns.toggle(true);
    } else { this.sheetMeta.setText(t('unresolved')); this.sheetBtns.toggle(false); }
    this.sheetPathBtns.toggle(false);
    this.sheetSug.empty();
    if (this.problems && this.suggestions && nd.note) {
      const mine = this.suggestions.filter((x) => x.from === nd.note.path || x.to === nd.note.path).slice(0, 6);
      if (mine.length) {
        this.sheetSug.createDiv({ cls: 'cg-sug-title', text: t('suggestions') });
        for (const sg of mine) {
          const r = this.sheetSug.createDiv({ cls: 'cg-sug-row' });
          const other = sg.from === nd.note.path ? '→ ' + sg.to.split('/').pop().replace(/\.md$/, '') : '← ' + sg.from.split('/').pop().replace(/\.md$/, '');
          r.createSpan({ text: other + ' („' + sg.text + '“)' });
          const b = r.createEl('button', { text: t('sugLink') });
          b.onclick = async () => { b.disabled = true; await this.applySuggestion(sg); r.remove(); };
        }
      }
    }
    this.sheet.toggle(true);
    this.syncSheetSpace();
  }
  hideSheet() { if (this.sheet) { this.sheet.toggle(false); this.syncSheetSpace(); } }
  syncSheetSpace() {
    const h = this.sheet && this.sheet.isShown() ? this.sheet.offsetHeight + 8 : 0;
    this.rootEl.setCssProps({ '--cg-sheet-h': h + 'px' });
  }

  buildPanel(root) {
    const p = root.createDiv({ cls: 'cg-panel' }); p.toggle(false);
    this.panel = p;
    const head = p.createDiv({ cls: 'cg-panel-head' });
    head.createEl('b', { text: t('panel') });
    const hb = (txt, fn) => { const b = head.createEl('button', { text: txt }); b.onclick = fn; };
    hb(t('relayout'), () => this.relayout());
    hb(t('reset'), () => { this.plugin.resetStyle(); this.fillPanel(); this.R.setStyle(this.styleObj()); this.simSend({ cmd: 'params', params: this.simParams() }); });
    const x = head.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': t('close') } }); setIcon(x, 'x');
    x.onclick = () => { p.toggle(false); this.updateToolbar(); };
    this.panelTabs = p.createDiv({ cls: 'cg-tabs' });
    this.panelBody = p.createDiv({ cls: 'cg-panel-body' });
  }

  fillPanel() {
    if (this.capture) this.capture();
    this.panelBody.empty();
    const body = this.panelBody;
    const st = this.plugin.settings.style;
    const secs = {};
    let sec = body;
    for (const row of PANEL) {
      if (row.length === 1) { sec = body.createDiv({ cls: 'cg-sec-wrap' }); sec.createDiv({ cls: 'cg-sec', text: t(row[0]) }); secs[row[0]] = sec; continue; }
      const [key, min, max, step] = row;
      const wrap = sec.createEl('label', { cls: 'cg-row' });
      const top = wrap.createSpan({ cls: 'cg-row-top' });
      top.createSpan({ text: t(key) });
      const out = top.createEl('b', { text: fmt(st[key], step) });
      const rg = wrap.createEl('input', { type: 'range', attr: { min, max, step } });
      rg.value = String(st[key]);
      rg.oninput = () => { const v = Number(rg.value); out.setText(fmt(v, step)); this.setStyleKey(key, v); };
    }
    const ps = this.plugin.settings;
    const pick = (parent, label, key, opts, def) => {
      const row = parent.createEl('label', { cls: 'cg-row cg-row-check' });
      row.createSpan({ text: t(label) });
      const d = row.createEl('select', { cls: 'dropdown' });
      for (const o of opts) d.createEl('option', { value: o, text: t(key + '_' + o) });
      d.value = ps[key] || def;
      d.onchange = () => { ps[key] = d.value; this.plugin.saveSettings(); this.plugin.views().forEach((v) => v.R && v.R.setStyle(v.styleObj())); };
    };
    if (secs.secForces) {
      const row = secs.secForces.createEl('label', { cls: 'cg-row cg-row-check' });
      row.createSpan({ text: t('baseShape') });
      const d = row.createEl('select', { cls: 'dropdown' });
      for (const o of ['free', 'circle', 'triangle', 'square', 'brain']) d.createEl('option', { value: o, text: t('baseShape_' + o) });
      d.value = ps.shape || 'free';
      d.onchange = async () => {
        ps.shape = d.value; await this.plugin.saveSettings();
        for (const v of this.plugin.views()) { v.sideView = ps.shape === 'brain'; v.relayout(); }
      };
      secs.secForces.insertBefore(row, secs.secForces.children[1] || null);
    }
    if (secs.secLabels) {
      pick(secs.secLabels, 'labelFont', 'labelFont', ['ui', 'text', 'sans', 'serif', 'mono', 'narrow', 'round'], 'ui');
      pick(secs.secLabels, 'labelStyle', 'labelStyle', ['glow', 'shadow', 'pill', 'none'], 'glow');
    }
    const auto = sec.createEl('label', { cls: 'cg-row cg-row-check' });
    auto.createSpan({ text: t('autoShapes') });
    const acb = auto.createEl('input', { type: 'checkbox' }); acb.checked = !!ps.hubStars;
    acb.onchange = () => { ps.hubStars = acb.checked; this.plugin.saveSettings(); this.plugin.views().forEach((w) => w.reshape()); };
    const dr = sec.createEl('label', { cls: 'cg-row cg-row-check' });
    dr.createSpan({ text: t('shapeRest') });
    const sel = dr.createEl('select', { cls: 'dropdown' });
    for (const k of ['kreis', 'ring', 'stern', 'raute', 'quadrat']) sel.createEl('option', { value: k, text: t('shape_' + k) });
    sel.value = ps.shapeDefault || 'kreis';
    sel.onchange = () => { ps.shapeDefault = sel.value; this.plugin.saveSettings(); this.plugin.views().forEach((w) => w.reshape()); };
    this.fillControls(this.panelBody);
    this.buildTabs();
  }

  /* one section per tab, so the graph stays visible while adjusting */
  buildTabs() {
    const pages = [...this.panelBody.children].filter((el) => el.hasClass('cg-sec-wrap') || el.hasClass('cg-controls'));
    const GROUPS = [['tabForces', [0]], ['tabNodes', [1]], ['tabLook', [2, 3]], ['tabControls', [4, 5]]];
    const bar = this.panelTabs; bar.empty();
    const cur = Math.min(GROUPS.length - 1, Math.max(0, this.plugin.settings.panelTab || 0));
    const show = (g) => {
      pages.forEach((pg, k) => pg.toggle(GROUPS[g][1].includes(k)));
      bar.querySelectorAll('.cg-tab').forEach((x, j) => x.toggleClass('is-active', j === g));
    };
    pages.forEach((pg) => pg.addClass('cg-tabpage'));
    GROUPS.forEach(([key], g) => {
      const b = bar.createEl('button', { cls: 'cg-tab', text: t(key) });
      b.onclick = () => { if (this.capture) this.capture(); this.plugin.settings.panelTab = g; this.plugin.saveSettings(); show(g); };
    });
    show(cur);
  }


  fillControls(body) {
    const ps = this.plugin.settings;
    let box = body.createDiv({ cls: 'cg-controls' });
    box.createDiv({ cls: 'cg-sec', text: t('ctrlKeyboard') });
    const save = () => { this.plugin.saveSettings(); this.plugin.views().forEach((v) => { if (v.R) v.R.mouse = ps.mouse; }); };
    const btns = [];
    const relabel = () => btns.forEach(({ b, a, i }) => b.setText(keyLabel(ps.keys[a][i])));
    for (const a of KEY_ACTIONS) {
      const row = box.createDiv({ cls: 'cg-row cg-row-check cg-keyrow' });
      row.createSpan({ text: t('key_' + a) });
      const kb = row.createDiv({ cls: 'cg-keys' });
      for (let i = 0; i < 2; i++) {
        const b = kb.createEl('button', { cls: 'cg-key' });
        btns.push({ b, a, i });
        b.onclick = (ev) => {
          ev.preventDefault();
          if (this.capture) this.capture();
          b.addClass('is-capturing'); b.setText('…');
          const onKey = (e) => {
            e.preventDefault(); e.stopPropagation();
            if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
            if (e.key !== 'Escape') {
              const k = e.key === 'Delete' || e.key === 'Backspace' ? '' : normKey(e.key);
              if (k) for (const x of KEY_ACTIONS) ps.keys[x] = ps.keys[x].map((y) => (normKey(y) === k ? '' : y));
              ps.keys[a] = ps.keys[a].slice(); ps.keys[a][i] = k;
              save();
            }
            this.capture();
          };
          this.capture = () => { window.removeEventListener('keydown', onKey, true); b.removeClass('is-capturing'); this.capture = null; relabel(); };
          window.addEventListener('keydown', onKey, true);
        };
      }
    }
    relabel();
    box.createDiv({ cls: 'cg-ctrl-hint', text: t('ctrlHintKeys') });
    box = body.createDiv({ cls: 'cg-controls' });
    box.createDiv({ cls: 'cg-sec', text: t('ctrlMouse') });
    const sel = (label, key, opts) => {
      const row = box.createDiv({ cls: 'cg-row cg-row-check' });
      row.createSpan({ text: t(label) });
      const s = row.createEl('select', { cls: 'dropdown' });
      for (const o of opts) s.createEl('option', { value: o, text: t('mouse_' + o) });
      s.value = ps.mouse[key];
      s.onchange = () => { ps.mouse[key] = s.value; save(); };
    };
    sel('mouseLeft', 'left', ['rotate', 'pan']);
    sel('mouseRight', 'right', ['pan', 'rotate']);
    sel('mouseMiddle', 'middle', ['pan', 'rotate']);
    sel('mouseShift', 'shift', ['link', 'pan']);
    const inv = box.createEl('label', { cls: 'cg-row cg-row-check' });
    inv.createSpan({ text: t('mouseInvert') });
    const icb = inv.createEl('input', { type: 'checkbox' }); icb.checked = !!ps.mouse.invert;
    icb.onchange = () => { ps.mouse.invert = icb.checked; save(); };
    const sp = box.createEl('label', { cls: 'cg-row' });
    const top = sp.createSpan({ cls: 'cg-row-top' });
    top.createSpan({ text: t('mouseRotSpeed') });
    const out = top.createEl('b', { text: fmt(ps.mouse.rotSpeed, 0.05) });
    const rg = sp.createEl('input', { type: 'range', attr: { min: 0.2, max: 3, step: 0.05 } });
    rg.value = String(ps.mouse.rotSpeed);
    rg.oninput = () => { ps.mouse.rotSpeed = Number(rg.value); out.setText(fmt(ps.mouse.rotSpeed, 0.05)); save(); };
    const pz = box.createEl('label', { cls: 'cg-row' });
    const pt = pz.createSpan({ cls: 'cg-row-top' });
    pt.createSpan({ text: t('mouseRotPause') });
    const po = pt.createEl('b', { text: ps.mouse.rotPause + ' s' });
    const pr = pz.createEl('input', { type: 'range', attr: { min: 0, max: 10, step: 0.5 } });
    pr.value = String(ps.mouse.rotPause);
    pr.oninput = () => { ps.mouse.rotPause = Number(pr.value); po.setText(ps.mouse.rotPause + ' s'); save(); };
    box.createDiv({ cls: 'cg-ctrl-hint', text: t('ctrlHintMouse') });
  }

  setStyleKey(key, v) {
    this.plugin.settings.style[key] = v;
    this.plugin.saveSettingsDebounced();
    if (SHAPE_KEYS.has(key)) { window.clearTimeout(this.shapeT); this.shapeT = window.setTimeout(() => this.reshape(), 60); }
    else if (FORCE_KEYS.has(key)) { window.clearTimeout(this.forceT); this.forceT = window.setTimeout(() => this.simSend({ cmd: 'params', params: this.simParams() }), 60); }
    else this.R.setStyle(this.styleObj());
  }

  /* called by plugin when settings change */
  onSettingsChanged(what) {
    if (!this.R || !this.R.active) return;
    if (what === 'style') { this.R.showLabels = this.plugin.settings.labels; this.R.setStyle(this.styleObj()); this.updateToolbar(); }
    else if (what === 'theme') this.applyTheme();
    else if (what === 'heat') this.applyHeat();
    else { this.sig = ''; this.rebuild(what === 'layout'); }
  }
}

function fmt(v, step) { return step >= 1 ? String(Math.round(v)) : (+v).toFixed(step < 0.1 ? 2 : 1); }

function toHex(c) {
  c = c.trim();
  if (c.startsWith('#')) return c.length === 4 ? '#' + c[1] + c[1] + c[2] + c[2] + c[3] + c[3] : c.slice(0, 7);
  const m = c.match(/rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/);
  if (m) return '#' + [m[1], m[2], m[3]].map((x) => (+x).toString(16).padStart(2, '0')).join('');
  return '#1e1e1e';
}

class NameModal extends Modal {
  constructor(app, title, value, onOk) { super(app); this.title = title; this.value = value; this.onOk = onOk; }
  onOpen() {
    this.titleEl.setText(this.title);
    let val = this.value;
    const go = () => { const v = (val || '').trim(); if (v) { this.close(); this.onOk(v); } };
    new Setting(this.contentEl).setName(t('viewName')).addText((tx) => {
      tx.setValue(val).onChange((v) => { val = v; });
      tx.inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
      window.setTimeout(() => tx.inputEl.focus(), 30);
    });
    new Setting(this.contentEl).addButton((b) => b.setButtonText(t('viewSaveBtn')).setCta().onClick(go));
  }
  onClose() { this.contentEl.empty(); }
}

/* invisible folder nodes: every note hangs on its folder, folders on their parent folder */
function addFolderAnchors(G) {
  const anchors = new Map();
  const anchorOf = (folder) => {
    if (anchors.has(folder)) return anchors.get(folder);
    const k = G.nodes.length;
    G.nodes.push({ key: 'folder:' + folder, note: null, anchor: true, label: folder.split('/').pop(), deg: 0, x: 0, y: 0, z: 0 });
    anchors.set(folder, k);
    if (folder.includes('/')) { const p = anchorOf(folder.slice(0, folder.lastIndexOf('/'))); G.edges.push([p, k]); G.nodes[p].deg++; G.nodes[k].deg++; }
    return k;
  };
  const n0 = G.nodes.length;
  for (let k = 0; k < n0; k++) {
    const nd = G.nodes[k];
    if (!nd.note || nd.hidden || !nd.note.path.includes('/')) continue;
    const a = anchorOf(nd.note.path.slice(0, nd.note.path.lastIndexOf('/')));
    G.edges.push([k, a]); G.nodes[a].deg++;
  }
  for (let i = 0; i < anchors.size; i++) G.adj.push([]);
  G.idx = new Map(G.nodes.map((nd, k) => [nd.key, k]));
}

/* after a recording: preview, then save as (download), save into the vault or discard */
class RecordingModal extends Modal {
  constructor(view, blob, name) { super(view.app); this.view = view; this.blob = blob; this.name = name; }
  onOpen() {
    const { contentEl } = this;
    this.titleEl.setText(t('recTitle'));
    this.url = URL.createObjectURL(this.blob);
    const vid = contentEl.createEl('video', { cls: 'cg-rec-preview', attr: { controls: '', autoplay: '', muted: '', loop: '' } });
    vid.src = this.url;
    let name = this.name;
    new Setting(contentEl).setName(t('recName')).addText((tx) => tx.setValue(name).onChange((v) => { name = v; }));
    const fix = () => { const ext = this.name.slice(this.name.lastIndexOf('.')); return name.endsWith(ext) ? name : name + ext; };
    new Setting(contentEl)
      .addButton((b) => b.setButtonText(t('recDiscard')).setWarning().onClick(() => this.close()))
      .addButton((b) => b.setButtonText(t('recToVault')).onClick(async () => { await this.view.saveToVault(this.blob, fix(), true); this.close(); }))
      .addButton((b) => b.setButtonText(t('recSaveAs')).setCta().onClick(() => {
        const a = document.createElement('a'); a.href = this.url; a.download = fix(); document.body.appendChild(a); a.click(); a.remove();
        window.setTimeout(() => this.close(), 1500);
      }));
  }
  onClose() { this.contentEl.empty(); if (this.url) window.setTimeout(() => URL.revokeObjectURL(this.url), 3000); }
}
