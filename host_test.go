package main

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"io"
	"net"
	"strings"
	"testing"
)

// A fake extension answers every framed request; a CLI connection gets the
// matching response back as one line.
func TestHostRoundTrip(t *testing.T) {
	toExt, hostOut := io.Pipe()
	hostIn, fromExt := io.Pipe()
	h := &hostState{out: hostOut, waiting: map[string]chan json.RawMessage{}}
	go h.readExtension(hostIn)

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
			}
			json.Unmarshal(buf, &req)
			resp, _ := json.Marshal(map[string]any{"id": req.ID, "ok": true, "result": map[string]any{"echo": req.Method, "params": req.Params}})
			binary.Write(fromExt, binary.LittleEndian, uint32(len(resp)))
			fromExt.Write(resp)
		}
	}()

	cli, srv := net.Pipe()
	go h.serve(srv)
	cli.Write([]byte(`{"method":"tabs","params":{"tab":3}}` + "\n"))
	line, err := bufio.NewReader(cli).ReadString('\n')
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(line, `"echo":"tabs"`) || !strings.Contains(line, `"tab":3`) {
		t.Fatalf("unexpected response %s", line)
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
	if p["ref"] != "g2:e4" || p["text"] != "hello world" || p["submit"] != true || p["tab"] != 9 {
		t.Fatalf("bad params %v", p)
	}

	a, _ = parseArgs([]string{"click", "--xy", "10,20"})
	if _, _, err := buildRequest("click", nil, a); err == nil {
		t.Fatal("--xy without --capture must fail")
	}

	a, _ = parseArgs([]string{"open", "example.com"})
	_, p, _ = buildRequest("open", a.pos[1:], a)
	if p["url"] != "https://example.com" {
		t.Fatalf("url not normalized: %v", p["url"])
	}
}
