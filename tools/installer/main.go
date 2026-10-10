// Cortex Graph – installer for Obsidian (Windows/macOS/Linux).
// Finds your Obsidian vaults, copies the plugin into .obsidian/plugins/cortex-graph and enables it.
// Uses the newest GitHub release if reachable, otherwise the version bundled in this file.
package main

import (
	"bufio"
	"embed"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"
)

//go:embed files/*
var bundled embed.FS

const (
	pluginID = "cortex-graph"
	repo     = "LowKI2/cortex-graph"
)

var files = []string{"main.js", "manifest.json", "styles.css"}
var in = bufio.NewReader(os.Stdin)

func main() {
	fmt.Println("==============================================")
	fmt.Println("  Cortex Graph – Installation für Obsidian")
	fmt.Println("==============================================")
	fmt.Println()
	defer pause()

	vaults := findVaults()
	targets := chooseVaults(vaults)
	if len(targets) == 0 {
		fmt.Println("Kein Vault ausgewählt – nichts installiert.")
		return
	}

	data, version, source := loadFiles()
	fmt.Printf("\nVersion %s (%s)\n\n", version, source)

	ok := 0
	for _, v := range targets {
		if err := install(v, data); err != nil {
			fmt.Printf("  ✗ %s\n    Fehler: %v\n", v, err)
			continue
		}
		fmt.Printf("  ✓ %s\n", v)
		ok++
	}
	fmt.Println()
	if ok == 0 {
		return
	}
	fmt.Println("Fertig! So geht es weiter:")
	fmt.Println("  1. Obsidian komplett schließen und neu öffnen.")
	fmt.Println("  2. Einstellungen → Community-Plugins: falls „Eingeschränkter Modus“ an ist, ausschalten.")
	fmt.Println("  3. Cortex Graph ist dann aktiv – öffnen über das Symbol in der linken Leiste")
	fmt.Println("     oder Strg+P → „Cortex Graph“.")
}

func pause() {
	fmt.Println()
	fmt.Print("Enter drücken zum Beenden …")
	in.ReadString('\n')
}

// ---------------------------------------------------------------- vaults
func obsidianConfig() string {
	home, _ := os.UserHomeDir()
	switch runtime.GOOS {
	case "windows":
		return filepath.Join(os.Getenv("APPDATA"), "obsidian", "obsidian.json")
	case "darwin":
		return filepath.Join(home, "Library", "Application Support", "obsidian", "obsidian.json")
	default:
		return filepath.Join(home, ".config", "obsidian", "obsidian.json")
	}
}

type vaultEntry struct {
	Path string `json:"path"`
	Ts   int64  `json:"ts"`
}

func findVaults() []string {
	raw, err := os.ReadFile(obsidianConfig())
	if err != nil {
		return nil
	}
	var cfg struct {
		Vaults map[string]vaultEntry `json:"vaults"`
	}
	if json.Unmarshal(raw, &cfg) != nil {
		return nil
	}
	list := []vaultEntry{}
	for _, v := range cfg.Vaults {
		if st, err := os.Stat(filepath.Join(v.Path, ".obsidian")); err == nil && st.IsDir() {
			list = append(list, v)
		}
	}
	sort.Slice(list, func(i, j int) bool { return list[i].Ts > list[j].Ts }) // most recently used first
	out := []string{}
	for _, v := range list {
		out = append(out, v.Path)
	}
	return out
}

func ask(q string) string {
	fmt.Print(q)
	s, _ := in.ReadString('\n')
	return strings.Trim(strings.TrimSpace(strings.TrimPrefix(s, "\ufeff")), "\"")
}

func chooseVaults(vaults []string) []string {
	if len(vaults) == 0 {
		fmt.Println("Keine Obsidian-Vaults gefunden.")
		p := ask("Pfad zu deinem Vault-Ordner eingeben (oder leer lassen zum Abbrechen): ")
		if p == "" {
			return nil
		}
		if _, err := os.Stat(p); err != nil {
			fmt.Println("Ordner nicht gefunden.")
			return nil
		}
		return []string{p}
	}
	fmt.Println("Gefundene Vaults:")
	for i, v := range vaults {
		fmt.Printf("  [%d] %s\n", i+1, v)
	}
	fmt.Println()
	def := "1"
	if len(vaults) == 1 {
		def = "1"
	}
	a := ask(fmt.Sprintf("In welchen Vault installieren? Nummer, mehrere mit Komma, „a“ für alle [%s]: ", def))
	if a == "" {
		a = def
	}
	if strings.EqualFold(a, "a") {
		return vaults
	}
	out := []string{}
	for _, part := range strings.Split(a, ",") {
		n, err := strconv.Atoi(strings.TrimSpace(part))
		if err == nil && n >= 1 && n <= len(vaults) {
			out = append(out, vaults[n-1])
		}
	}
	return out
}

// ---------------------------------------------------------------- files
func loadFiles() (map[string][]byte, string, string) {
	if data, ver, err := download(); err == nil {
		return data, ver, "neueste Version von GitHub"
	}
	data := map[string][]byte{}
	for _, f := range files {
		b, _ := bundled.ReadFile("files/" + f)
		data[f] = b
	}
	return data, versionOf(data["manifest.json"]), "mitgeliefert, GitHub nicht erreichbar"
}

func versionOf(manifest []byte) string {
	var m struct {
		Version string `json:"version"`
	}
	json.Unmarshal(manifest, &m)
	if m.Version == "" {
		return "?"
	}
	return m.Version
}

func download() (map[string][]byte, string, error) {
	client := &http.Client{Timeout: 20 * time.Second}
	req, _ := http.NewRequest("GET", "https://api.github.com/repos/"+repo+"/releases/latest", nil)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "cortex-graph-installer")
	res, err := client.Do(req)
	if err != nil {
		return nil, "", err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return nil, "", fmt.Errorf("status %d", res.StatusCode)
	}
	var rel struct {
		Assets []struct {
			Name string `json:"name"`
			URL  string `json:"browser_download_url"`
		} `json:"assets"`
	}
	if err := json.NewDecoder(res.Body).Decode(&rel); err != nil {
		return nil, "", err
	}
	data := map[string][]byte{}
	for _, a := range rel.Assets {
		for _, f := range files {
			if a.Name != f {
				continue
			}
			r2, err := client.Get(a.URL)
			if err != nil {
				return nil, "", err
			}
			b, err := io.ReadAll(r2.Body)
			r2.Body.Close()
			if err != nil || r2.StatusCode != 200 {
				return nil, "", fmt.Errorf("download %s", f)
			}
			data[f] = b
		}
	}
	if data["main.js"] == nil || data["manifest.json"] == nil {
		return nil, "", fmt.Errorf("release incomplete")
	}
	return data, versionOf(data["manifest.json"]), nil
}

// ---------------------------------------------------------------- install
func install(vault string, data map[string][]byte) error {
	obs := filepath.Join(vault, ".obsidian")
	dir := filepath.Join(obs, "plugins", pluginID)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	for name, b := range data {
		if b == nil {
			continue
		}
		if err := os.WriteFile(filepath.Join(dir, name), b, 0o644); err != nil {
			return err
		}
	}
	// enable: add the id to community-plugins.json (keeps the user's other plugins)
	cp := filepath.Join(obs, "community-plugins.json")
	list := []string{}
	if raw, err := os.ReadFile(cp); err == nil {
		json.Unmarshal(raw, &list)
	}
	for _, id := range list {
		if id == pluginID {
			return nil
		}
	}
	list = append(list, pluginID)
	out, _ := json.MarshalIndent(list, "", "  ")
	return os.WriteFile(cp, out, 0o644)
}
