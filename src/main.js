import { Plugin, PluginSettingTab, Setting, FuzzySuggestModal, debounce } from 'obsidian';
import { CortexGraphView, VIEW_TYPE } from './view';
import { t } from './i18n';

const STYLE_DEFAULTS = { center: 0.5, repel: 10, link: 1, dist: 32, nodeSize: 1, degSize: 1, glow: 1, line: 1,
  font: 12, fontGrow: 0.4, boldFrom: 10, labelFrom: 6, maxLabels: 30 };
const DEFAULTS = {
  layout: '3d', background: 'space', colorBy: 'obsidian', filters: true, orphans: false, labels: true, rotate: true,
  clickOpens: false, activity: true, halfLife: 24, depth: 1, navMini: false, style: Object.assign({}, STYLE_DEFAULTS),
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
  }

  onunload() { try { delete window.__THREE__; } catch { /* ignore */ } }

  async loadSettings() {
    const d = (await this.loadData()) || {};
    this.settings = Object.assign({}, DEFAULTS, d);
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
      .onChange((v) => { s.colorBy = v; save('data'); }));
    new Setting(el).setName(t('sFilters')).setDesc(t('sFiltersDesc')).addToggle((tg) => tg.setValue(s.filters).onChange((v) => { s.filters = v; save('data'); }));
    new Setting(el).setName(t('sOrphans')).addToggle((tg) => tg.setValue(s.orphans).onChange((v) => { s.orphans = v; save('data'); }));
    new Setting(el).setName(t('sLabels')).addToggle((tg) => tg.setValue(s.labels).onChange((v) => { s.labels = v; save('style'); p.views().forEach((w) => w.updateToolbar()); }));
    new Setting(el).setName(t('sRotate')).addToggle((tg) => tg.setValue(s.rotate).onChange((v) => { s.rotate = v; save('style'); }));
    new Setting(el).setName(t('sBehavior')).setHeading();
    new Setting(el).setName(t('sClick')).setDesc(t('sClickDesc')).addToggle((tg) => tg.setValue(s.clickOpens).onChange((v) => { s.clickOpens = v; p.saveSettings(); }));
    new Setting(el).setName(t('sHalf')).setDesc(t('sHalfDesc')).addSlider((sl) => sl.setLimits(1, 720, 1).setValue(s.halfLife).setDynamicTooltip()
      .onChange((v) => { s.halfLife = v; save('heat'); }));
    new Setting(el).setName(t('sDepth')).addSlider((sl) => sl.setLimits(1, 3, 1).setValue(s.depth).setDynamicTooltip()
      .onChange((v) => { s.depth = v; p.saveSettings(); }));
  }
}
