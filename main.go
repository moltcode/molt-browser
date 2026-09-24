// molt-browser drives the user's real Chrome through the Molt extension.
//
//	molt-browser <command> [args] [--tab ID] [--json] [--timeout SECONDS]
//
// The same binary is the native messaging host Chrome launches for the
// extension (`molt-browser host`, or a chrome-extension:// origin argument).
package main

import (
	"bufio"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var version = "dev"

const usage = `molt-browser drives your real Chrome through the Molt extension.

Tabs and pages
  status                          bridge + extension state
  tabs                            list tabs (id, active, url, title)
  open <url> [--focus]            open a new tab in the Molt tab group
  navigate <url>                  load a URL in the target tab
  back | forward | reload
  focus                           bring the tab to the front
  release                         stop controlling the tab (debugger detaches)

  Without --tab, commands target the tab the last 'open' created (while it
  exists), otherwise the active tab of the focused window.

Observe
  snapshot [--limit N] [--offset N] [--all]
                                  interactive elements with refs like g3:e12
  text [--max CHARS]              visible page text
  screenshot [--out FILE]         PNG of the viewport, prints its capture id
  console [--limit N] [--clear]   console messages and exceptions
  network [--limit N] [--filter S] [--clear]
                                  requests with status, type and timing
  body <request-id>               response body of one network request
  eval <js>                       evaluate JavaScript in the page, prints JSON

Act (the in-page cursor shows each action)
  click <ref> | --selector CSS | --xy X,Y --capture ID
  type [<ref>] <text> [--clear] [--submit]
  press <key>                     Enter, Tab, Escape, ArrowDown, Backspace, a, ...
  scroll [down|up] [--pages N] | scroll --to <ref>
  upload <ref> | --selector CSS <file>...
                                  set files on a file input

Setup
  setup                           register the native host, print install steps

Global flags
  --tab ID        target tab (see the default above)
  --json          print the raw JSON result
  --timeout S     seconds to wait for the extension (default 60)
`

var boolFlags = map[string]bool{"focus": true, "clear": true, "submit": true, "all": true, "json": true, "help": true}

type args struct {
	pos   []string
	flags map[string]string
}

func (a args) has(name string) bool { _, ok := a.flags[name]; return ok }

func parseArgs(raw []string) (args, error) {
	a := args{flags: map[string]string{}}
	for i := 0; i < len(raw); i++ {
		arg := raw[i]
		if arg == "--" {
			a.pos = append(a.pos, raw[i+1:]...)
			break
		}
		if !strings.HasPrefix(arg, "--") || len(arg) == 2 {
			a.pos = append(a.pos, arg)
			continue
		}
		name, value, inline := strings.Cut(arg[2:], "=")
		if inline {
			a.flags[name] = value
			continue
		}
		if boolFlags[name] {
			a.flags[name] = "true"
			continue
		}
		if i+1 >= len(raw) {
			return a, fmt.Errorf("--%s needs a value", name)
		}
		a.flags[name] = raw[i+1]
		i++
	}
	return a, nil
}

func main() {
	if len(os.Args) > 1 && (os.Args[1] == "host" || strings.HasPrefix(os.Args[1], "chrome-extension://")) {
		runHost()
		return
	}

	a, err := parseArgs(os.Args[1:])
	if err != nil {
		fatalf("%v", err)
	}
	if len(a.pos) == 0 || a.has("help") || a.pos[0] == "help" {
		fmt.Print(usage)
		return
	}
	cmd, rest := a.pos[0], a.pos[1:]

	// Idempotent; keeps the host registered for every browser on the machine.
	written, hostErr := ensureHost()

	switch cmd {
	case "version", "--version":
		fmt.Println(version)
	case "setup":
		runSetup(written, hostErr)
	case "status":
		runStatus(a)
	default:
		method, params, err := buildRequest(cmd, rest, a)
		if err != nil {
			fatalf("%v", err)
		}
		result := call(method, params, a)
		printResult(cmd, result, a)
	}
}

func buildRequest(cmd string, rest []string, a args) (string, map[string]any, error) {
	p := map[string]any{}
	if tab, ok := a.flags["tab"]; ok {
		id, err := strconv.Atoi(tab)
		if err != nil {
			return "", nil, fmt.Errorf("--tab must be a tab id from `molt-browser tabs`")
		}
		p["tab"] = id
	}
	intFlag := func(name string) error {
		if v, ok := a.flags[name]; ok {
			n, err := strconv.Atoi(v)
			if err != nil {
				return fmt.Errorf("--%s must be a number", name)
			}
			p[name] = n
		}
		return nil
	}
	need := func(n int, what string) error {
		if len(rest) < n {
			return fmt.Errorf("usage: molt-browser %s %s", cmd, what)
		}
		return nil
	}

	switch cmd {
	case "tabs", "back", "forward", "reload", "release", "focus":
		return cmd, p, nil
	case "open", "navigate":
		if err := need(1, "<url>"); err != nil {
			return "", nil, err
		}
		p["url"] = normalizeURL(rest[0])
		if a.has("focus") {
			p["focus"] = true
		}
		return cmd, p, nil
	case "snapshot":
		if err := intFlag("limit"); err != nil {
			return "", nil, err
		}
		if err := intFlag("offset"); err != nil {
			return "", nil, err
		}
		if a.has("all") {
			p["all"] = true
		}
		return cmd, p, nil
	case "text":
		return cmd, p, intFlag("max")
	case "screenshot":
		return cmd, p, nil
	case "console", "network":
		if err := intFlag("limit"); err != nil {
			return "", nil, err
		}
		if a.has("clear") {
			p["clear"] = true
		}
		if f, ok := a.flags["filter"]; ok {
			p["filter"] = f
		}
		return cmd, p, nil
	case "body":
		if err := need(1, "<request-id>"); err != nil {
			return "", nil, err
		}
		p["request_id"] = rest[0]
		return cmd, p, nil
	case "eval":
		if err := need(1, "<js>"); err != nil {
			return "", nil, err
		}
		p["expression"] = strings.Join(rest, " ")
		return cmd, p, nil
	case "click":
		switch {
		case a.flags["selector"] != "":
			p["selector"] = a.flags["selector"]
		case a.flags["xy"] != "":
			x, y, ok := strings.Cut(a.flags["xy"], ",")
			xf, err1 := strconv.ParseFloat(strings.TrimSpace(x), 64)
			yf, err2 := strconv.ParseFloat(strings.TrimSpace(y), 64)
			if !ok || err1 != nil || err2 != nil {
				return "", nil, fmt.Errorf("--xy takes X,Y in screenshot pixels")
			}
			if a.flags["capture"] == "" {
				return "", nil, fmt.Errorf("--xy needs --capture <id> from the screenshot the point was read from")
			}
			p["x"], p["y"], p["capture_id"] = xf, yf, a.flags["capture"]
		default:
			if err := need(1, "<ref> | --selector CSS | --xy X,Y --capture ID"); err != nil {
				return "", nil, err
			}
			p["ref"] = rest[0]
		}
		return cmd, p, nil
	case "type":
		if err := need(1, "[<ref>] <text>"); err != nil {
			return "", nil, err
		}
		if len(rest) >= 2 && refPattern.MatchString(rest[0]) {
			p["ref"], rest = rest[0], rest[1:]
		}
		if s := a.flags["selector"]; s != "" {
			p["selector"] = s
		}
		p["text"] = strings.Join(rest, " ")
		if a.has("clear") {
			p["clear"] = true
		}
		if a.has("submit") {
			p["submit"] = true
		}
		return cmd, p, nil
	case "upload":
		if s := a.flags["selector"]; s != "" {
			p["selector"] = s
		} else if len(rest) > 0 && refPattern.MatchString(rest[0]) {
			p["ref"], rest = rest[0], rest[1:]
		}
		if len(rest) == 0 {
			return "", nil, fmt.Errorf("usage: molt-browser upload <ref> | --selector CSS <file>...")
		}
		files := make([]string, 0, len(rest))
		for _, f := range rest {
			abs, err := filepath.Abs(f)
			if err != nil {
				return "", nil, err
			}
			if _, err := os.Stat(abs); err != nil {
				return "", nil, fmt.Errorf("%s: %v", f, err)
			}
			files = append(files, abs)
		}
		p["files"] = files
		return cmd, p, nil
	case "press":
		if err := need(1, "<key>"); err != nil {
			return "", nil, err
		}
		p["key"] = rest[0]
		return cmd, p, nil
	case "scroll":
		if to := a.flags["to"]; to != "" {
			p["ref"] = to
			return cmd, p, nil
		}
		p["direction"] = "down"
		if len(rest) > 0 {
			if rest[0] != "down" && rest[0] != "up" {
				return "", nil, fmt.Errorf("usage: molt-browser scroll [down|up] [--pages N] | --to <ref>")
			}
			p["direction"] = rest[0]
		}
		if v, ok := a.flags["pages"]; ok {
			f, err := strconv.ParseFloat(v, 64)
			if err != nil {
				return "", nil, fmt.Errorf("--pages must be a number")
			}
			p["pages"] = f
		}
		return cmd, p, nil
	}
	return "", nil, fmt.Errorf("unknown command %q (run molt-browser help)", cmd)
}

var refPattern = regexp.MustCompile(`^g\d+:e\d+$`)

func normalizeURL(u string) string {
	if strings.Contains(u, "://") || strings.HasPrefix(u, "about:") || strings.HasPrefix(u, "data:") {
		return u
	}
	return "https://" + u
}

type response struct {
	OK     bool            `json:"ok"`
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

var errNotConnected = errors.New("not connected")

func request(method string, params map[string]any, timeout time.Duration) (response, error) {
	var resp response
	conn, err := net.DialTimeout("unix", socketPath(), 2*time.Second)
	if err != nil {
		return resp, errNotConnected
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(timeout + 5*time.Second))

	line, _ := json.Marshal(map[string]any{"method": method, "params": params, "timeout_ms": timeout.Milliseconds()})
	if _, err := conn.Write(append(line, '\n')); err != nil {
		return resp, err
	}
	reader := bufio.NewReaderSize(conn, 1<<20)
	out, err := reader.ReadBytes('\n')
	if err != nil && len(out) == 0 {
		return resp, fmt.Errorf("bridge closed the connection: %v", err)
	}
	if err := json.Unmarshal(out, &resp); err != nil {
		return resp, fmt.Errorf("bad response from bridge: %v", err)
	}
	return resp, nil
}

func timeoutFlag(a args) time.Duration {
	if v, ok := a.flags["timeout"]; ok {
		if s, err := strconv.ParseFloat(v, 64); err == nil && s > 0 {
			return time.Duration(s * float64(time.Second))
		}
	}
	return 60 * time.Second
}

func call(method string, params map[string]any, a args) json.RawMessage {
	resp, err := request(method, params, timeoutFlag(a))
	if errors.Is(err, errNotConnected) {
		fatalf("the Molt Chrome extension is not connected. Open Chrome with the extension installed (molt-browser setup shows how), then retry.")
	}
	if err != nil {
		fatalf("%v", err)
	}
	if !resp.OK {
		if resp.Error != nil {
			fatalf("%s: %s", resp.Error.Code, resp.Error.Message)
		}
		fatalf("request failed")
	}
	return resp.Result
}

func runStatus(a args) {
	resp, err := request("hello", nil, 3*time.Second)
	if err != nil {
		if a.has("json") {
			fmt.Println(`{"connected":false}`)
		} else {
			fmt.Println("extension: not connected")
			fmt.Println("Chrome must be running with the Molt extension. Run `molt-browser setup` for install steps.")
		}
		os.Exit(1)
	}
	if a.has("json") {
		fmt.Printf("{\"connected\":true,\"extension\":%s}\n", resp.Result)
		return
	}
	var hello struct {
		Version string `json:"version"`
		Browser string `json:"browser"`
	}
	_ = json.Unmarshal(resp.Result, &hello)
	fmt.Printf("extension: connected (v%s, %s)\n", hello.Version, hello.Browser)
}

func runSetup(written []string, hostErr error) {
	if hostErr != nil {
		fatalf("could not register the native host: %v", hostErr)
	}
	if len(written) == 0 {
		fmt.Println("No Chromium-family browser profile found (Chrome, Chromium, Brave, Edge, Arc).")
	} else {
		fmt.Println("Native host registered for:")
		for _, path := range written {
			fmt.Println("  " + path)
		}
	}
	fmt.Printf(`
Install the extension (once per browser):
  1. Open chrome://extensions and turn on Developer mode.
  2. Click "Load unpacked" and pick:
       %s
  3. The extension id should be %s. Restart Chrome if it shows "not connected".

Then check with: molt-browser status
`, extensionDir(), extensionIDs[0])
}

func printResult(cmd string, raw json.RawMessage, a args) {
	if cmd == "screenshot" {
		printScreenshot(raw, a)
		return
	}
	if a.has("json") {
		fmt.Println(string(raw))
		return
	}
	switch cmd {
	case "snapshot":
		printSnapshot(raw)
	case "tabs":
		printTabs(raw)
	case "text":
		var r struct {
			URL, Title, Text string
			Truncated        bool
		}
		_ = json.Unmarshal(raw, &r)
		fmt.Printf("# %s\n%s\n\n%s\n", r.Title, r.URL, r.Text)
		if r.Truncated {
			fmt.Println("\n[truncated; pass --max for more]")
		}
	case "console", "network":
		var r struct {
			Entries []json.RawMessage `json:"entries"`
		}
		_ = json.Unmarshal(raw, &r)
		for _, e := range r.Entries {
			fmt.Println(string(e))
		}
		if len(r.Entries) == 0 {
			fmt.Println("(none)")
		}
	case "eval":
		var r struct {
			Value json.RawMessage `json:"value"`
		}
		_ = json.Unmarshal(raw, &r)
		fmt.Println(string(r.Value))
	case "body":
		var r struct {
			Body          string `json:"body"`
			Base64Encoded bool   `json:"base64Encoded"`
		}
		_ = json.Unmarshal(raw, &r)
		if r.Base64Encoded {
			fmt.Printf("[base64, %d chars]\n", len(r.Body))
		}
		fmt.Println(r.Body)
	default:
		var r struct {
			Summary string `json:"summary"`
		}
		if json.Unmarshal(raw, &r) == nil && r.Summary != "" {
			fmt.Println(r.Summary)
		} else {
			fmt.Println(string(raw))
		}
	}
}

func printTabs(raw json.RawMessage) {
	var r struct {
		Tabs []struct {
			ID      int    `json:"id"`
			Active  bool   `json:"active"`
			Focused bool   `json:"focused"`
			Agent   bool   `json:"agent"`
			Stopped bool   `json:"stopped"`
			URL     string `json:"url"`
			Title   string `json:"title"`
		} `json:"tabs"`
	}
	_ = json.Unmarshal(raw, &r)
	for _, t := range r.Tabs {
		marks := ""
		if t.Focused {
			marks += "*"
		}
		if t.Agent {
			marks += " molt"
		}
		if t.Stopped {
			marks += " stopped"
		}
		fmt.Printf("%d%s\t%s\t%s\n", t.ID, marks, t.URL, t.Title)
	}
}

func printSnapshot(raw json.RawMessage) {
	var r struct {
		Tab        int    `json:"tab"`
		URL        string `json:"url"`
		Title      string `json:"title"`
		Generation int    `json:"generation"`
		Total      int    `json:"total"`
		Offscreen  int    `json:"offscreen"`
		NextOffset *int   `json:"next_offset"`
		Viewport   struct {
			W       int `json:"w"`
			H       int `json:"h"`
			ScrollY int `json:"scroll_y"`
			PageH   int `json:"page_h"`
		} `json:"viewport"`
		Elements []struct {
			Ref      string `json:"ref"`
			Role     string `json:"role"`
			Name     string `json:"name"`
			Value    string `json:"value"`
			Href     string `json:"href"`
			X        int    `json:"x"`
			Y        int    `json:"y"`
			W        int    `json:"w"`
			H        int    `json:"h"`
			Visible  bool   `json:"in_viewport"`
			Disabled bool   `json:"disabled"`
			Checked  *bool  `json:"checked"`
		} `json:"elements"`
	}
	_ = json.Unmarshal(raw, &r)
	fmt.Printf("# %s\n%s  (tab %d, generation %d, %d elements, viewport %dx%d, scroll %d/%d)\n",
		r.Title, r.URL, r.Tab, r.Generation, r.Total, r.Viewport.W, r.Viewport.H, r.Viewport.ScrollY, r.Viewport.PageH)
	for _, e := range r.Elements {
		line := fmt.Sprintf("[%s] %s %q", e.Ref, e.Role, e.Name)
		if e.Value != "" {
			line += fmt.Sprintf(" value=%q", e.Value)
		}
		if e.Href != "" {
			line += " -> " + e.Href
		}
		if e.Checked != nil {
			line += fmt.Sprintf(" checked=%v", *e.Checked)
		}
		if e.Disabled {
			line += " disabled"
		}
		if !e.Visible {
			line += " (offscreen)"
		}
		fmt.Println(line)
	}
	if r.NextOffset != nil {
		fmt.Printf("[more: molt-browser snapshot --offset %d]\n", *r.NextOffset)
	}
	if r.Offscreen > 0 {
		fmt.Printf("[%d more offscreen: scroll, or snapshot --all]\n", r.Offscreen)
	}
}

func printScreenshot(raw json.RawMessage, a args) {
	var r struct {
		Data      string `json:"data"`
		CaptureID string `json:"capture_id"`
		Width     int    `json:"width"`
		Height    int    `json:"height"`
		URL       string `json:"url"`
	}
	if err := json.Unmarshal(raw, &r); err != nil {
		fatalf("bad screenshot: %v", err)
	}
	png, err := base64.StdEncoding.DecodeString(r.Data)
	if err != nil {
		fatalf("bad screenshot data: %v", err)
	}
	out := a.flags["out"]
	if out == "" {
		dir := filepath.Join(stateDir(), "screenshots")
		_ = os.MkdirAll(dir, 0o700)
		out = filepath.Join(dir, strings.ReplaceAll(r.CaptureID, ":", "-")+".png")
	}
	if err := os.WriteFile(out, png, 0o600); err != nil {
		fatalf("write %s: %v", out, err)
	}
	if a.has("json") {
		b, _ := json.Marshal(map[string]any{"path": out, "capture_id": r.CaptureID, "width": r.Width, "height": r.Height, "url": r.URL})
		fmt.Println(string(b))
		return
	}
	fmt.Printf("%s\ncapture %s, %dx%d, %s\n", out, r.CaptureID, r.Width, r.Height, r.URL)
}

func fatalf(format string, v ...any) {
	fmt.Fprintf(os.Stderr, "molt-browser: "+format+"\n", v...)
	os.Exit(1)
}
