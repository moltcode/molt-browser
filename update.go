package main

// Extension updates. The plugin and the extension ship with the same version
// (the Makefile checks it), so the plugin's version is the extension version
// Molt expects. A Web Store build that lags or an unpacked build Chrome has
// not reloaded shows up as an older extension; one below minProtocol cannot
// take commands at all.

import (
	"os"
	"strconv"
	"strings"
	"time"
)

const (
	updateNone      = "none"
	updateAvailable = "available"
	updateRequired  = "required"
)

// extensionUpdate compares what the connected extension said in its hello
// with what this plugin expects.
func extensionUpdate(extVersion string, extProtocol int) string {
	if extProtocol < minProtocol {
		return updateRequired
	}
	if compareVersions(extVersion, version) < 0 {
		return updateAvailable
	}
	return updateNone
}

// compareVersions orders dotted numeric versions; anything else (a "dev"
// build) compares equal so it never nags.
func compareVersions(a, b string) int {
	pa, okA := parseVersion(a)
	pb, okB := parseVersion(b)
	if !okA || !okB {
		return 0
	}
	for i := 0; i < len(pa) || i < len(pb); i++ {
		var x, y int
		if i < len(pa) {
			x = pa[i]
		}
		if i < len(pb) {
			y = pb[i]
		}
		if x != y {
			if x < y {
				return -1
			}
			return 1
		}
	}
	return 0
}

func parseVersion(v string) ([]int, bool) {
	if v == "" {
		return nil, false
	}
	parts := strings.Split(v, ".")
	out := make([]int, len(parts))
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil || n < 0 {
			return nil, false
		}
		out[i] = n
	}
	return out, true
}

// installFingerprint changes when the plugin is updated: the host binary is
// replaced, or a CLI at another path rewrote the launcher Chrome runs.
func installFingerprint(exe, launcher string) string {
	var b strings.Builder
	if fi, err := os.Stat(exe); err == nil {
		b.WriteString(fi.ModTime().UTC().Format(time.RFC3339Nano))
		b.WriteString(strconv.FormatInt(fi.Size(), 10))
	} else {
		b.WriteString("missing")
	}
	b.WriteString("|")
	if script, err := os.ReadFile(launcher); err == nil {
		b.Write(script)
	}
	return b.String()
}

// watchInstall returns once the plugin was updated under the running host
// and no command is in flight. The host then exits; the extension reconnects
// and Chrome starts the new build, whose ready message carries the version
// the extension is now expected to be.
func (h *hostState) watchInstall(fingerprint func() string, every time.Duration, stop <-chan struct{}) bool {
	start := fingerprint()
	tick := time.NewTicker(every)
	defer tick.Stop()
	for {
		select {
		case <-stop:
			return false
		case <-tick.C:
		}
		if fingerprint() == start {
			continue
		}
		h.mu.Lock()
		busy := len(h.waiting) > 0
		h.mu.Unlock()
		if !busy {
			return true
		}
	}
}
