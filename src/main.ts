import { App, Debouncer, Plugin, PluginSettingTab, Setting, FuzzySuggestModal, Modal, Notice, TAbstractFile, TFolder, TFile, FileSystemAdapter, debounce, getAllTags } from 'obsidian';
import type { CGSettings, GraphCfg, Note, StyleSettings, ThemeOptions } from './types';

const HOOK_URL = 'https://github.com/LowKI2/cortex-graph/blob/main/tools/cortex-activity-hook.mjs';
const vaultBase = (app: App): string => (app.vault.adapter instanceof FileSystemAdapter ? app.vault.adapter.getBasePath() : '').replace(/\\/g, '/');
import { parseGraphCfg } from './model';
import { FolderColors } from './folders';
import { CortexGraphView, VIEW_TYPE, DEFAULT_KEYS, DEFAULT_MOUSE, KEY_ACTIONS } from './view';
import { t } from './i18n';

export const SHAPES = ['kreis', 'ring', 'stern', 'raute', 'quadrat'];
const STYLE_DEFAULTS: StyleSettings = { shapeSize: 1, shapeGroup: 0.4, hubPull: 0.5, center: 2.25, repel: 5.6, link: 0.09, dist: 8, range: 120, nodeSize: 0.35, degSize: 0.75, glow: 1.3, line: 0.7,
  font: 3, fontGrow: 1.05, boldFrom: 28, labelFrom: 3, maxLabels: 80, dimOthers: 0.1, nodeBright: 0.55, glowBright: 1, shStern: 0, shRaute: 0, shQuadrat: 0, shRing: 0.5 };
export const THEME_DEFAULTS: ThemeOptions = { color: 'violet', textFont: 'inter', headFont: 'grotesk', stars: true, starsMotion: false, nebula: true, headingGlow: true, gradient: true, checkboxes: true };
const THEME_COLORS = ['violet', 'cyan', 'amber', 'emerald'];
/* every body class the Cortex theme reacts to */
const THEME_CLASSES = [...THEME_COLORS.map((c) => 'cortex-' + c), 'cortex-font-system', 'cortex-headings-text', 'cortex-no-stars', 'cortex-stars-motion',
  'cortex-no-nebula', 'cortex-no-heading-glow', 'cortex-no-rainbow-headings', 'cortex-no-alt-checkboxes'];
const DEFAULTS: CGSettings = {
  layout: '3d', shape: 'free', background: 'space', colorBy: 'obsidian', filters: true, orphans: false, labels: true, rotate: true,
  clickOpens: false, activity: true, halfLife: 24, depth: 1, navMini: false, explorerColors: 'rows', folderColors: {}, folderWeights: {}, hiddenFolders: [], folderLinks: 'hidden', rankBy: 'auto', recSave: 'ask', focusCamera: true, staleDays: 90, shapeDefault: 'kreis', hubStars: false, folderShapes: {}, noteShapes: {}, noteWeights: {}, claudeLive: true, galaxies: true, views: [], style: Object.assign({}, STYLE_DEFAULTS), keys: {}, mouse: Object.assign({}, DEFAULT_MOUSE), themeOpts: Object.assign({}, THEME_DEFAULTS),
};

type PositionMap = Record<string, number[]>;

export default class CortexGraphPlugin extends Plugin {
  settings: CGSettings;
  saveSettingsDebounced: Debouncer<[], void>;
  startedAt = 0;
  externalWrites = new Set<string>();
  lastEdit = new Map<string, number>();
  selfWrites = new Map<string, number>();
  logPos = -1;
  fc: FolderColors;
  posCache: Record<string, PositionMap> | undefined;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.saveSettingsDebounced = debounce(() => { void this.saveSettings(); }, 400, true);
    this.applyThemeOptions();
    this.registerView(VIEW_TYPE, (leaf) => new CortexGraphView(leaf, this));
    this.registerHoverLinkSource(VIEW_TYPE, { display: 'Cortex Graph', defaultMod: true });
    this.addRibbonIcon('orbit', t('cmdOpen'), () => { void this.openGraph('global'); });
    this.addCommand({ id: 'open', name: t('cmdOpen'), callback: () => { void this.openGraph('global'); } });
    this.addCommand({ id: 'open-local', name: t('cmdOpenLocal'), callback: () => { void this.openGraph('local'); } });
    this.addCommand({
      id: 'relayout', name: t('cmdRelayout'),
      checkCallback: (checking) => { const v = this.activeGraph(); if (!v) return false; if (!checking) v.relayout(); return true; },
    });
    this.addCommand({ id: 'find-path', name: t('cmdPath'), callback: () => this.findPath() });
    this.addSettingTab(new CortexGraphSettingTab(this.app, this));

    // live activity: Claude (or any tool) reading / writing notes
    this.startedAt = Date.now();
    this.registerEvent(this.app.workspace.on('editor-change', (ed, info) => { if (info && info.file) this.lastEdit.set(info.file.path, Date.now()); }));
    const onExternal = (file: TAbstractFile) => {
      if (!(file instanceof TFile) || file.extension !== 'md') return;
      const now = Date.now();
      if (now - (this.lastEdit.get(file.path) || 0) < 4000 || now - (this.selfWrites.get(file.path) || 0) < 4000) return;
      if (now - this.startedAt < 8000) return; // ignore the start-up sync
      this.activity(file.path, 'write');
    };
    this.registerEvent(this.app.vault.on('modify', onExternal));
    this.registerEvent(this.app.vault.on('create', onExternal));
    this.logPos = -1;
    this.registerInterval(window.setInterval(() => { void this.pollActivityLog(); }, 1200));

    // folder colors in the file explorer
    this.fc = new FolderColors(this);
    this.app.workspace.onLayoutReady(() => { this.fc.watch(); void this.fc.refresh(); });
    this.registerEvent(this.app.workspace.on('layout-change', () => { this.fc.watch(); this.fc.requestApply(); }));
    this.registerEvent(this.app.metadataCache.on('resolved', () => this.fc.requestRefresh()));
    this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => this.fc.addMenu(menu, file)));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      let changed = false;
      for (const m of [this.settings.noteShapes, this.settings.noteWeights]) {
        for (const k of Object.keys(m)) if (k === oldPath || k.startsWith(oldPath + '/')) { m[file.path + k.slice(oldPath.length)] = m[k]; delete m[k]; changed = true; }
      }
      if (!(file instanceof TFolder)) { if (changed) void this.saveSettings(); return; }
      for (const fc of [this.settings.folderColors, this.settings.folderWeights, this.settings.folderShapes] as Record<string, unknown>[]) {
        for (const k of Object.keys(fc)) if (k === oldPath || k.startsWith(oldPath + '/')) { fc[file.path + k.slice(oldPath.length)] = fc[k]; delete fc[k]; changed = true; }
      }
      const hf = this.settings.hiddenFolders;
      hf.forEach((k, i) => { if (k === oldPath || k.startsWith(oldPath + '/')) { hf[i] = file.path + k.slice(oldPath.length); changed = true; } });
      if (changed) void this.saveSettings();
      this.fc.requestRefresh();
    }));
  }

  markSelf(path: string): void { this.selfWrites.set(path, Date.now()); }

  activity(path: string, op: 'read' | 'write'): void {
    if (!this.settings.claudeLive) return;
    if (op === 'write') this.externalWrites.add(path);
    for (const v of this.views()) v.onActivity(path, op);
  }

  /* <vault>/.cortex/activity.jsonl: one JSON object per line {"op":"read"|"write","path":"..."} – written by the
     Cortex MCP server or a Claude Code hook, so reads become visible too */
  async pollActivityLog(): Promise<void> {
    const ad = this.app.vault.adapter, p = '.cortex/activity.jsonl';
    try {
      const st = await ad.stat(p);
      if (!st) return;
      if (this.logPos < 0) { this.logPos = st.size; return; } // start at the end
      if (st.size === this.logPos) return;
      const txt = await ad.read(p);
      const from = st.size < this.logPos ? 0 : this.logPos;
      const chunk = new TextEncoder().encode(txt).slice(from);
      this.logPos = st.size;
      for (const line of new TextDecoder().decode(chunk).split('\n')) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line) as { op?: string; path?: string };
          let path = (typeof ev.path === 'string' ? ev.path : '').replace(/\\/g, '/');
          const base = vaultBase(this.app);
          if (base && path.toLowerCase().startsWith(base.toLowerCase() + '/')) path = path.slice(base.length + 1);
          if (path) this.activity(path, ev.op === 'write' ? 'write' : 'read');
        } catch { /* skip broken line */ }
      }
      if (st.size > 256000) { await ad.write(p, ''); this.logPos = 0; }
    } catch { /* no log file */ }
  }

  // ------------------------------------------------ shared data access
  collect(): { notes: Note[]; byPath: Map<string, Note> } {
    const app = this.app, files = app.vault.getMarkdownFiles();
    const byPath = new Map<string, Note>();
    const notes = files.map((f, i): Note => {
      const cache = app.metadataCache.getFileCache(f);
      const tags = cache ? (getAllTags(cache) || []).map((x) => x.replace(/^#/, '')) : [];
      const n = { i, file: f, path: f.path, name: f.basename, folder: f.path.includes('/') ? f.path.split('/')[0] : '',
        tags, fm: (cache && cache.frontmatter) || {}, mtime: f.stat.mtime, ctime: f.stat.ctime, out: new Set<number>(), back: new Set<number>(), unresolved: [] as string[] };
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

  async readGraphCfg(): Promise<GraphCfg> {
    try {
      const p = this.app.vault.configDir + '/graph.json';
      if (await this.app.vault.adapter.exists(p)) return parseGraphCfg(await this.app.vault.adapter.read(p));
    } catch { /* ignore */ }
    return parseGraphCfg(null);
  }

  onunload(): void {
    if (this.fc) this.fc.clear();
    document.body.removeClasses(THEME_CLASSES);
    try { delete (window as unknown as { __THREE__?: string }).__THREE__; } catch { /* ignore */ }
  }

  async loadSettings(): Promise<void> {
    const d = ((await this.loadData()) as Partial<CGSettings> | null) || {};
    this.settings = Object.assign({}, DEFAULTS, d);
    this.settings.folderColors = Object.assign({}, d.folderColors || {});
    this.settings.folderWeights = Object.assign({}, d.folderWeights || {});
    this.settings.folderShapes = Object.assign({}, d.folderShapes || {});
    this.settings.noteShapes = Object.assign({}, d.noteShapes || {});
    this.settings.noteWeights = Object.assign({}, d.noteWeights || {});
    this.settings.hiddenFolders = Array.isArray(d.hiddenFolders) ? d.hiddenFolders.slice() : [];
    this.settings.views = Array.isArray(d.views) ? d.views.slice() : [];
    this.settings.style = Object.assign({}, STYLE_DEFAULTS, d.style || {});
    // 3.1.0: Leuchten is now the glow radius and Linienstärke the line brightness again – start those two fresh
    const migrate = (d.styleRev || 0) < 3 && !!d.style;
    if (migrate) { this.settings.style.glow = STYLE_DEFAULTS.glow; this.settings.style.line = STYLE_DEFAULTS.line; }
    this.settings.styleRev = 3;
    this.settings.keys = {};
    for (const a of KEY_ACTIONS) this.settings.keys[a] = (d.keys && Array.isArray(d.keys[a]) ? d.keys[a] : DEFAULT_KEYS[a]).slice(0, 2);
    this.settings.mouse = Object.assign({}, DEFAULT_MOUSE, d.mouse || {});
    this.settings.themeOpts = Object.assign({}, THEME_DEFAULTS, d.themeOpts || {});
    if (migrate) await this.saveData(this.settings);
  }
  /* Cortex theme options: classes on <body>, the theme's CSS does the rest */
  applyThemeOptions(): void {
    const o = this.settings.themeOpts, b = document.body;
    b.removeClasses(THEME_CLASSES);
    b.addClass('cortex-' + (THEME_COLORS.includes(o.color) ? o.color : 'violet'));
    if (o.textFont === 'system') b.addClass('cortex-font-system');
    if (o.headFont === 'text') b.addClass('cortex-headings-text');
    if (!o.stars) b.addClass('cortex-no-stars');
    if (o.starsMotion) b.addClass('cortex-stars-motion');
    if (!o.nebula) b.addClass('cortex-no-nebula');
    if (!o.headingGlow) b.addClass('cortex-no-heading-glow');
    if (!o.gradient) b.addClass('cortex-no-rainbow-headings');
    if (!o.checkboxes) b.addClass('cortex-no-alt-checkboxes');
    this.refreshViews('theme');
  }
  themeActive(): boolean { return getComputedStyle(document.body).getPropertyValue('--cortex-accent').trim() !== ''; }

  async saveSettings(): Promise<void> { await this.saveData(this.settings); }
  resetStyle(): void {
    this.settings.style = Object.assign({}, STYLE_DEFAULTS);
    this.settings.keys = {}; for (const a of KEY_ACTIONS) this.settings.keys[a] = DEFAULT_KEYS[a].slice();
    Object.assign(this.settings.mouse, DEFAULT_MOUSE);
    void this.saveSettings();
  }

  views(): CortexGraphView[] { return this.app.workspace.getLeavesOfType(VIEW_TYPE).map((l) => l.view).filter((v): v is CortexGraphView => v instanceof CortexGraphView); }
  activeGraph(): CortexGraphView | null { const v = this.app.workspace.getActiveViewOfType(CortexGraphView); return v || this.views()[0] || null; }
  refreshViews(what: string): void { for (const v of this.views()) v.onSettingsChanged(what); }

  async openGraph(mode: 'global' | 'local'): Promise<CortexGraphView | null> {
    const ws = this.app.workspace;
    const existing = this.views().find((v) => v.mode === mode);
    if (existing) { void ws.revealLeaf(existing.leaf); return existing; }
    const leaf = mode === 'local' ? ws.getRightLeaf(false) : ws.getLeaf('tab');
    if (!leaf) return null;
    await leaf.setViewState({ type: VIEW_TYPE, active: true, state: { mode, depth: this.settings.depth } });
    void ws.revealLeaf(leaf);
    return leaf.view instanceof CortexGraphView ? leaf.view : null;
  }

  findPath(): void {
    const files = this.app.vault.getMarkdownFiles();
    new NotePicker(this.app, files, t('pickFrom'), (a) => {
      new NotePicker(this.app, files, t('pickTo'), async (b) => {
        let v = this.views().find((x) => x.mode === 'global' && !x.focusPath);
        if (!v) v = await this.openGraph('global');
        if (!v) return;
        void this.app.workspace.revealLeaf(v.leaf);
        const tryIt = (n: number): void => { if (v.G && v.G.idx.size) v.showPathBetween(a.path, b.path); else if (n > 0) window.setTimeout(() => tryIt(n - 1), 300); };
        tryIt(20);
      }).open();
    }).open();
  }

  // ------------------------------------------------ saved layout positions (separate file, can be large)
  posFile(flat: boolean): string { return this.manifest.dir + (flat ? '/positions-flat.json' : '/positions.json'); }
  async loadPositions(flat: boolean): Promise<PositionMap> {
    const key = flat ? 'flat' : '3d';
    if (this.posCache && this.posCache[key]) return this.posCache[key];
    let data: PositionMap = {};
    try { const p = this.posFile(flat); if (await this.app.vault.adapter.exists(p)) data = (JSON.parse(await this.app.vault.adapter.read(p)) as PositionMap) || {}; } catch { data = {}; }
    (this.posCache ||= {})[key] = data;
    return data;
  }
  async savePositions(flat: boolean, map: PositionMap | null): Promise<void> {
    const key = flat ? 'flat' : '3d';
    const data = map ? Object.assign(await this.loadPositions(flat), map) : {};
    (this.posCache ||= {})[key] = data;
    try { await this.app.vault.adapter.write(this.posFile(flat), JSON.stringify(data)); } catch { /* ignore */ }
  }
}

class NotePicker extends FuzzySuggestModal<TFile> {
  files: TFile[]; onPick: (f: TFile) => void | Promise<void>;
  constructor(app: App, files: TFile[], placeholder: string, onPick: (f: TFile) => void | Promise<void>) { super(app); this.files = files; this.onPick = onPick; this.setPlaceholder(placeholder); }
  getItems(): TFile[] { return this.files; }
  getItemText(f: TFile): string { return f.path.replace(/\.md$/, ''); }
  onChooseItem(f: TFile): void { void this.onPick(f); }
}

class CortexGraphSettingTab extends PluginSettingTab {
  plugin: CortexGraphPlugin;
  constructor(app: App, plugin: CortexGraphPlugin) { super(app, plugin); this.plugin = plugin; }
  display(): void {
    const el = this.containerEl, s = this.plugin.settings, p = this.plugin;
    el.empty();
    const save = (what: string) => { void p.saveSettings(); p.refreshViews(what); };
    new Setting(el).setName(t('sDisplay')).setHeading();
    new Setting(el).setName(t('sLayout')).setDesc(t('sLayoutDesc')).addDropdown((d) => d
      .addOption('3d', t('s3d')).addOption('flat', t('sFlat')).setValue(s.layout)
      .onChange((v) => { s.layout = v; save('layout'); }));
    new Setting(el).setName(t('sBackground')).setDesc(t('sBackgroundDesc')).addDropdown((d) => d
      .addOption('space', t('sSpace')).addOption('theme', t('sTheme')).setValue(s.background)
      .onChange((v) => { s.background = v; save('theme'); }));
    new Setting(el).setName(t('sColorBy')).setDesc(t('sColorByDesc')).addDropdown((d) => d
      .addOption('obsidian', t('sColorObsidian')).addOption('folder', t('sColorFolder')).addOption('none', t('sColorNone')).setValue(s.colorBy)
      .onChange((v) => { s.colorBy = v; save('data'); void p.fc.refresh(); }));
    new Setting(el).setName(t('sExplorer')).setDesc(t('sExplorerDesc')).addDropdown((d) => d
      .addOption('rows', t('sExplorerRows')).addOption('folders', t('sExplorerFolders')).addOption('off', t('sExplorerOff')).setValue(s.explorerColors)
      .onChange((v) => { s.explorerColors = v; void p.saveSettings(); p.fc.apply(); }));
    new Setting(el).setName(t('sFilters')).setDesc(t('sFiltersDesc')).addToggle((tg) => tg.setValue(s.filters).onChange((v) => { s.filters = v; save('data'); }));
    new Setting(el).setName(t('sRankBy')).setDesc(t('sRankByDesc')).addDropdown((d) => d
      .addOption('auto', t('sRankAuto')).addOption('links', t('sRankLinks')).setValue(s.rankBy)
      .onChange((v) => { s.rankBy = v; save('data'); }));
    new Setting(el).setName(t('sFolderLinks')).setDesc(t('sFolderLinksDesc')).addDropdown((d) => d
      .addOption('off', t('sFlOff')).addOption('hidden', t('sFlHidden')).addOption('lines', t('sFlLines')).setValue(s.folderLinks)
      .onChange((v) => { s.folderLinks = v; save('layout'); }));
    new Setting(el).setName(t('sGalaxies')).setDesc(t('sGalaxiesDesc')).addToggle((tg) => tg.setValue(s.galaxies !== false).onChange((v) => { s.galaxies = v; void p.saveSettings(); }));
    new Setting(el).setName(t('sOrphans')).addToggle((tg) => tg.setValue(s.orphans).onChange((v) => { s.orphans = v; save('data'); }));
    new Setting(el).setName(t('sLabels')).addToggle((tg) => tg.setValue(s.labels).onChange((v) => { s.labels = v; save('style'); p.views().forEach((w) => w.updateToolbar()); }));
    new Setting(el).setName(t('sRotate')).addToggle((tg) => tg.setValue(s.rotate).onChange((v) => { s.rotate = v; save('style'); }));
    new Setting(el).setName(t('sShapeDefault')).setDesc(t('sShapeDesc')).addDropdown((d) => { for (const k of SHAPES) d.addOption(k, t('shape_' + k)); d.setValue(s.shapeDefault).onChange((v) => { s.shapeDefault = v; save('data'); }); });
    new Setting(el).setName(t('autoShapes')).setDesc(t('autoShapesDesc')).addToggle((tg) => tg.setValue(s.hubStars).onChange((v) => { s.hubStars = v; save('data'); }));
    new Setting(el).setName(t('sStale')).setDesc(t('sStaleDesc')).addSlider((sl) => sl.setLimits(0, 365, 5).setValue(s.staleDays).setDynamicTooltip()
      .onChange((v) => { s.staleDays = v; save('heat'); }));
    new Setting(el).setName(t('sThemeHead')).setDesc(p.themeActive() ? t('sThemeDesc') : t('sThemeDesc') + ' ' + t('sThemeInactive')).setHeading();
    const th = s.themeOpts;
    const thSave = () => { void p.saveSettings(); p.applyThemeOptions(); };
    new Setting(el).setName(t('sThemeColor')).setDesc(t('sThemeColorDesc')).addDropdown((d) => {
      for (const c of THEME_COLORS) d.addOption(c, t('tc_' + c));
      d.setValue(th.color).onChange((v) => { th.color = v; thSave(); });
    });
    new Setting(el).setName(t('sThemeTextFont')).addDropdown((d) => d.addOption('inter', t('tf_inter')).addOption('system', t('tf_system'))
      .setValue(th.textFont).onChange((v) => { th.textFont = v; thSave(); }));
    new Setting(el).setName(t('sThemeHeadFont')).addDropdown((d) => d.addOption('grotesk', t('hf_grotesk')).addOption('text', t('hf_text'))
      .setValue(th.headFont).onChange((v) => { th.headFont = v; thSave(); }));
    const tog = (name: string, key: 'stars' | 'starsMotion' | 'nebula' | 'headingGlow' | 'gradient' | 'checkboxes', desc?: string) => {
      const st = new Setting(el).setName(t(name)).addToggle((tg) => tg.setValue(th[key]).onChange((v) => { th[key] = v; thSave(); }));
      if (desc) st.setDesc(t(desc));
    };
    tog('sThemeStars', 'stars', 'sThemeStarsDesc');
    tog('sThemeMotion', 'starsMotion');
    tog('sThemeNebula', 'nebula');
    tog('sThemeGlow', 'headingGlow');
    tog('sThemeGradient', 'gradient');
    tog('sThemeChecks', 'checkboxes', 'sThemeChecksDesc');
    new Setting(el).setName(t('sBehavior')).setHeading();
    new Setting(el).setName(t('sFocusCam')).setDesc(t('sFocusCamDesc')).addToggle((tg) => tg.setValue(s.focusCamera).onChange((v) => { s.focusCamera = v; void p.saveSettings(); }));
    new Setting(el).setName(t('sClaudeLive')).setDesc(t('sClaudeLiveDesc')).addToggle((tg) => tg.setValue(s.claudeLive).onChange((v) => { s.claudeLive = v; void p.saveSettings(); }));
    new Setting(el).setName(t('sHook')).setDesc(t('sHookDesc')).addButton((b) => b.setButtonText(t('sHookBtn')).onClick(() => new HookModal(this.app).open()));
    new Setting(el).setName(t('sRecSave')).addDropdown((d) => d
      .addOption('ask', t('sRecAsk')).addOption('auto', t('sRecAuto')).setValue(s.recSave)
      .onChange((v) => { s.recSave = v; void p.saveSettings(); }));
    new Setting(el).setName(t('sClick')).setDesc(t('sClickDesc')).addToggle((tg) => tg.setValue(s.clickOpens).onChange((v) => { s.clickOpens = v; void p.saveSettings(); }));
    new Setting(el).setName(t('sHalf')).setDesc(t('sHalfDesc')).addSlider((sl) => sl.setLimits(1, 720, 1).setValue(s.halfLife).setDynamicTooltip()
      .onChange((v) => { s.halfLife = v; save('heat'); }));
    new Setting(el).setName(t('sDepth')).addSlider((sl) => sl.setLimits(1, 3, 1).setValue(s.depth).setDynamicTooltip()
      .onChange((v) => { s.depth = v; void p.saveSettings(); }));
  }
}

/* explains the activity log and installs the hook script for Claude Code (or any tool with hooks) */
class HookModal extends Modal {
  onOpen(): void {
    const { contentEl } = this;
    const base = vaultBase(this.app);
    const script = (base ? base + '/' : '') + '.cortex/cortex-activity-hook.mjs';
    this.titleEl.setText(t('hookTitle'));
    contentEl.createEl('p', { text: t('hookIntro') });
    contentEl.createEl('pre', { cls: 'cg-code', text: '{"op":"read","path":"30 Wissen/Blender.md"}' });
    contentEl.createEl('h4', { text: t('hookStep1') });
    // the script is not bundled with the plugin (the plugin itself never touches files outside the vault API)
    new Setting(contentEl).setName('cortex-activity-hook.mjs').setDesc(t('hookStep1Desc')).addButton((b) => b.setButtonText(t('hookSave')).setCta().onClick(() => {
      window.open(HOOK_URL);
    }));
    contentEl.createEl('h4', { text: t('hookStep2') });
    contentEl.createEl('p', { text: t('hookStep2Desc') });
    const snippet = JSON.stringify({ hooks: { PostToolUse: [{ matcher: 'Read|Write|Edit|MultiEdit', hooks: [{ type: 'command', command: 'node "' + script + '"' }] }] } }, null, 2);
    contentEl.createEl('pre', { cls: 'cg-code', text: snippet });
    new Setting(contentEl).addButton((b) => b.setButtonText(t('hookCopy')).onClick(async () => { await navigator.clipboard.writeText(snippet); new Notice(t('hookCopied')); }));
    contentEl.createEl('p', { cls: 'setting-item-description', text: t('hookOther') });
  }
  onClose(): void { this.contentEl.empty(); }
}
