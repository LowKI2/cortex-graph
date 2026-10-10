# Cortex Graph installer

A small stand-alone program that installs Cortex Graph without the community directory or BRAT:
it lists your Obsidian vaults, copies the plugin into `.obsidian/plugins/cortex-graph` and enables it.
It downloads the newest GitHub release; if GitHub is unreachable it uses the copy bundled at build time.

Build (Go 1.22+), with the current `main.js`, `manifest.json`, `styles.css` copied into `files/`:

```
mkdir files && cp ../../main.js ../../manifest.json ../../styles.css files/
GOOS=windows GOARCH=amd64 go build -trimpath -ldflags "-s -w" -o Cortex-Graph-Installer.exe .
GOOS=darwin  GOARCH=arm64 go build -trimpath -ldflags "-s -w" -o cortex-graph-installer-mac .
```
