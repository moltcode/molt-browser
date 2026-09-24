package main

// Registers the native messaging host with every Chromium-family browser
// found on this machine. Plugins have no post-install step, so the CLI does
// this idempotently on each run: it rewrites the files only when they differ.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

const hostName = "com.moltcode.browser"

// Extension IDs allowed to connect. The first is fixed by the `key` in
// extension/manifest.json (unpacked installs); Chrome Web Store IDs are added
// here once assigned.
var extensionIDs = []string{
	"gajikdfpamklabiiaonmdeamjabehoig",
}

func stateDir() string {
	if dir := os.Getenv("MOLT_PLUGIN_STATE_DIR"); dir != "" {
		return dir
	}
	if dir, err := os.UserConfigDir(); err == nil {
		return filepath.Join(dir, "molt-browser")
	}
	return filepath.Join(os.TempDir(), "molt-browser")
}

func pluginDir() string {
	if dir := os.Getenv("MOLT_PLUGIN_DIR"); dir != "" {
		return dir
	}
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	exe, _ = filepath.EvalSymlinks(exe)
	// dist/<platform>/molt-browser
	return filepath.Dir(filepath.Dir(filepath.Dir(exe)))
}

func socketPath() string { return filepath.Join(stateDir(), "bridge.sock") }

func extensionDir() string { return filepath.Join(pluginDir(), "extension") }

// Chromium-family user data dirs; a browser counts as installed when its
// parent directory exists.
func browserHostDirs() []string {
	// Tests and custom --user-data-dir profiles point this at their own
	// NativeMessagingHosts directories.
	if dirs := os.Getenv("MOLT_BROWSER_HOST_DIRS"); dirs != "" {
		return filepath.SplitList(dirs)
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return nil
	}
	var roots []string
	switch runtime.GOOS {
	case "darwin":
		base := filepath.Join(home, "Library", "Application Support")
		roots = []string{
			filepath.Join(base, "Google", "Chrome"),
			filepath.Join(base, "Google", "Chrome Beta"),
			filepath.Join(base, "Google", "Chrome Dev"),
			filepath.Join(base, "Google", "Chrome Canary"),
			filepath.Join(base, "Chromium"),
			filepath.Join(base, "BraveSoftware", "Brave-Browser"),
			filepath.Join(base, "Microsoft Edge"),
			filepath.Join(base, "Arc", "User Data"),
		}
	case "linux":
		base := filepath.Join(home, ".config")
		roots = []string{
			filepath.Join(base, "google-chrome"),
			filepath.Join(base, "google-chrome-beta"),
			filepath.Join(base, "google-chrome-unstable"),
			filepath.Join(base, "chromium"),
			filepath.Join(base, "BraveSoftware", "Brave-Browser"),
			filepath.Join(base, "microsoft-edge"),
		}
	}
	var dirs []string
	for _, root := range roots {
		if fi, err := os.Stat(root); err == nil && fi.IsDir() {
			dirs = append(dirs, filepath.Join(root, "NativeMessagingHosts"))
		}
	}
	return dirs
}

// ensureHost writes the launcher script and the host manifests. Chrome starts
// the host without Molt's environment, so the launcher carries the plugin
// and state directories.
func ensureHost() ([]string, error) {
	state := stateDir()
	if err := os.MkdirAll(state, 0o700); err != nil {
		return nil, err
	}
	exe, err := os.Executable()
	if err != nil {
		return nil, err
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}

	launcher := filepath.Join(state, "native-host")
	script := fmt.Sprintf("#!/bin/sh\nMOLT_PLUGIN_DIR=%s\nMOLT_PLUGIN_STATE_DIR=%s\nexport MOLT_PLUGIN_DIR MOLT_PLUGIN_STATE_DIR\nexec %s host \"$@\"\n",
		shQuote(pluginDir()), shQuote(state), shQuote(exe))
	if err := writeIfChanged(launcher, []byte(script), 0o755); err != nil {
		return nil, err
	}

	origins := make([]string, 0, len(extensionIDs))
	for _, id := range extensionIDs {
		origins = append(origins, "chrome-extension://"+id+"/")
	}
	manifest, _ := json.MarshalIndent(map[string]any{
		"name":            hostName,
		"description":     "Molt Code browser bridge",
		"path":            launcher,
		"type":            "stdio",
		"allowed_origins": origins,
	}, "", "  ")
	manifest = append(manifest, '\n')

	var written []string
	for _, dir := range browserHostDirs() {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			continue
		}
		path := filepath.Join(dir, hostName+".json")
		if err := writeIfChanged(path, manifest, 0o644); err == nil {
			written = append(written, path)
		}
	}
	return written, nil
}

func writeIfChanged(path string, content []byte, mode os.FileMode) error {
	if existing, err := os.ReadFile(path); err == nil && bytes.Equal(existing, content) {
		return nil
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, content, mode); err != nil {
		return err
	}
	if err := os.Chmod(tmp, mode); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func shQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }
