package main

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// fakeExtension says hello with the given protocol, then echoes every framed
// request back, including the grant it arrived with.
func fakeExtension(t *testing.T, protocol int) *hostState {
	t.Helper()
	toExt, hostOut := io.Pipe()
	hostIn, fromExt := io.Pipe()
	h := &hostState{out: hostOut, waiting: map[string]chan json.RawMessage{}}
	go h.readExtension(hostIn)

	hello, _ := json.Marshal(map[string]any{"type": "hello", "version": "test", "protocol": protocol})
	binary.Write(fromExt, binary.LittleEndian, uint32(len(hello)))
	fromExt.Write(hello)

	go func() {
		for {
			var n uint32
			if err := binary.Read(toExt, binary.LittleEndian, &n); err != nil {
				return
			}
			buf := make([]byte, n)
			io.ReadFull(toExt, buf)
			var req struct {
				ID     string          `json:"id"`
				Method string          `json:"method"`
				Params json.RawMessage `json:"params"`
				Grant  string          `json:"grant"`
			}
			json.Unmarshal(buf, &req)
			resp, _ := json.Marshal(map[string]any{"id": req.ID, "ok": true, "result": map[string]any{"echo": req.Method, "params": req.Params, "grant": req.Grant}})
			binary.Write(fromExt, binary.LittleEndian, uint32(len(resp)))
			fromExt.Write(resp)
		}
	}()
	// Wait for the hello to land.
	for i := 0; i < 100; i++ {
		h.mu.Lock()
		ok := h.hello != nil
		h.mu.Unlock()
		if ok {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	return h
}

func roundTrip(t *testing.T, h *hostState, line string) string {
	t.Helper()
	cli, srv := net.Pipe()
	go h.serve(srv)
	cli.Write([]byte(line + "\n"))
	out, err := bufio.NewReader(cli).ReadString('\n')
	if err != nil {
		t.Fatal(err)
	}
	return out
}

// A CLI connection gets the matching response back as one line, and the
// grant reaches the extension untouched.
func TestHostRoundTrip(t *testing.T) {
	h := fakeExtension(t, 2)
	line := roundTrip(t, h, `{"method":"tabs","params":{"tab":3},"grant":"abc.def"}`)
	if !strings.Contains(line, `"echo":"tabs"`) || !strings.Contains(line, `"tab":3`) || !strings.Contains(line, `"grant":"abc.def"`) {
		t.Fatalf("unexpected response %s", line)
	}
}

// Protocol 1 extensions run unsigned commands; the host refuses to drive them
// except for the reload that updates them.
func TestHostFailsClosedOnOutdatedExtension(t *testing.T) {
	h := fakeExtension(t, 1)
	if line := roundTrip(t, h, `{"method":"eval","params":{"expression":"1"},"grant":"x.y"}`); !strings.Contains(line, "extension_outdated") {
		t.Fatalf("outdated extension was driven: %s", line)
	}
	if line := roundTrip(t, h, `{"method":"reload_extension"}`); !strings.Contains(line, `"echo":"reload_extension"`) {
		t.Fatalf("reload must reach an outdated extension: %s", line)
	}
}

func TestHostRejectsBeforeHello(t *testing.T) {
	h := &hostState{out: io.Discard, waiting: map[string]chan json.RawMessage{}}
	if line := roundTrip(t, h, `{"method":"tabs"}`); !strings.Contains(line, "extension_not_ready") {
		t.Fatalf("request before hello was forwarded: %s", line)
	}
}

// The CLI never sends a session: the extension takes it from the grant.
func TestBuildRequestSendsNoSession(t *testing.T) {
	t.Setenv("MOLTCODE_SESSION_ID", "s1")
	t.Setenv("MOLT_BROWSER_SESSION", "s2")
	a, _ := parseArgs([]string{"tabs"})
	_, p, _ := buildRequest("tabs", nil, a)
	if _, ok := p["session"]; ok {
		t.Fatalf("session leaked into params: %v", p)
	}
}

func TestFetchGrantNeedsLease(t *testing.T) {
	t.Setenv("MOLT_BROWSER_GRANT_URL", "")
	t.Setenv("MOLT_BROWSER_LEASE", "")
	if _, err := fetchGrant(); err == nil || !strings.HasPrefix(err.Error(), "no_grant") {
		t.Fatalf("expected no_grant, got %v", err)
	}
}

func TestFetchGrant(t *testing.T) {
	var got map[string]string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer backend-token" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		json.NewDecoder(r.Body).Decode(&got)
		if got["lease"] != "L" {
			w.WriteHeader(http.StatusForbidden)
			w.Write([]byte(`{"error":{"code":"bad_lease","message":"no"}}`))
			return
		}
		w.Write([]byte(`{"grant":"g.s"}`))
	}))
	defer srv.Close()
	t.Setenv("MOLT_BROWSER_GRANT_URL", srv.URL)
	t.Setenv("MOLTCODE_AUTH_TOKEN", "backend-token")
	t.Setenv("MOLTCODE_SESSION_ID", "sess")
	t.Setenv("MOLT_BROWSER_LEASE", "L")
	if g, err := fetchGrant(); err != nil || g != "g.s" || got["session_id"] != "sess" {
		t.Fatalf("grant %q err %v body %v", g, err, got)
	}
	t.Setenv("MOLT_BROWSER_LEASE", "wrong")
	if _, err := fetchGrant(); err == nil || !strings.HasPrefix(err.Error(), "bad_lease") {
		t.Fatalf("expected bad_lease, got %v", err)
	}
}

func TestHostRejectsOversizedRequest(t *testing.T) {
	h := &hostState{out: io.Discard, waiting: map[string]chan json.RawMessage{}}
	if err := h.send(make([]byte, maxToExtension+1)); err == nil {
		t.Fatal("expected the 1 MB limit to be enforced")
	}
}

func TestBuildRequest(t *testing.T) {
	a, _ := parseArgs([]string{"type", "g2:e4", "hello", "world", "--submit", "--tab", "9"})
	method, p, err := buildRequest(a.pos[0], a.pos[1:], a)
	if err != nil || method != "type" {
		t.Fatalf("got %s %v", method, err)
	}
	if p["target"] != "g2:e4" || p["text"] != "hello world" || p["submit"] != true || p["tab"] != 9 {
		t.Fatalf("bad params %v", p)
	}

	a, _ = parseArgs([]string{"click", "--xy", "10,20"})
	if _, _, err := buildRequest("click", nil, a); err == nil {
		t.Fatal("--xy without --capture must fail")
	}

	a, _ = parseArgs([]string{"fill", "Email", "sam@x.com", "Role", "Admin", "--submit"})
	_, p, err = buildRequest("fill", a.pos[1:], a)
	if err != nil || len(p["fields"].([]map[string]any)) != 2 || p["submit"] != true {
		t.Fatalf("bad fill %v %v", p, err)
	}

	a, _ = parseArgs([]string{"click", "Save", "draft"})
	_, p, _ = buildRequest("click", a.pos[1:], a)
	if p["target"] != "Save draft" {
		t.Fatalf("click target %v", p["target"])
	}

	a, _ = parseArgs([]string{"open", "example.com"})
	_, p, _ = buildRequest("open", a.pos[1:], a)
	if p["url"] != "https://example.com" {
		t.Fatalf("url not normalized: %v", p["url"])
	}
}
