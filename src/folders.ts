/* Cortex Graph – folder colors: colors the file explorer like the graph and lets you pick a color per folder. */
import { App, ColorComponent, Debouncer, Menu, Modal, Setting, TAbstractFile, TFolder, TFile, debounce } from 'obsidian';
import { PALETTE, DEFAULT_COLOR, assignColors } from './model';
import { t } from './i18n';
import type CortexGraphPlugin from './main';
import type { Note } from './types';

const SWATCHES = [...PALETTE, '#e57373', '#90a4ae', '#ffffff'];

/* majority color per top-level folder (ignores the neutral default color) */
export function autoFolderColors(notes: Note[]): Record<string, string> {
  const count = new Map<string, Map<string, number>>();
  for (const n of notes) {
    if (!n.folder || !n.color || n.color === DEFAULT_COLOR) continue;
    let m = count.get(n.folder); if (!m) count.set(n.folder, (m = new Map<string, number>()));
    m.set(n.color, (m.get(n.color) || 0) + 1);
  }
  const out: Record<string, string> = {};
  for (const [f, m] of count) out[f] = [...m.entries()].sort((a, b) => b[1] - a[1])[0][0];
  return out;
}

export class FolderColors {
  plugin: CortexGraphPlugin;
  app: App;
  auto: Record<string, string>;
  observers: Map<HTMLElement, MutationObserver>;
  requestApply: Debouncer<[], void>;
  requestRefresh: Debouncer<[], void>;

  constructor(plugin: CortexGraphPlugin) {
    this.plugin = plugin; this.app = plugin.app;
    this.auto = {};
    this.observers = new Map<HTMLElement, MutationObserver>();
    this.requestApply = debounce(() => this.apply(), 120, true);
    this.requestRefresh = debounce(() => { void this.refresh(); }, 1200, true);
  }

  get custom(): Record<string, string> { return this.plugin.settings.folderColors || (this.plugin.settings.folderColors = {}); }

  async refresh(): Promise<void> {
    const { notes } = this.plugin.collect();
    const cfg = await this.plugin.readGraphCfg();
    assignColors(notes, cfg, this.plugin.settings.colorBy);
    this.auto = autoFolderColors(notes);
    this.apply();
  }

  colorOf(path: string): string | null {
    if (this.custom[path]) return this.custom[path];
    return !path.includes('/') ? this.auto[path] || null : null;
  }

  explorers(): HTMLElement[] { return this.app.workspace.getLeavesOfType('file-explorer').map((l) => l.view && l.view.containerEl).filter((el): el is HTMLElement => !!el); }

  watch(): void {
    for (const el of this.explorers()) {
      if (this.observers.has(el)) continue;
      const mo = new MutationObserver(() => this.requestApply());
      mo.observe(el, { childList: true, subtree: true });
      this.observers.set(el, mo);
    }
  }

  apply(): void {
    const mode = this.plugin.settings.explorerColors;
    for (const root of this.explorers()) {
      root.toggleClass('cg-fc-rows', mode === 'rows');
      root.querySelectorAll<HTMLElement>('.nav-folder-title[data-path]').forEach((title) => {
        const item = title.parentElement; if (!item) return;
        const fp = title.getAttribute('data-path') || '';
        item.toggleClass('cg-fc-hidden', (this.plugin.settings.hiddenFolders || []).includes(fp));
        const c = mode === 'off' ? null : this.colorOf(fp);
        if (c) { item.addClass('cg-fc'); item.setCssProps({ '--cg-fc': c }); }
        else if (item.hasClass('cg-fc')) { item.removeClass('cg-fc'); item.setCssProps({ '--cg-fc': '' }); }
      });
    }
  }

  clear(): void {
    for (const mo of this.observers.values()) mo.disconnect();
    this.observers.clear();
    for (const root of this.explorers()) {
      root.removeClass('cg-fc-rows');
      root.querySelectorAll<HTMLElement>('.cg-fc').forEach((el) => { el.removeClass('cg-fc'); el.setCssProps({ '--cg-fc': '' }); });
      root.querySelectorAll<HTMLElement>('.cg-fc-hidden').forEach((el) => el.removeClass('cg-fc-hidden'));
    }
  }

  get weights(): Record<string, number> { return this.plugin.settings.folderWeights || (this.plugin.settings.folderWeights = {}); }

  async setStyle(folder: string, color: string | null, weight: number): Promise<void> {
    if (color) this.custom[folder] = color; else delete this.custom[folder];
    if (weight && weight !== 1) this.weights[folder] = weight; else delete this.weights[folder];
    await this.plugin.saveSettings();
    this.apply();
    this.plugin.refreshViews('data');
  }

  async setColor(folder: string, color: string | null): Promise<void> {
    if (color) this.custom[folder] = color; else delete this.custom[folder];
    await this.plugin.saveSettings();
    this.apply();
    this.plugin.refreshViews('data');
  }

  addMenu(menu: Menu, file: TAbstractFile): void {
    if (file instanceof TFile && file.extension === 'md') {
      menu.addItem((i) => i.setTitle(t('noteStyle')).setIcon('shapes').onClick(() => new NoteStyleModal(this.plugin, file.path).open()));
      return;
    }
    if (!(file instanceof TFolder) || file.isRoot()) return;
    menu.addItem((i) => i.setTitle(t('folderColor')).setIcon('palette').onClick(() => new FolderColorModal(this, file.path).open()));
    const hid = this.plugin.settings.hiddenFolders || (this.plugin.settings.hiddenFolders = []);
    const isHid = hid.includes(file.path);
    menu.addItem((i) => i.setTitle(t(isHid ? 'folderShow' : 'folderHide')).setIcon(isHid ? 'eye' : 'eye-off').onClick(async () => {
      const list = this.plugin.settings.hiddenFolders;
      const at = list.indexOf(file.path);
      if (at >= 0) list.splice(at, 1); else list.push(file.path);
      await this.plugin.saveSettings();
      this.apply();
      this.plugin.refreshViews('data');
    }));
  }
}

class FolderColorModal extends Modal {
  fc: FolderColors; path: string;
  constructor(fc: FolderColors, path: string) { super(fc.app); this.fc = fc; this.path = path; }
  onOpen() {
    const { contentEl } = this;
    this.titleEl.setText(t('folderColorTitle', this.path));
    let pick = this.fc.custom[this.path] || this.fc.colorOf(this.path) || PALETTE[0];
    let custom = !!this.fc.custom[this.path];
    let weight = this.fc.weights[this.path] || 1;
    let shape = (this.fc.plugin.settings.folderShapes || {})[this.path] || '';
    contentEl.createDiv({ cls: 'setting-item-name', text: t('folderColorCustom') });
    const sw = contentEl.createDiv({ cls: 'cg-swatches' });
    const mark = () => sw.querySelectorAll<HTMLElement>('.cg-swatch').forEach((b) => b.toggleClass('is-selected', b.getAttribute('data-c') === pick));
    for (const c of SWATCHES) {
      const b = sw.createEl('button', { cls: 'cg-swatch', attr: { 'data-c': c, 'aria-label': c } });
      b.setCssProps({ '--cg-sw': c });
      b.onclick = () => { pick = c; custom = true; if (picker !== undefined) picker.setValue(c); mark(); };
    }
    let picker: ColorComponent | undefined;
    new Setting(contentEl).setName(t('folderColorAny')).addColorPicker((cp) => { picker = cp; cp.setValue(pick).onChange((v) => { pick = v; custom = true; mark(); }); });
    mark();
    new Setting(contentEl).setName(t('folderWeight')).setDesc(t('folderWeightDesc')).addDropdown((d) => d
      .addOption('1', t('weightNormal')).addOption('1.6', t('weightImportant')).addOption('2.4', t('weightPrimary'))
      .setValue(String(weight)).onChange((v) => { weight = Number(v); }));
    new Setting(contentEl).setName(t('folderShape')).addDropdown((d) => {
      d.addOption('', t('shape_auto'));
      for (const k of ['kreis', 'ring', 'stern', 'raute', 'quadrat']) d.addOption(k, t('shape_' + k));
      d.setValue(shape).onChange((v) => { shape = v; });
    });
    const saveShape = (v: string) => { const m = this.fc.plugin.settings.folderShapes || (this.fc.plugin.settings.folderShapes = {}); if (v) m[this.path] = v; else delete m[this.path]; };
    new Setting(contentEl)
      .addButton((b) => b.setButtonText(t('reset')).onClick(async () => { saveShape(''); await this.fc.setStyle(this.path, null, 1); this.close(); }))
      .addButton((b) => b.setButtonText(t('apply')).setCta().onClick(async () => { saveShape(shape); await this.fc.setStyle(this.path, custom ? pick : null, weight); this.close(); }));
  }
  onClose() { this.contentEl.empty(); }
}

class NoteStyleModal extends Modal {
  plugin: CortexGraphPlugin; path: string;
  constructor(plugin: CortexGraphPlugin, path: string) { super(plugin.app); this.plugin = plugin; this.path = path; }
  onOpen() {
    const s = this.plugin.settings;
    const shapes = s.noteShapes || (s.noteShapes = {}), weights = s.noteWeights || (s.noteWeights = {});
    let shape = shapes[this.path] || '', weight = weights[this.path] || 1;
    this.titleEl.setText(t('folderColorTitle', this.path.replace(/\.md$/, '')));
    new Setting(this.contentEl).setName(t('folderShape')).setDesc(t('noteShapeDesc')).addDropdown((d) => {
      d.addOption('', t('shape_auto'));
      for (const k of ['kreis', 'ring', 'stern', 'raute', 'quadrat']) d.addOption(k, t('shape_' + k));
      d.setValue(shape).onChange((v) => { shape = v; });
    });
    new Setting(this.contentEl).setName(t('folderWeight')).setDesc(t('noteWeightDesc')).addDropdown((d) => d
      .addOption('1', t('weightNormal')).addOption('1.6', t('weightImportant')).addOption('2.4', t('weightPrimary'))
      .setValue(String(weight)).onChange((v) => { weight = Number(v); }));
    const save = async (sh: string, w: number) => {
      if (sh) shapes[this.path] = sh; else delete shapes[this.path];
      if (w && w !== 1) weights[this.path] = w; else delete weights[this.path];
      await this.plugin.saveSettings();
      this.plugin.refreshViews('data');
      this.close();
    };
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText(t('reset')).onClick(() => save('', 1)))
      .addButton((b) => b.setButtonText(t('apply')).setCta().onClick(() => save(shape, weight)));
  }
  onClose() { this.contentEl.empty(); }
}
