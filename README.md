# Cortex Graph

A 3D graph view for Obsidian with glowing nodes – made for exploring a large vault, not just looking at it.
Works on **desktop and mobile** (touch controls included).

![Cortex Graph](docs/screenshot-global.png)

## Features

- **3D or flat layout** with glowing nodes, deep-space or theme background, light and dark mode.
- **Live updates** – new notes and links appear immediately, the layout stays stable.
- **Native Obsidian integration**
  - click to select and highlight neighbours, double-click (or Ctrl/Cmd-click) to open
  - hover preview (Page preview core plugin, with Ctrl/Cmd by default)
  - right-click shows the normal file menu
- **Local graph** that follows the active note (depth 1–3), also in the sidebar.
- **Activity heat** – recently edited notes glow warmer and pulse, so you see at a glance where work is happening.
- **Shortest path** between two notes – pick "Path from here", then the target. Also available as a command.
- **Fly-to search** – type a name, the camera flies to the note.
- **Link health check** – notes without links, dead ends and unresolved links are colored, with counts.
- **Uses your graph view settings** – color groups and path filters of the core graph view are applied (optional).
- **Obsidian-like controls** – center/repel/link forces, link distance, node size, size by connections, glow,
  line thickness, font size, font growth and bold labels by connections, label thresholds.
- **Navigation buttons** for zoom, pan, rotate and fit; keyboard: arrows/WASD, +/−, Q/E, 0 or F.
- **Built for large vaults** – the force layout runs in a web worker with a Barnes-Hut octree.
- English and German interface.

| Path between two notes | Link health check | Mobile |
| --- | --- | --- |
| ![Path](docs/screenshot-path.png) | ![Link health](docs/screenshot-health.png) | ![Mobile](docs/screenshot-mobile.png) |

## Controls

| Action | Mouse | Touch |
| --- | --- | --- |
| Rotate | drag background | one finger |
| Pan | right/middle drag or Shift + drag | two fingers |
| Zoom | wheel | pinch |
| Move a node | drag the node | drag the node |
| Select / open | click / double-click | tap / double-tap |
| File menu | right-click | buttons in the info card |

## Commands

- **Open graph** – opens the global graph in a new tab.
- **Open local graph in sidebar** – follows the active note.
- **Find path between two notes**
- **Rearrange layout**

## Settings

Layout (3D/flat), background (space/theme), node colors (graph view groups, folders, single color),
graph view filters, notes without links, names, auto-rotation, single click opens note,
activity half-life and local graph depth. Forces and appearance are adjusted live in the panel inside the view.

## Privacy

The plugin works entirely offline. It reads your notes' link structure through Obsidian's metadata cache
and the core graph view settings (`graph.json`). It does not use the network.
Layout positions are stored in the plugin folder (`positions.json`).

## Installation

From Obsidian: *Settings → Community plugins → Browse → "Cortex Graph"*.

Manual: copy `main.js`, `manifest.json` and `styles.css` from the latest release into
`<vault>/.obsidian/plugins/cortex-graph/` and enable the plugin.

## Development

```bash
npm install
npm run dev     # watch build
npm run build   # production build
npm run lint
```

Releases are built by GitHub Actions when a tag matching the `manifest.json` version is pushed.

## License

MIT © BZi Studio. Bundles [three.js](https://threejs.org) (MIT).
