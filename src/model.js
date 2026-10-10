/* Cortex Graph – data model: notes, links, groups, filters, graph building. Pure functions, no Obsidian imports. */

export const PALETTE = ['#a882ff', '#4fc3f7', '#ff7aa8', '#7ee081', '#ffb347', '#5ee7d0', '#f06292', '#ffd54f',
  '#9fa8ff', '#ff8a65', '#81d4fa', '#c5e1a5'];
export const DEFAULT_COLOR = '#9aa6c8';
export const PROBLEM_COLORS = { orphan: '#f5c542', deadEnd: '#ff8c42', unresolved: '#ff4d5e' };

export function asList(v) {
  if (v == null || v === '') return [];
  return Array.isArray(v) ? v.filter((s) => s != null && s !== '').map(String) : [String(v)];
}

/* graph.json of the core graph view -> filters + color groups */
export function parseGraphCfg(json) {
  const cfg = { excl: [], incl: [], groups: [], has: false };
  if (!json) return cfg;
  let g;
  try { g = typeof json === 'string' ? JSON.parse(json) : json; } catch { return cfg; }
  cfg.has = true;
  const re = /(-?)path:(?:"([^"]+)"|(\S+))/g;
  let m;
  while ((m = re.exec(g.search || ''))) (m[1] ? cfg.excl : cfg.incl).push((m[2] || m[3]).toLowerCase());
  for (const grp of g.colorGroups || []) {
    const terms = [];
    for (const part of String(grp.query || '').split(/\s+OR\s+/)) {
      const p = part.trim();
      let mm;
      if ((mm = p.match(/^file:(?:"([^"]+)"|(\S+))$/))) terms.push({ t: 'file', v: (mm[1] || mm[2]).toLowerCase() });
      else if ((mm = p.match(/^path:(?:"([^"]+)"|(\S+))$/))) terms.push({ t: 'path', v: (mm[1] || mm[2]).toLowerCase() });
      else if ((mm = p.match(/^tag:#?(\S+)$/))) terms.push({ t: 'tag', v: mm[1].toLowerCase() });
      else if ((mm = p.match(/^\[\s*"?([^":\]]+)"?\s*:\s*"?([^"\]]*)"?\s*\]$/))) terms.push({ t: 'prop', k: mm[1], v: mm[2].toLowerCase() });
      else if (p) terms.push({ t: 'text', v: p.toLowerCase() });
    }
    const rgb = (grp.color && grp.color.rgb) || 0;
    if (terms.length) cfg.groups.push({ terms, color: '#' + rgb.toString(16).padStart(6, '0') });
  }
  return cfg;
}

function matchTerm(n, t) {
  switch (t.t) {
    case 'file': return n.name.toLowerCase().includes(t.v);
    case 'path': return n.path.toLowerCase().includes(t.v);
    case 'tag': return n.tags.some((x) => x.toLowerCase() === t.v || x.toLowerCase().startsWith(t.v + '/'));
    case 'prop': return asList(n.fm && n.fm[t.k]).some((x) => x.toLowerCase() === t.v);
    case 'text': return n.path.toLowerCase().includes(t.v);
  }
  return false;
}

export function passesFilter(n, cfg) {
  const p = n.path.toLowerCase();
  if (cfg.excl.some((x) => p.includes(x))) return false;
  if (cfg.incl.length && !cfg.incl.some((x) => p.includes(x))) return false;
  return true;
}

/* colorBy: 'obsidian' (groups from graph.json, falls back to folder), 'folder', 'none' */
export function assignColors(notes, cfg, colorBy, folderColors) {
  const fcKeys = folderColors ? Object.keys(folderColors).sort((a, b) => b.length - a.length) : [];
  const useGroups = colorBy === 'obsidian' && cfg.groups.length > 0;
  const folders = [...new Set(notes.map((n) => n.folder))].sort();
  const fc = new Map(folders.map((f, i) => [f, PALETTE[i % PALETTE.length]]));
  for (const n of notes) {
    let c = null;
    if (useGroups) { for (const g of cfg.groups) if (g.terms.some((t) => matchTerm(n, t))) { c = g.color; break; } }
    else if (colorBy !== 'none') c = fc.get(n.folder);
    for (const f of fcKeys) if (n.path.startsWith(f + '/')) { c = folderColors[f]; break; }
    n.color = c || DEFAULT_COLOR;
  }
}

/* Builds the visible graph.
   notes: [{path, name, folder, tags, fm, mtime, ctime, out:Set<idx>, back:Set<idx>, unresolved:[linktext]}]
   o: {focus: idx|null, depth, orphans, filter(cfg|null), problems}
   -> {nodes:[{key, note|null, ghost, label, deg, kind}], edges:[[a,b]], adj, idx:Map(key->k), stats} */
export function buildGraph(notes, o) {
  let list;
  if (o.focus != null && notes[o.focus]) {
    const seen = new Map([[o.focus, 0]]); const q = [o.focus];
    while (q.length) {
      const i = q.shift(); const d = seen.get(i); if (d >= o.depth) continue;
      const n = notes[i];
      for (const j of n.out) if (!seen.has(j)) { seen.set(j, d + 1); q.push(j); }
      for (const j of n.back) if (!seen.has(j)) { seen.set(j, d + 1); q.push(j); }
    }
    list = [...seen.keys()].map((i) => notes[i]);
  } else list = o.filter ? notes.filter((n) => passesFilter(n, o.filter)) : notes.slice();

  const inSet = new Map(list.map((n, k) => [n.i, k]));
  const pairs = new Set(); const edges = [];
  for (const n of list) for (const j of n.out) if (inSet.has(j)) {
    const a = inSet.get(n.i), b = inSet.get(j); if (a === b) continue;
    const key = a < b ? a + ':' + b : b + ':' + a;
    if (!pairs.has(key)) { pairs.add(key); edges.push([a, b]); }
  }
  const deg = new Array(list.length).fill(0);
  for (const [a, b] of edges) { deg[a]++; deg[b]++; }

  // problem classification (on the full link structure, not only the visible part)
  const kindOf = (n) => (n.out.size === 0 && n.back.size === 0 ? 'orphan' : (n.out.size === 0 && n.unresolved.length === 0 ? 'deadEnd' : ''));

  let keep = list.map((n, k) => k);
  const showAll = o.focus != null || o.orphans || o.problems;
  if (!showAll) keep = keep.filter((k) => deg[k] > 0);
  const remap = new Map(keep.map((k, idx) => [k, idx]));
  const nodes = keep.map((k) => ({ key: list[k].path, note: list[k], ghost: false, label: list[k].name, deg: deg[k], kind: kindOf(list[k]) }));
  const outEdges = edges.filter(([a, b]) => remap.has(a) && remap.has(b)).map(([a, b]) => [remap.get(a), remap.get(b)]);

  const stats = { orphan: 0, deadEnd: 0, unresolved: 0 };
  for (const nd of nodes) if (nd.kind) stats[nd.kind]++;
  // filtered-out notes stay in the layout as invisible nodes, so hovering them in the explorer can show them in place
  if (o.keepHidden && o.focus == null && !o.problems) {
    const at = new Map(nodes.map((nd, k) => [nd.note.i, k]));
    for (const n of notes) if (!at.has(n.i)) { at.set(n.i, nodes.length); nodes.push({ key: n.path, note: n, ghost: false, hidden: true, label: n.name, deg: 0, kind: kindOf(n) }); }
    const pairs2 = new Set(outEdges.map(([a, b]) => (a < b ? a + ':' + b : b + ':' + a)));
    for (const nd of nodes) {
      if (!nd.hidden) continue;
      const a = at.get(nd.note.i);
      for (const j of [...nd.note.out, ...nd.note.back]) {
        const b = at.get(j); if (b == null || b === a) continue;
        const key = a < b ? a + ':' + b : b + ':' + a;
        if (pairs2.has(key)) continue;
        pairs2.add(key); outEdges.push([a, b]); nodes[a].deg++; nodes[b].deg++;
      }
    }
  }
  if (o.problems) {
    const ghosts = new Map();
    nodes.forEach((nd, k) => {
      for (const t of nd.note.unresolved) {
        const gk = 'ghost:' + t.toLowerCase();
        let g = ghosts.get(gk);
        if (g == null) {
          g = nodes.length; ghosts.set(gk, g);
          nodes.push({ key: gk, note: null, ghost: true, label: t, deg: 0, kind: 'unresolved' });
          stats.unresolved++;
        }
        outEdges.push([k, g]); nodes[k].deg++; nodes[g].deg++;
      }
    });
  }
  const adj = nodes.map(() => []);
  for (const [a, b] of outEdges) { adj[a].push(b); adj[b].push(a); }
  const idx = new Map(nodes.map((nd, k) => [nd.key, k]));
  return { nodes, edges: outEdges, adj, idx, stats };
}

/* shortest path on the visible (undirected) graph, BFS -> [k...] or null */
export function shortestPath(adj, a, b) {
  if (a === b) return [a];
  const prev = new Int32Array(adj.length).fill(-1); prev[a] = a;
  const q = [a];
  for (let h = 0; h < q.length; h++) {
    const i = q[h];
    for (const j of adj[i]) if (prev[j] < 0) {
      prev[j] = i;
      if (j === b) { const p = [b]; let c = b; while (c !== a) { c = prev[c]; p.push(c); } return p.reverse(); }
      q.push(j);
    }
  }
  return null;
}

/* structure signature to skip needless relayouts */
export function signature(g) {
  let h = 2166136261;
  const add = (s) => { for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } };
  for (const nd of g.nodes) add(nd.key + '|');
  for (const [a, b] of g.edges) add(a + ':' + b + ',');
  return g.nodes.length + '/' + g.edges.length + '/' + (h >>> 0).toString(36);
}

/* activity heat 0..1 from modification time */
export function heatOf(mtime, now, halfLifeHours) {
  if (!mtime) return 0;
  const age = Math.max(0, now - mtime) / 3600000;
  const h = Math.pow(0.5, age / Math.max(0.1, halfLifeHours));
  return h < 0.02 ? 0 : h;
}

/* value of the deepest configured folder containing path (folder map: {'a/b': value}) */
export function deepestFolderValue(map, path) {
  let best = null, len = -1;
  for (const f in map) if (path.startsWith(f + '/') && f.length > len) { best = map[f]; len = f.length; }
  return best;
}
