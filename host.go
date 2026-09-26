package main

// Native messaging host. Chrome starts this process when the Molt extension
// calls chrome.runtime.connectNative, and talks to it over stdin/stdout with
// 4-byte little-endian length-prefixed JSON. The host opens a unix socket in
// the plugin state dir; each CLI invocation connects, sends one request line
// and reads one response line. No TCP port is ever opened.
//
// The host holds no secrets and makes no auth decisions beyond failing
// closed on an extension too old to check grants: it relays each request's
// grant untouched and the extension verifies it.

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"sync/atomic"
	"time"
)

// Chrome refuses host-to-extension messages over 1 MB.
const maxToExtension = 1 << 20

// Extensions older than this protocol execute unsigned commands, so the
// host refuses to drive them.
const minProtocol = 2

// Methods an outdated extension may still receive: reloading picks up the
// updated unpacked build, which is how it stops being outdated.
var preAuthMethods = map[string]bool{"reload_extension": true}

type hostState struct {
	out     io.Writer
	outMu   sync.Mutex
	nextID  atomic.Int64
	mu      sync.Mutex
	waiting map[string]chan json.RawMessage
	hello   json.RawMessage
	proto   int
}

func runHost() {
	state := stateDir()
	if err := os.MkdirAll(state, 0o700); err != nil {
		fatalf("state dir: %v", err)
	}
	logFile, err := os.OpenFile(filepath.Join(state, "host.log"), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err == nil {
		log.SetOutput(logFile)
	}
	log.Printf("host start pid=%d args=%v", os.Getpid(), os.Args[1:])

	h := &hostState{out: os.Stdout, waiting: map[string]chan json.RawMessage{}}

	sock := socketPath()
	// A newer host takes the socket over; the previous one keeps serving its
	// extension until Chrome closes it.
	_ = os.Remove(sock)
	ln, err := net.Listen("unix", sock)
	if err != nil {
		log.Printf("listen %s: %v", sock, err)
		os.Exit(1)
	}
	_ = os.Chmod(sock, 0o600)

	// Tells the extension the bridge is actually up; a missing host only shows
	// up as a disconnect on the extension side.
	ready, _ := json.Marshal(map[string]any{"type": "ready", "version": version, "pid": os.Getpid()})
	if err := h.send(ready); err != nil {
		log.Printf("ready: %v", err)
	}

	done := make(chan struct{})
	go func() {
		h.readExtension(os.Stdin)
		close(done)
	}()
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go h.serve(conn)
		}
	}()

	<-done
	log.Printf("extension disconnected, exiting")
	ln.Close()
	// Only remove the socket if it is still ours.
	if fi, err := os.Stat(sock); err == nil && fi.Mode()&os.ModeSocket != 0 {
		if c, err := net.DialTimeout("unix", sock, 200*time.Millisecond); err != nil {
			_ = os.Remove(sock)
		} else {
			c.Close()
		}
	}
}

func (h *hostState) readExtension(r io.Reader) {
	br := bufio.NewReader(r)
	for {
		var n uint32
		if err := binary.Read(br, binary.LittleEndian, &n); err != nil {
			return
		}
		buf := make([]byte, n)
		if _, err := io.ReadFull(br, buf); err != nil {
			return
		}
		var head struct {
			ID   string `json:"id"`
			Type string `json:"type"`
		}
		if err := json.Unmarshal(buf, &head); err != nil {
			log.Printf("bad message from extension: %v", err)
			continue
		}
		if head.Type == "hello" {
			var hello struct {
				Protocol int `json:"protocol"`
			}
			_ = json.Unmarshal(buf, &hello)
			h.mu.Lock()
			h.hello = buf
			h.proto = hello.Protocol
			h.mu.Unlock()
			log.Printf("hello %s", buf)
			continue
		}
		h.mu.Lock()
		ch := h.waiting[head.ID]
		delete(h.waiting, head.ID)
		h.mu.Unlock()
		log.Printf("<- %s %.300s", head.ID, buf)
		if ch != nil {
			ch <- buf
		}
	}
}

func (h *hostState) send(msg []byte) error {
	if len(msg) > maxToExtension {
		return fmt.Errorf("request is %d bytes; the extension accepts at most 1 MB", len(msg))
	}
	h.outMu.Lock()
	defer h.outMu.Unlock()
	if err := binary.Write(h.out, binary.LittleEndian, uint32(len(msg))); err != nil {
		return err
	}
	_, err := h.out.Write(msg)
	return err
}

type cliRequest struct {
	Method    string          `json:"method"`
	Params    json.RawMessage `json:"params,omitempty"`
	Grant     string          `json:"grant,omitempty"`
	TimeoutMs int             `json:"timeout_ms,omitempty"`
}

func (h *hostState) serve(conn net.Conn) {
	defer conn.Close()
	line, err := bufio.NewReader(conn).ReadBytes('\n')
	if err != nil && len(line) == 0 {
		return
	}
	var req cliRequest
	if err := json.Unmarshal(line, &req); err != nil {
		writeLine(conn, errorResponse("", "bad_request", err.Error()))
		return
	}

	if req.Method == "hello" {
		h.mu.Lock()
		hello := h.hello
		h.mu.Unlock()
		if hello == nil {
			hello = []byte(`{}`)
		}
		writeLine(conn, fmt.Appendf(nil, `{"ok":true,"result":%s}`, hello))
		return
	}

	h.mu.Lock()
	proto, connected := h.proto, h.hello != nil
	h.mu.Unlock()
	if !preAuthMethods[req.Method] && proto < minProtocol {
		if !connected {
			writeLine(conn, errorResponse("", "extension_not_ready", "the Molt extension has not said hello yet; retry in a moment"))
		} else {
			writeLine(conn, errorResponse("", "extension_outdated", "the Molt Chrome extension is too old to check Molt auth; update it (molt-browser reload-extension picks up the unpacked build)"))
		}
		return
	}

	id := strconv.FormatInt(h.nextID.Add(1), 10)
	ch := make(chan json.RawMessage, 1)
	h.mu.Lock()
	h.waiting[id] = ch
	h.mu.Unlock()

	params := req.Params
	if len(params) == 0 {
		params = json.RawMessage(`{}`)
	}
	out := map[string]any{"id": id, "method": req.Method, "params": params}
	if req.Grant != "" {
		out["grant"] = req.Grant
	}
	msg, _ := json.Marshal(out)
	// Never log the grant.
	log.Printf("-> %s %s", id, req.Method)
	if err := h.send(msg); err != nil {
		h.drop(id)
		writeLine(conn, errorResponse(id, "bridge_error", err.Error()))
		return
	}

	timeout := time.Duration(req.TimeoutMs) * time.Millisecond
	if timeout <= 0 {
		timeout = 60 * time.Second
	}
	select {
	case resp := <-ch:
		writeLine(conn, resp)
	case <-time.After(timeout):
		h.drop(id)
		writeLine(conn, errorResponse(id, "timeout", fmt.Sprintf("the extension did not answer %q within %s", req.Method, timeout)))
	}
}

func (h *hostState) drop(id string) {
	h.mu.Lock()
	delete(h.waiting, id)
	h.mu.Unlock()
}

func writeLine(conn net.Conn, b []byte) {
	conn.Write(append(b, '\n'))
}

func errorResponse(id, code, message string) []byte {
	b, _ := json.Marshal(map[string]any{
		"id": id, "ok": false,
		"error": map[string]string{"code": code, "message": message},
	})
	return b
}
