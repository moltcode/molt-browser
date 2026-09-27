package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

func TestCompareVersions(t *testing.T) {
	cases := []struct {
		a, b string
		want int
	}{
		{"0.4.0", "0.4.0", 0},
		{"0.3.9", "0.4.0", -1},
		{"0.10.0", "0.9.1", 1},
		{"1.0", "1.0.0", 0},
		{"1.0.0", "1.0.1", -1},
		{"dev", "0.4.0", 0},
		{"0.4.0", "dev", 0},
		{"", "0.4.0", 0},
	}
	for _, c := range cases {
		if got := compareVersions(c.a, c.b); got != c.want {
			t.Errorf("compareVersions(%q, %q) = %d, want %d", c.a, c.b, got, c.want)
		}
	}
}

func TestExtensionUpdate(t *testing.T) {
	old := version
	version = "0.5.0"
	defer func() { version = old }()

	if got := extensionUpdate("0.5.0", minProtocol); got != updateNone {
		t.Errorf("same version: %s", got)
	}
	if got := extensionUpdate("0.6.0", minProtocol); got != updateNone {
		t.Errorf("newer extension: %s", got)
	}
	if got := extensionUpdate("0.4.0", minProtocol); got != updateAvailable {
		t.Errorf("older extension: %s", got)
	}
	// Too old to check auth outranks the version.
	if got := extensionUpdate("0.9.0", minProtocol-1); got != updateRequired {
		t.Errorf("old protocol: %s", got)
	}
}

// A replaced binary or rewritten launcher ends the host once nothing is in
// flight; commands still waiting on the extension hold it.
func TestWatchInstall(t *testing.T) {
	dir := t.TempDir()
	exe := filepath.Join(dir, "molt-browser")
	launcher := filepath.Join(dir, "native-host")
	os.WriteFile(exe, []byte("v1"), 0o755)
	os.WriteFile(launcher, []byte("#!/bin/sh\nexec old\n"), 0o755)

	h := newHostState(nil)
	h.waiting["1"] = make(chan json.RawMessage)
	var finished atomic.Bool
	go func() {
		finished.Store(h.watchInstall(func() string { return installFingerprint(exe, launcher) }, 5*time.Millisecond, make(chan struct{})))
	}()

	time.Sleep(30 * time.Millisecond)
	os.WriteFile(launcher, []byte("#!/bin/sh\nexec new\n"), 0o755)
	time.Sleep(30 * time.Millisecond)
	if finished.Load() {
		t.Fatal("host exited with a command in flight")
	}
	h.mu.Lock()
	delete(h.waiting, "1")
	h.mu.Unlock()
	deadline := time.Now().Add(time.Second)
	for !finished.Load() && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if !finished.Load() {
		t.Fatal("host kept running an outdated build")
	}
}

func TestWatchInstallStopsWithExtension(t *testing.T) {
	h := newHostState(nil)
	stop := make(chan struct{})
	close(stop)
	if h.watchInstall(func() string { return "same" }, time.Millisecond, stop) {
		t.Fatal("reported an update after the extension left")
	}
}
