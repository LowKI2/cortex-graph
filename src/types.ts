/* Cortex Graph – shared data types */
import type { TFile } from 'obsidian';

export type Frontmatter = Record<string, unknown>;

/* one markdown note with its links (indices into the notes array) */
export interface Note {
  i: number;
  file: TFile;
  path: string;
  name: string;
  folder: string;
  tags: string[];
  fm: Frontmatter;
  mtime: number;
  ctime: number;
  out: Set<number>;
  back: Set<number>;
  unresolved: string[];
  color?: string;
}

/* one node of the visible graph */
export interface GNode {
  key: string;
  note: Note | null;
  ghost: boolean;
  hidden?: boolean;
  anchor?: boolean;
  label: string;
  deg: number;
  kind?: string;
  x?: number; y?: number; z?: number;
  w?: number;
  rank?: number | null;
  shape?: number;
  stale?: number;
}

export type Edge = [number, number];

export interface GraphStats { orphan: number; deadEnd: number; unresolved: number }

export interface Graph {
  nodes: GNode[];
  edges: Edge[];
  adj: number[][];
  idx: Map<string, number>;
  stats: GraphStats | Record<string, never>;
}

export interface CfgTerm { t: 'file' | 'path' | 'tag' | 'prop' | 'text'; v: string; k?: string }
export interface GraphCfg { excl: string[]; incl: string[]; groups: { terms: CfgTerm[]; color: string }[]; has: boolean }

/* slider values of the settings panel */
export interface StyleSettings {
  shapeSize: number; shapeGroup: number; hubPull: number;
  center: number; repel: number; link: number; dist: number; range: number;
  nodeSize: number; degSize: number; glow: number; line: number;
  font: number; fontGrow: number; boldFrom: number; labelFrom: number; maxLabels: number;
  dimOthers: number; nodeBright: number; glowBright: number;
  shStern: number; shRaute: number; shQuadrat: number; shRing: number;
}

export interface MouseSettings { left: string; right: string; middle: string; shift: string; invert: boolean; rotSpeed: number; rotPause: number }

export interface CameraState { t: number[]; yaw: number; pitch: number; dist: number }

/* a saved view (bookmark) */
export interface ViewSnapshot {
  cam: CameraState; mode: string; focusPath: string | null; depth: number; problems: boolean;
  activity: boolean; labels: boolean; pinned: string | null;
  tl: { mode: string; tag: string; from: number; to: number; pos: number } | null;
}
export interface SavedView { name: string; state: ViewSnapshot }

export interface CGSettings {
  layout: string; shape: string; background: string; colorBy: string;
  filters: boolean; orphans: boolean; labels: boolean; rotate: boolean; clickOpens: boolean;
  activity: boolean; halfLife: number; depth: number; navMini: boolean; explorerColors: string;
  folderColors: Record<string, string>; folderWeights: Record<string, number>; folderShapes: Record<string, string>;
  noteShapes: Record<string, string>; noteWeights: Record<string, number>; hiddenFolders: string[];
  folderLinks: string; rankBy: string; recSave: string; focusCamera: boolean; staleDays: number;
  shapeDefault: string; hubStars: boolean; claudeLive: boolean; galaxies: boolean;
  views: SavedView[]; style: StyleSettings; styleRev?: number;
  keys: Record<string, string[]>; mouse: MouseSettings; panelTab?: number;
  labelFont?: string; labelStyle?: string;
  themeOpts: ThemeOptions;
}

/* options for the Cortex theme, applied as classes on <body> */
export interface ThemeOptions {
  color: string; textFont: string; headFont: string;
  stars: boolean; starsMotion: boolean; nebula: boolean; headingGlow: boolean; gradient: boolean; checkboxes: boolean;
}
