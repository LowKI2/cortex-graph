#!/usr/bin/env node
/* Cortex Graph – activity hook for AI tools (MIT).
   Reads a hook event as JSON on stdin (Claude Code PostToolUse format: tool_name, tool_input.file_path, cwd)
   and appends {"op":"read"|"write","path":"<vault-relative path>"} to <vault>/.cortex/activity.jsonl.
   The vault is found automatically (nearest parent folder containing .obsidian) or given as first argument.
   Anything that is not a note inside a vault is ignored; errors never block the tool. */
import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve, isAbsolute, sep } from 'node:path';

let raw = '';
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', () => {
  try {
    const ev = JSON.parse(raw.replace(/^\uFEFF/, '') || '{}');
    const ti = ev.tool_input || {};
    let fp = ti.file_path || ti.notebook_path || ti.path;
    if (!fp || typeof fp !== 'string') return;
    fp = resolve(ev.cwd || process.cwd(), fp);
    if (!/\.(md|canvas|base)$/i.test(fp)) return;
    let vault = process.argv[2] || process.env.CORTEX_VAULT;
    if (vault) vault = resolve(vault);
    else {
      for (let d = dirname(fp); ; d = dirname(d)) {
        if (existsSync(join(d, '.obsidian'))) { vault = d; break; }
        if (dirname(d) === d) return;
      }
    }
    const rel = relative(vault, fp);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return;
    const op = /^(Read|NotebookRead)$/.test(ev.tool_name || '') ? 'read' : 'write';
    mkdirSync(join(vault, '.cortex'), { recursive: true });
    appendFileSync(join(vault, '.cortex', 'activity.jsonl'), JSON.stringify({ op, path: rel.split(sep).join('/'), src: ev.tool_name ? 'claude-code' : 'hook' }) + '\n');
  } catch { /* never block the tool */ }
});
