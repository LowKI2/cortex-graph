import { ItemView, Menu, Notice, TFile, getAllTags, prepareFuzzySearch, setIcon, debounce, Platform, moment } from 'obsidian';
import { GraphRenderer } from './renderer';
import { buildGraph, parseGraphCfg, assignColors, shortestPath, signature, heatOf, PROBLEM_COLORS } from './model';
import { t } from './i18n';
import SIM_SRC from './sim.worker.js';

export const VIEW_TYPE = 'cortex-graph-view';

export const STYLE_KEYS = ['center', 'repel', 'link', 'dist', 'nodeSize', 'degSize', 'glow', 'line', 'font', 'fontGrow', 'boldFrom', 'labelFrom', 'maxLabels'];
const FORCE_KEYS = new Set(['center', 'repel', 'link', 'dist']);
const PANEL = [
  ['secForces'], ['center', 0, 1, 0.01], ['repel', 0, 20, 0.1], ['link', 0, 1, 0.01], ['dist', 8, 150, 1],
  ['secNodes'], ['nodeSize', 0.3, 3, 0.05], ['degSize', 0, 3, 0.05], ['glow', 0.2, 2.5, 0.05], ['line', 0.2, 3, 0.05],
  ['secLabels'], ['font', 8, 22, 1], ['fontGrow', 0, 2, 0.05], ['boldFrom', 1, 60, 1], ['labelFrom', 0, 60, 1], ['maxLabels', 0, 200, 5],
];
const KEYNAV = { '+': 'zin', '=': 'zin', '-': 'zout', ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  w: 'up', s: 'down', a: 'left', d: 'right', q: 'rl', e: 'rr', 0: 'fit', f: 'fit' };

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
    this.legend = root.createDiv({ cls: 'cg-legend' }); this.legend.toggle(false);
    this.buildToolbar(root);
    this.buildNav(root);
    this.buildSheet(root);
    this.buildPanel(root);

    this.R = new GraphRenderer(this.canvas, this.labels, this.anchor);
    if (!this.R.active) { root.createDiv({ cls: 'cg-empty', text: t('noWebgl') }); return; }
    this.R.showLabels = this.plugin.settings.labels;
    this.R.setStyle(this.styleObj());
    this.applyTheme();
    this.R.onTap = (k, dbl, e) => this.onTap(k, dbl, e);
    this.R.onDrag = (k, x, y, z) => this.simSend({ cmd: 'pin', i: k, x, y, z });
    this.R.onDragEnd = (k) => this.simSend({ cmd: 'unpin', i: k });
    this.R.onHover = (k, e) => this.onHover(k, e);
    this.R.onContext = (k, e) => this.onContext(k, e);

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
    root.tabIndex = 0;

    this.updateToolbar();
    await this.rebuild(true);
  }

  async onClose() {
    this.stopWorker();
    if (this.R) this.R.dispose();
    this.R = null;
  }

  styleObj() { const s = this.plugin.settings; const o = { rotate: s.rotate }; for (const k of STYLE_KEYS) o[k] = s.style[k]; return o; }
  simParams() { const s = this.plugin.settings.style; return { center: s.center, repel: s.repel, link: s.link, dist: s.dist }; }

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
  collect() {
    const app = this.app, files = app.vault.getMarkdownFiles();
    const byPath = new Map();
    const notes = files.map((f, i) => {
      const cache = app.metadataCache.getFileCache(f);
      const tags = cache ? (getAllTags(cache) || []).map((x) => x.replace(/^#/, '')) : [];
      const n = { i, file: f, path: f.path, name: f.basename, folder: f.path.includes('/') ? f.path.split('/')[0] : '',
        tags, fm: (cache && cache.frontmatter) || {}, mtime: f.stat.mtime, ctime: f.stat.ctime, out: new Set(), back: new Set(), unresolved: [] };
      byPath.set(f.path, n);
      return n;
    });
    const rl = app.metadataCache.resolvedLinks || {}, ul = app.metadataCache.unresolvedLinks || {};
    for (const src in rl) {
      const a = byPath.get(src); if (!a) continue;
      for (const dst in rl[src]) { const b = byPath.get(dst); if (b && b !== a) { a.out.add(b.i); b.back.add(a.i); } }
    }
    for (const src in ul) { const a = byPath.get(src); if (a) a.unresolved = Object.keys(ul[src]); }
    return { notes, byPath };
  }

  async readGraphCfg() {
    try {
      const p = this.app.vault.configDir + '/graph.json';
      if (await this.app.vault.adapter.exists(p)) return parseGraphCfg(await this.app.vault.adapter.read(p));
    } catch { /* ignore */ }
    return parseGraphCfg(null);
  }

  async rebuild(force) {
    if (!this.R || !this.R.active) return;
    const s = this.plugin.settings;
    const { notes, byPath } = this.collect();
    const cfg = await this.readGraphCfg();
    assignColors(notes, cfg, s.colorBy);
    this.notes = notes; this.byPath = byPath;
    let focus = null;
    if (this.mode === 'local') {
      const f = this.app.workspace.getActiveFile();
      const n = f && byPath.get(f.path);
      focus = n ? n.i : null;
      if (focus == null && !force && this.G.nodes.length) return; // keep last local graph
    } else if (this.focusPath && byPath.has(this.focusPath)) focus = byPath.get(this.focusPath).i;
    const G = buildGraph(notes, { focus, depth: this.depth, orphans: s.orphans, filter: s.filters && cfg.has ? cfg : null, problems: this.problems });
    const sig = signature(G) + '|' + this.mode + '|' + s.layout;
    const prevSel = this.sel >= 0 && this.G.nodes[this.sel] ? this.G.nodes[this.sel].key : null;
    if (!force && sig === this.sig) { // same structure: refresh colors + heat only
      G.nodes.forEach((nd, k) => { if (this.G.nodes[k]) { this.G.nodes[k].note = nd.note; this.G.nodes[k].kind = nd.kind; } }); this.G.stats = G.stats;
      this.R.refreshColors(); this.applyHeat(); this.applyOverlay(); this.updateInfo();
      return;
    }
    // keep positions of known nodes
    const old = new Map(this.G.nodes.map((nd) => [nd.key, nd]));
    this.G = G; this.sig = sig;
    this.sel = -1; this.pathFrom = -1; this.pathPending = false; this.R.setPath(null); this.hideSheet();
    await this.layout(old, focus);
    if (prevSel && G.idx.has(prevSel)) this.select(G.idx.get(prevSel), false);
    else if (focus != null) { const k = G.idx.get(notes[focus].path); if (k != null) this.select(k, false); }
    this.applyHeat(); this.applyOverlay(); this.updateInfo();
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
    w.postMessage({ cmd: 'init', n, dim: flat ? 2 : 3, edges, pos, params: this.simParams(), alpha: alpha0 });
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

  applyOverlay() {
    if (!this.R) return;
    this.legend.empty(); this.legend.toggle(this.problems);
    if (!this.problems) { this.R.setOverlay(null, null); return; }
    const colors = [], bright = new Set();
    this.G.nodes.forEach((nd, k) => { if (nd.kind) { colors[k] = PROBLEM_COLORS[nd.kind]; bright.add(k); } else colors[k] = null; });
    // edges into unresolved ghosts: keep source visible
    for (const [a, b] of this.G.edges) if (this.G.nodes[b].ghost) bright.add(a);
    this.R.setOverlay(colors, bright);
    for (const kind of ['orphan', 'deadEnd', 'unresolved']) {
      const row = this.legend.createDiv({ cls: 'cg-legend-row' });
      row.createSpan({ cls: 'cg-dot' }).setCssStyles({ background: PROBLEM_COLORS[kind] });
      row.createSpan({ text: t(kind) + ' ' });
      row.createEl('b', { text: String(this.G.stats[kind] || 0) });
    }
  }

  updateInfo() {
    const G = this.G;
    const real = G.nodes.filter((nd) => !nd.ghost).length;
    this.info.setText(real + ' ' + t('notes') + ' · ' + G.edges.length + ' ' + t('links'));
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
    if (k < 0) { if (this.pathPending) return; this.select(-1); return; }
    if (this.pathPending) { this.finishPath(k); return; }
    const mod = e && (e.ctrlKey || e.metaKey);
    if (this.noteOf(k) && (mod || dbl || this.plugin.settings.clickOpens)) { this.openNote(k, mod); if (!this.plugin.settings.clickOpens) return; }
    this.select(k, true);
  }

  select(k, fly) {
    this.sel = k;
    if (this.R.pathSet) this.R.setPath(null);
    this.R.setSelected(k);
    if (k < 0) { this.hideSheet(); return; }
    if (fly && Platform.isMobile) this.R.focusNode(k);
    this.showSheet(k);
  }

  onHover(k, e) {
    this.anchor.toggleClass('is-active', k >= 0);
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
    if (k == null) { new Notice(t('notInGraph')); return; }
    this.select(k, false); this.R.focusNode(k);
  }

  onKey(e) {
    if (e.target instanceof HTMLInputElement) return;
    if (e.key === 'Escape') { if (this.pathPending || this.R.pathSet) { this.pathPending = false; this.R.setPath(null); this.hideSheet(); } else this.select(-1); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const a = KEYNAV[e.key];
    if (a) { e.preventDefault(); this.navStep(a, a === 'fit' ? 1 : 6); }
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
        for (const n of this.notes) { if (!this.G.idx.has(n.path)) continue; const r = fz(n.name); if (r) hits.push({ n, s: r.score }); }
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
    this.btnActivity = tb('flame', t('activity'), () => { this.activity = !this.activity; this.plugin.settings.activity = this.activity; this.plugin.saveSettings(); this.updateToolbar(); this.applyHeat(); });
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
    this.btnProblems.toggleClass('is-active', this.problems);
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
    this.panelBody = p.createDiv({ cls: 'cg-panel-body' });
  }

  fillPanel() {
    const body = this.panelBody; body.empty();
    const st = this.plugin.settings.style;
    for (const row of PANEL) {
      if (row.length === 1) { body.createDiv({ cls: 'cg-sec', text: t(row[0]) }); continue; }
      const [key, min, max, step] = row;
      const wrap = body.createEl('label', { cls: 'cg-row' });
      const top = wrap.createSpan({ cls: 'cg-row-top' });
      top.createSpan({ text: t(key) });
      const out = top.createEl('b', { text: fmt(st[key], step) });
      const rg = wrap.createEl('input', { type: 'range', attr: { min, max, step } });
      rg.value = String(st[key]);
      rg.oninput = () => { const v = Number(rg.value); out.setText(fmt(v, step)); this.setStyleKey(key, v); };
    }
    const wrap = body.createEl('label', { cls: 'cg-row cg-row-check' });
    wrap.createSpan({ text: t('rotate') });
    const cb = wrap.createEl('input', { type: 'checkbox' }); cb.checked = this.plugin.settings.rotate;
    cb.onchange = () => { this.plugin.settings.rotate = cb.checked; this.plugin.saveSettings(); this.plugin.refreshViews('style'); };
  }

  setStyleKey(key, v) {
    this.plugin.settings.style[key] = v;
    this.plugin.saveSettingsDebounced();
    if (FORCE_KEYS.has(key)) { window.clearTimeout(this.forceT); this.forceT = window.setTimeout(() => this.simSend({ cmd: 'params', params: this.simParams() }), 60); }
    else this.R.setStyle(this.styleObj());
  }

  /* called by plugin when settings change */
  onSettingsChanged(what) {
    if (!this.R || !this.R.active) return;
    if (what === 'style') { this.R.showLabels = this.plugin.settings.labels; this.R.setStyle(this.styleObj()); }
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
