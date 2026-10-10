import { Plugin, PluginSettingTab, Setting, FuzzySuggestModal, TFolder, debounce, getAllTags } from 'obsidian';
import { parseGraphCfg } from './model';
import { FolderColors } from './folders';
import { CortexGraphView, VIEW_TYPE } from './view';
import { t } from './i18n';

const STYLE_DEFAULTS = { center: 2, repel: 10, link: 1, dist: 32, range: 250, nodeSize: 1, degSize: 1, glow: 1, line: 1,
  font: 4, fontGrow: 1.45, boldFrom: 15, labelFrom: 4, maxLabels: 150, dimOthers: 0.04 };
const DEFAULTS = {
  layout: '3d', background: 'space', colorBy: 'obsidian', filters: true, orphans: false, labels: true, rotate: true,
  clickOpens: false, activity: true, halfLife: 24, depth: 1, navMini: false, explorerColors: 'rows', folderColors: {}, folderWeights: {}, hiddenFolders: [], folderLinks: 'hidden', rankBy: 'auto', recSave: 'ask', galaxies: true, views: [], style: Object.assign({}, STYLE_DEFAULTS),
};

export default class CortexGraphPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.saveSettingsDebounced = debounce(() => this.saveSettings(), 400, true);
    this.registerView(VIEW_TYPE, (leaf) => new CortexGraphView(leaf, this));
    this.registerHoverLinkSource(VIEW_TYPE, { display: 'Cortex Graph', defaultMod: true });
    this.addRibbonIcon('orbit', t('cmdOpen'), () => this.openGraph('global'));
    this.addCommand({ id: 'open', name: t('cmdOpen'), callback: () => this.openGraph('global') });
    this.addCommand({ id: 'open-local', name: t('cmdOpenLocal'), callback: () => this.openGraph('local') });
    this.addCommand({
      id: 'relayout', name: t('cmdRelayout'),
      checkCallback: (checking) => { const v = this.activeGraph(); if (!v) return false; if (!checking) v.relayout(); return true; },
    });
    this.addCommand({ id: 'find-path', name: t('cmdPath'), callback: () => this.findPath() });
    this.addSettingTab(new CortexGraphSettingTab(this.app, this));

    // folder colors in the file explorer
    this.fc = new FolderColors(this);
    this.app.workspace.onLayoutReady(() => { this.fc.watch(); this.fc.refresh(); });
    this.registerEvent(this.app.workspace.on('layout-change', () => { this.fc.watch(); this.fc.requestApply(); }));
    this.registerEvent(this.app.metadataCache.on('resolved', () => this.fc.requestRefresh()));
    this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => this.fc.addMenu(menu, file)));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      if (!(file instanceof TFolder)) return;
      let changed = false;
      for (const fc of [this.settings.folderColors, this.settings.folderWeights]) {
        for (const k of Object.keys(fc)) if (k === oldPath || k.startsWith(oldPath + '/')) { fc[file.path + k.slice(oldPath.length)] = fc[k]; delete fc[k]; changed = true; }
      }
      const hf = this.settings.hiddenFolders;
      hf.forEach((k, i) => { if (k === oldPath || k.startsWith(oldPath + '/')) { hf[i] = file.path + k.slice(oldPath.length); changed = true; } });
      if (changed) this.saveSettings();
      this.fc.requestRefresh();
    }));
  }

  // ------------------------------------------------ shared data access
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

  onunload() {
    if (this.fc) this.fc.clear();
    try { delete window.__THREE__; } catch { /* ignore */ }
  }

  async loadSettings() {
    const d = (await this.loadData()) || {};
    this.settings = Object.assign({}, DEFAULTS, d);
    this.settings.folderColors = Object.assign({}, d.folderColors || {});
    this.settings.folderWeights = Object.assign({}, d.folderWeights || {});
    this.settings.hiddenFolders = Array.isArray(d.hiddenFolders) ? d.hiddenFolders.slice() : [];
    this.settings.views = Array.isArray(d.views) ? d.views.slice() : [];
    this.settings.style = Object.assign({}, STYLE_DEFAULTS, d.style || {});
  }
  async saveSettings() { await this.saveData(this.settings); }
  resetStyle() { this.settings.style = Object.assign({}, STYLE_DEFAULTS); this.saveSettings(); }

  views() { return this.app.workspace.getLeavesOfType(VIEW_TYPE).map((l) => l.view).filter((v) => v instanceof CortexGraphView); }
  activeGraph() { const v = this.app.workspace.getActiveViewOfType(CortexGraphView); return v || this.views()[0] || null; }
  refreshViews(what) { for (const v of this.views()) v.onSettingsChanged(what); }

  async openGraph(mode) {
    const ws = this.app.workspace;
    const existing = this.views().find((v) => v.mode === mode);
    if (existing) { ws.revealLeaf(existing.leaf); return existing; }
    const leaf = mode === 'local' ? ws.getRightLeaf(false) : ws.getLeaf('tab');
    if (!leaf) return null;
    await leaf.setViewState({ type: VIEW_TYPE, active: true, state: { mode, depth: this.settings.depth } });
    ws.revealLeaf(leaf);
    return leaf.view;
  }

  findPath() {
    const files = this.app.vault.getMarkdownFiles();
    new NotePicker(this.app, files, t('pickFrom'), (a) => {
      new NotePicker(this.app, files, t('pickTo'), async (b) => {
        let v = this.views().find((x) => x.mode === 'global' && !x.focusPath);
        if (!v) v = await this.openGraph('global');
        if (!v) return;
        this.app.workspace.revealLeaf(v.leaf);
        const tryIt = (n) => { if (v.G && v.G.idx.size) v.showPathBetween(a.path, b.path); else if (n > 0) window.setTimeout(() => tryIt(n - 1), 300); };
        tryIt(20);
      }).open();
    }).open();
  }

  // ------------------------------------------------ saved layout positions (separate file, can be large)
  posFile(flat) { return this.manifest.dir + (flat ? '/positions-flat.json' : '/positions.json'); }
  async loadPositions(flat) {
    const key = flat ? 'flat' : '3d';
    if (this.posCache && this.posCache[key]) return this.posCache[key];
    let data = {};
    try { const p = this.posFile(flat); if (await this.app.vault.adapter.exists(p)) data = JSON.parse(await this.app.vault.adapter.read(p)) || {}; } catch { data = {}; }
    (this.posCache ||= {})[key] = data;
    return data;
  }
  async savePositions(flat, map) {
    const key = flat ? 'flat' : '3d';
    const data = map ? Object.assign(await this.loadPositions(flat), map) : {};
    (this.posCache ||= {})[key] = data;
    try { await this.app.vault.adapter.write(this.posFile(flat), JSON.stringify(data)); } catch { /* ignore */ }
  }
}

class NotePicker extends FuzzySuggestModal {
  constructor(app, files, placeholder, onPick) { super(app); this.files = files; this.onPick = onPick; this.setPlaceholder(placeholder); }
  getItems() { return this.files; }
  getItemText(f) { return f.path.replace(/\.md$/, ''); }
  onChooseItem(f) { this.onPick(f); }
}

class CortexGraphSettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const el = this.containerEl, s = this.plugin.settings, p = this.plugin;
    el.empty();
    const save = (what) => { p.saveSettings(); p.refreshViews(what); };
    new Setting(el).setName(t('sDisplay')).setHeading();
    new Setting(el).setName(t('sLayout')).setDesc(t('sLayoutDesc')).addDropdown((d) => d
      .addOption('3d', t('s3d')).addOption('flat', t('sFlat')).setValue(s.layout)
      .onChange((v) => { s.layout = v; save('layout'); }));
    new Setting(el).setName(t('sBackground')).setDesc(t('sBackgroundDesc')).addDropdown((d) => d
      .addOption('space', t('sSpace')).addOption('theme', t('sTheme')).setValue(s.background)
      .onChange((v) => { s.background = v; save('theme'); }));
    new Setting(el).setName(t('sColorBy')).setDesc(t('sColorByDesc')).addDropdown((d) => d
      .addOption('obsidian', t('sColorObsidian')).addOption('folder', t('sColorFolder')).addOption('none', t('sColorNone')).setValue(s.colorBy)
      .onChange((v) => { s.colorBy = v; save('data'); p.fc.refresh(); }));
    new Setting(el).setName(t('sExplorer')).setDesc(t('sExplorerDesc')).addDropdown((d) => d
      .addOption('rows', t('sExplorerRows')).addOption('folders', t('sExplorerFolders')).addOption('off', t('sExplorerOff')).setValue(s.explorerColors)
      .onChange((v) => { s.explorerColors = v; p.saveSettings(); p.fc.apply(); }));
    new Setting(el).setName(t('sFilters')).setDesc(t('sFiltersDesc')).addToggle((tg) => tg.setValue(s.filters).onChange((v) => { s.filters = v; save('data'); }));
    new Setting(el).setName(t('sRankBy')).setDesc(t('sRankByDesc')).addDropdown((d) => d
      .addOption('auto', t('sRankAuto')).addOption('links', t('sRankLinks')).setValue(s.rankBy)
      .onChange((v) => { s.rankBy = v; save('data'); }));
    new Setting(el).setName(t('sFolderLinks')).setDesc(t('sFolderLinksDesc')).addDropdown((d) => d
      .addOption('off', t('sFlOff')).addOption('hidden', t('sFlHidden')).addOption('lines', t('sFlLines')).setValue(s.folderLinks)
      .onChange((v) => { s.folderLinks = v; save('layout'); }));
    new Setting(el).setName(t('sGalaxies')).setDesc(t('sGalaxiesDesc')).addToggle((tg) => tg.setValue(s.galaxies !== false).onChange((v) => { s.galaxies = v; p.saveSettings(); }));
    new Setting(el).setName(t('sOrphans')).addToggle((tg) => tg.setValue(s.orphans).onChange((v) => { s.orphans = v; save('data'); }));
    new Setting(el).setName(t('sLabels')).addToggle((tg) => tg.setValue(s.labels).onChange((v) => { s.labels = v; save('style'); p.views().forEach((w) => w.updateToolbar()); }));
    new Setting(el).setName(t('sRotate')).addToggle((tg) => tg.setValue(s.rotate).onChange((v) => { s.rotate = v; save('style'); }));
    new Setting(el).setName(t('sBehavior')).setHeading();
    new Setting(el).setName(t('sRecSave')).addDropdown((d) => d
      .addOption('ask', t('sRecAsk')).addOption('auto', t('sRecAuto')).setValue(s.recSave)
      .onChange((v) => { s.recSave = v; p.saveSettings(); }));
    new Setting(el).setName(t('sClick')).setDesc(t('sClickDesc')).addToggle((tg) => tg.setValue(s.clickOpens).onChange((v) => { s.clickOpens = v; p.saveSettings(); }));
    new Setting(el).setName(t('sHalf')).setDesc(t('sHalfDesc')).addSlider((sl) => sl.setLimits(1, 720, 1).setValue(s.halfLife).setDynamicTooltip()
      .onChange((v) => { s.halfLife = v; save('heat'); }));
    new Setting(el).setName(t('sDepth')).addSlider((sl) => sl.setLimits(1, 3, 1).setValue(s.depth).setDynamicTooltip()
      .onChange((v) => { s.depth = v; p.saveSettings(); }));
  }
}
