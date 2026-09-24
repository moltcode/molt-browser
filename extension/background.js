// Molt Code browser bridge: service worker.
//
// Molt agents call the molt-browser CLI, which talks to the native messaging
// host over a private unix socket; the host forwards each request here as
// {id, method, params}. Actions go through chrome.debugger (trusted input that
// works in background tabs), page reads go through chrome.scripting in the
// extension's isolated world, and overlay.js draws the agent cursor, the
// glow border and the Stop pill.

import { snapshotPage, resolveTarget, prepareTyping, pageText, viewportInfo, scrollPage } from "./page.js";

const HOST = "com.moltcode.browser";
const VERSION = chrome.runtime.getManifest().version;
const IDLE_MS = 2 * 60 * 1000;
const RING = 500;

let port = null;
let bridge = { connected: false, error: null, hostVersion: null };
let reconnectTimer = null;

// tabId -> { console: [], network: Map, captures: Map, lastCapture, cursor, lastUsed }
const sessions = new Map();
// Tabs where the user pressed Stop (or cancelled the debugger bar).
let stopped = new Set();
// Tab the last `open` created; the default target while it exists.
let agentTab = null;

const ready = chrome.storage.session.get(["stopped", "agentTab"]).then((saved) => {
  stopped = new Set(saved.stopped || []);
  agentTab = saved.agentTab ?? null;
});

function persist() {
  chrome.storage.session.set({ stopped: [...stopped], agentTab });
}

// ---------------------------------------------------------------------------
// Native bridge
// ---------------------------------------------------------------------------

function connect() {
  if (port) return;
  clearTimeout(reconnectTimer);
  port = chrome.runtime.connectNative(HOST);
  port.onMessage.addListener(onHostMessage);
  port.onDisconnect.addListener(() => {
    bridge = { connected: false, error: chrome.runtime.lastError?.message || "bridge closed", hostVersion: null };
    port = null;
    reconnectTimer = setTimeout(connect, 5000);
  });
  port.postMessage({ type: "hello", version: VERSION, browser: browserName() });
}

function browserName() {
  const brands = navigator.userAgentData?.brands?.map((b) => `${b.brand} ${b.version}`) || [];
  return brands.find((b) => !/Not.A.Brand|Chromium/.test(b)) || brands[0] || "Chromium";
}

async function onHostMessage(msg) {
  if (msg.type === "ready") {
    bridge = { connected: true, error: null, hostVersion: msg.version };
    return;
  }
  const { id, method, params } = msg;
  let reply;
  try {
    await ready;
    const handler = handlers[method];
    if (!handler) fail("unknown_method", `unknown method ${method}`);
    reply = { id, ok: true, result: await handler(params || {}) };
  } catch (e) {
    reply = { id, ok: false, error: { code: e.code || "error", message: e.message || String(e) } };
  }
  port?.postMessage(reply);
}

chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
chrome.alarms.create("molt-reconnect", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "molt-reconnect") connect();
});
connect();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  throw err;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function withTimeout(promise, ms, code, message) {
  return Promise.race([promise, sleep(ms).then(() => fail(code, message))]);
}

async function targetTab(params) {
  if (params.tab != null) {
    const tab = await chrome.tabs.get(params.tab).catch(() => null);
    if (!tab) fail("no_tab", `tab ${params.tab} does not exist (molt-browser tabs lists them)`);
    return tab;
  }
  if (agentTab != null) {
    const tab = await chrome.tabs.get(agentTab).catch(() => null);
    if (tab) return tab;
    agentTab = null;
    persist();
  }
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true, windowType: "normal" });
  if (!tab) fail("no_tab", "no focused browser tab; pass --tab");
  return tab;
}

function checkAllowed(tab) {
  if (stopped.has(tab.id)) {
    fail(
      "stopped_by_user",
      `The user pressed Stop on tab ${tab.id}. Ask them before using it again; they can re-allow it from the Molt toolbar button.`
    );
  }
  const url = tab.url || tab.pendingUrl || "";
  if (/^(chrome|edge|brave|about|devtools|chrome-extension|view-source):/.test(url) || url.startsWith("https://chromewebstore.google.com")) {
    fail("restricted_page", `Chrome does not let extensions control ${url}. Navigate the tab to a web page first.`);
  }
}

async function cdp(tabId, method, params = {}) {
  try {
    return await chrome.debugger.sendCommand({ tabId }, method, params);
  } catch (e) {
    fail("cdp_error", `${method}: ${e.message}`);
  }
}

async function attach(tab) {
  checkAllowed(tab);
  let session = sessions.get(tab.id);
  if (!session) {
    try {
      await chrome.debugger.attach({ tabId: tab.id }, "1.3");
    } catch (e) {
      if (!/already attached/i.test(e.message)) fail("attach_failed", `could not control tab ${tab.id}: ${e.message}`);
    }
    session = { console: [], network: new Map(), captures: new Map(), lastCapture: null, cursor: null, lastUsed: Date.now() };
    sessions.set(tab.id, session);
    await Promise.all(["Runtime.enable", "Log.enable", "Network.enable", "Page.enable"].map((m) => cdp(tab.id, m)));
  }
  session.lastUsed = Date.now();
  await overlay(tab.id, { op: "show" });
  return session;
}

async function detach(tabId) {
  if (!sessions.has(tabId)) return false;
  sessions.delete(tabId);
  await chrome.debugger.detach({ tabId }).catch(() => {});
  await overlay(tabId, { op: "hide" }, { inject: false });
  return true;
}

// Detach idle tabs so Chrome's "is debugging this browser" bar goes away.
setInterval(() => {
  const now = Date.now();
  for (const [tabId, s] of sessions) if (now - s.lastUsed > IDLE_MS) detach(tabId);
}, 15000);

chrome.debugger.onDetach.addListener(({ tabId }, reason) => {
  if (!sessions.has(tabId)) return;
  sessions.delete(tabId);
  overlay(tabId, { op: "hide" }, { inject: false });
  if (reason === "canceled_by_user") {
    stopped.add(tabId);
    persist();
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  sessions.delete(tabId);
  if (stopped.delete(tabId) || agentTab === tabId) {
    if (agentTab === tabId) agentTab = null;
    persist();
  }
});

async function overlay(tabId, msg, { inject = true } = {}) {
  try {
    if (inject) {
      await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ["overlay.js"] });
    }
    return await withTimeout(chrome.tabs.sendMessage(tabId, { molt: "overlay", ...msg }, { frameId: 0 }), 2000, "overlay", "overlay timeout");
  } catch {
    return null;
  }
}

async function inPage(tabId, func, ...args) {
  let results;
  try {
    results = await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, func, args });
  } catch (e) {
    fail("script_failed", e.message);
  }
  const value = results?.[0]?.result;
  if (value?.error) fail(value.error, value.message);
  return value;
}

async function moveCursor(tabId, session, x, y, label) {
  await overlay(tabId, { op: "move", x, y, label, from: session.cursor });
  session.cursor = { x, y };
}

function waitForLoad(tabId, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const done = () => {
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === "complete") done();
    };
    const timer = setTimeout(done, timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function pageSummary(tabId, verb) {
  const tab = await chrome.tabs.get(tabId);
  return { tab: tabId, url: tab.url, title: tab.title, summary: `${verb}; tab ${tabId} is now ${tab.url} (${tab.title})` };
}

async function navigateWith(params, verb, action) {
  const tab = await targetTab(params);
  checkAllowed(tab);
  const loaded = waitForLoad(tab.id);
  await action(tab.id);
  await loaded;
  if (sessions.has(tab.id)) await overlay(tab.id, { op: "show" });
  return pageSummary(tab.id, verb);
}

// Chrome's CDP key table for the keys agents actually press.
const KEYS = {
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Tab: { code: "Tab", keyCode: 9 },
  Escape: { code: "Escape", keyCode: 27 },
  Backspace: { code: "Backspace", keyCode: 8 },
  Delete: { code: "Delete", keyCode: 46 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  Home: { code: "Home", keyCode: 36 },
  End: { code: "End", keyCode: 35 },
  PageUp: { code: "PageUp", keyCode: 33 },
  PageDown: { code: "PageDown", keyCode: 34 },
  Space: { key: " ", code: "Space", keyCode: 32, text: " " },
};
const MODIFIERS = { Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Cmd: 4, Command: 4, Shift: 8 };

function keyEvent(spec) {
  const parts = spec.split("+");
  const name = parts.pop();
  let modifiers = 0;
  for (const m of parts) {
    if (!(m in MODIFIERS)) fail("bad_key", `unknown modifier ${m} (use Alt, Control, Meta, Shift)`);
    modifiers |= MODIFIERS[m];
  }
  let ev = KEYS[name] ? { key: name, ...KEYS[name] } : null;
  if (!ev && name.length === 1) {
    const upper = name.toUpperCase();
    const code = /[A-Z]/.test(upper) ? `Key${upper}` : /[0-9]/.test(name) ? `Digit${name}` : "";
    ev = { key: name, code, keyCode: upper.charCodeAt(0), text: name };
  }
  if (!ev) fail("bad_key", `unknown key ${name}`);
  // Chords with Control/Meta are shortcuts, not text input.
  if (modifiers & 6) delete ev.text;
  return { ...ev, modifiers };
}

async function pressKey(tabId, spec) {
  const ev = keyEvent(spec);
  const base = { key: ev.key, code: ev.code, windowsVirtualKeyCode: ev.keyCode, modifiers: ev.modifiers };
  await cdp(tabId, "Input.dispatchKeyEvent", { type: ev.text ? "keyDown" : "rawKeyDown", ...base, text: ev.text, unmodifiedText: ev.text });
  await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...base });
}

async function mouseClick(tabId, x, y) {
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

function describe(target) {
  return `${target.role || target.tag} "${target.name || ""}"`;
}

// ---------------------------------------------------------------------------
// Console and network observation
// ---------------------------------------------------------------------------

function push(list, entry) {
  list.push(entry);
  if (list.length > RING) list.splice(0, list.length - RING);
}

function remoteValue(arg) {
  if (arg.type === "string") return arg.value;
  if ("value" in arg) return JSON.stringify(arg.value);
  return arg.description || arg.type;
}

chrome.debugger.onEvent.addListener(({ tabId }, method, params) => {
  const s = sessions.get(tabId);
  if (!s) return;
  switch (method) {
    case "Runtime.consoleAPICalled": {
      const frame = params.stackTrace?.callFrames?.[0];
      push(s.console, {
        level: params.type,
        text: (params.args || []).map(remoteValue).join(" "),
        source: frame ? `${frame.url}:${frame.lineNumber + 1}` : undefined,
        time: params.timestamp,
      });
      break;
    }
    case "Runtime.exceptionThrown": {
      const d = params.exceptionDetails;
      push(s.console, {
        level: "exception",
        text: d.exception?.description || d.text,
        source: d.url ? `${d.url}:${d.lineNumber + 1}` : undefined,
        time: params.timestamp,
      });
      break;
    }
    case "Log.entryAdded": {
      const e = params.entry;
      push(s.console, { level: e.level, text: e.text, source: e.url, origin: e.source, time: e.timestamp });
      break;
    }
    case "Network.requestWillBeSent": {
      s.network.set(params.requestId, {
        id: params.requestId,
        method: params.request.method,
        url: params.request.url,
        type: params.type,
        started: params.wallTime,
        _t0: params.timestamp,
      });
      if (s.network.size > RING) s.network.delete(s.network.keys().next().value);
      break;
    }
    case "Network.responseReceived": {
      const r = s.network.get(params.requestId);
      if (r) Object.assign(r, { status: params.response.status, mime: params.response.mimeType });
      break;
    }
    case "Network.loadingFinished": {
      const r = s.network.get(params.requestId);
      if (r) Object.assign(r, { bytes: params.encodedDataLength, ms: Math.round((params.timestamp - r._t0) * 1000) });
      break;
    }
    case "Network.loadingFailed": {
      const r = s.network.get(params.requestId);
      if (r) Object.assign(r, { failed: params.errorText, ms: Math.round((params.timestamp - r._t0) * 1000) });
      break;
    }
  }
});

// ---------------------------------------------------------------------------
// Methods
// ---------------------------------------------------------------------------

const handlers = {
  async tabs() {
    const [focused] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const tabs = await chrome.tabs.query({});
    return {
      tabs: tabs.map((t) => ({
        id: t.id,
        window: t.windowId,
        active: t.active,
        focused: t.id === focused?.id,
        agent: t.id === agentTab,
        controlled: sessions.has(t.id),
        stopped: stopped.has(t.id),
        url: t.url,
        title: t.title,
      })),
    };
  },

  async open({ url, focus }) {
    const [current] = await chrome.tabs.query({ active: true, lastFocusedWindow: true, windowType: "normal" });
    const tab = await chrome.tabs.create({ url, active: !!focus, windowId: current?.windowId });
    const loaded = waitForLoad(tab.id);
    agentTab = tab.id;
    persist();
    await groupTab(tab);
    if ((await chrome.tabs.get(tab.id)).status !== "complete") await loaded;
    if (focus) await chrome.windows.update(tab.windowId, { focused: true });
    return pageSummary(tab.id, `opened tab ${tab.id}${focus ? "" : " in the background"}`);
  },

  navigate: (p) => navigateWith(p, `loaded ${p.url}`, (id) => chrome.tabs.update(id, { url: p.url })),
  back: (p) => navigateWith(p, "went back", (id) => chrome.tabs.goBack(id)),
  forward: (p) => navigateWith(p, "went forward", (id) => chrome.tabs.goForward(id)),
  reload: (p) => navigateWith(p, "reloaded", (id) => chrome.tabs.reload(id)),

  async focus(p) {
    const tab = await targetTab(p);
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    return pageSummary(tab.id, "focused");
  },

  async release(p) {
    const tab = await targetTab(p);
    const was = await detach(tab.id);
    if (agentTab === tab.id) {
      agentTab = null;
      persist();
    }
    return { tab: tab.id, summary: was ? `released tab ${tab.id}` : `tab ${tab.id} was not under control` };
  },

  async snapshot(p) {
    const tab = await targetTab(p);
    await attach(tab);
    const snap = await inPage(tab.id, snapshotPage, { limit: p.limit ?? 150, offset: p.offset ?? 0, all: !!p.all });
    return { tab: tab.id, ...snap };
  },

  async text(p) {
    const tab = await targetTab(p);
    checkAllowed(tab);
    return inPage(tab.id, pageText, p.max ?? 20000);
  },

  async screenshot(p) {
    const tab = await targetTab(p);
    const s = await attach(tab);
    const view = await inPage(tab.id, viewportInfo);
    await overlay(tab.id, { op: "conceal" });
    let shot;
    try {
      shot = await withTimeout(
        cdp(tab.id, "Page.captureScreenshot", { format: "png" }),
        10000,
        "not_rendered",
        `Chrome did not render tab ${tab.id} (background tabs sometimes don't paint). Run molt-browser focus first.`
      );
    } finally {
      await overlay(tab.id, { op: "reveal" });
    }
    const captureId = `${tab.id}:${Date.now().toString(36)}`;
    // Only the latest capture can anchor a coordinate click.
    s.captures = new Map([[captureId, view]]);
    s.lastCapture = captureId;
    return {
      tab: tab.id,
      data: shot.data,
      capture_id: captureId,
      width: Math.round(view.w * view.dpr),
      height: Math.round(view.h * view.dpr),
      url: tab.url,
    };
  },

  async click(p) {
    const tab = await targetTab(p);
    const s = await attach(tab);
    let x, y, what;
    if (p.capture_id) {
      const cap = s.captures.get(p.capture_id);
      if (!cap || s.lastCapture !== p.capture_id) {
        fail("stale_capture", `capture ${p.capture_id} is not the latest screenshot of tab ${tab.id}; take a new one`);
      }
      const now = await inPage(tab.id, viewportInfo);
      if (now.scroll_x !== cap.scroll_x || now.scroll_y !== cap.scroll_y || now.url !== cap.url) {
        fail("stale_capture", "the page scrolled or navigated since that screenshot; take a new one");
      }
      x = p.x / cap.dpr;
      y = p.y / cap.dpr;
      what = `point (${Math.round(p.x)},${Math.round(p.y)})`;
    } else {
      const target = await inPage(tab.id, resolveTarget, p.ref ?? null, p.selector ?? null);
      ({ x, y } = target);
      what = describe(target);
      if (target.obscured_by) what += ` (covered by ${target.obscured_by})`;
    }
    await moveCursor(tab.id, s, x, y, `Clicking ${what}`);
    await mouseClick(tab.id, x, y);
    await overlay(tab.id, { op: "pulse" });
    await sleep(400);
    return pageSummary(tab.id, `clicked ${what}`);
  },

  async type(p) {
    const tab = await targetTab(p);
    const s = await attach(tab);
    let what = "the focused element";
    if (p.ref || p.selector) {
      const target = await inPage(tab.id, resolveTarget, p.ref ?? null, p.selector ?? null);
      what = describe(target);
      await moveCursor(tab.id, s, target.x, target.y, `Typing into ${what}`);
      await mouseClick(tab.id, target.x, target.y);
    }
    if (p.clear) await inPage(tab.id, prepareTyping);
    if (p.text) await cdp(tab.id, "Input.insertText", { text: p.text });
    if (p.submit) await pressKey(tab.id, "Enter");
    await sleep(p.submit ? 600 : 100);
    return pageSummary(tab.id, `typed ${p.text.length} characters into ${what}${p.submit ? " and pressed Enter" : ""}`);
  },

  async press(p) {
    const tab = await targetTab(p);
    const s = await attach(tab);
    await overlay(tab.id, { op: "label", label: `Pressing ${p.key}`, at: s.cursor });
    await pressKey(tab.id, p.key);
    await sleep(200);
    return pageSummary(tab.id, `pressed ${p.key}`);
  },

  async scroll(p) {
    const tab = await targetTab(p);
    const s = await attach(tab);
    if (p.ref) {
      const target = await inPage(tab.id, resolveTarget, p.ref, null);
      await moveCursor(tab.id, s, target.x, target.y, `Scrolled to ${describe(target)}`);
      return pageSummary(tab.id, `scrolled ${describe(target)} into view`);
    }
    const view = await inPage(tab.id, viewportInfo);
    const sign = p.direction === "up" ? -1 : 1;
    const x = view.w / 2;
    const y = view.h / 2;
    const deltaY = sign * (p.pages ?? 1) * view.h * 0.85;
    await moveCursor(tab.id, s, x, y, `Scrolling ${p.direction}`);
    if (view.hidden) {
      await inPage(tab.id, scrollPage, deltaY);
    } else {
      // A wheel event scrolls whatever is under the cursor, like a user would.
      await cdp(tab.id, "Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY });
    }
    await sleep(300);
    const after = await inPage(tab.id, viewportInfo);
    return {
      tab: tab.id,
      scroll_y: after.scroll_y,
      page_h: after.page_h,
      summary: `scrolled ${p.direction} to ${after.scroll_y}/${after.page_h - after.h} px`,
    };
  },

  async eval(p) {
    const tab = await targetTab(p);
    await attach(tab);
    const r = await cdp(tab.id, "Runtime.evaluate", {
      expression: p.expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (r.exceptionDetails) {
      fail("js_error", r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    }
    const value = r.result.value === undefined ? null : r.result.value;
    const json = JSON.stringify(value);
    if (json && json.length > 500000) fail("too_large", `result is ${json.length} bytes; return less`);
    return { tab: tab.id, value };
  },

  async console(p) {
    const tab = await targetTab(p);
    const s = await attach(tab);
    const entries = s.console.slice(-(p.limit ?? 100));
    if (p.clear) s.console = [];
    return { tab: tab.id, entries, note: "recorded since molt-browser first attached to this tab" };
  },

  async network(p) {
    const tab = await targetTab(p);
    const s = await attach(tab);
    let entries = [...s.network.values()].map(({ _t0, ...r }) => r);
    if (p.filter) entries = entries.filter((r) => r.url.includes(p.filter));
    entries = entries.slice(-(p.limit ?? 100));
    if (p.clear) s.network.clear();
    return { tab: tab.id, entries };
  },

  async body(p) {
    const tab = await targetTab(p);
    await attach(tab);
    const r = await cdp(tab.id, "Network.getResponseBody", { requestId: p.request_id });
    return { tab: tab.id, ...r };
  },
};

async function groupTab(tab) {
  try {
    const key = `group:${tab.windowId}`;
    const saved = (await chrome.storage.session.get(key))[key];
    const existing = saved != null ? await chrome.tabGroups.get(saved).catch(() => null) : null;
    const groupId = await chrome.tabs.group({ tabIds: [tab.id], ...(existing ? { groupId: existing.id } : { createProperties: { windowId: tab.windowId } }) });
    if (!existing) {
      await chrome.tabGroups.update(groupId, { title: "Molt", color: "purple" });
      await chrome.storage.session.set({ [key]: groupId });
    }
  } catch {
    // Grouping is cosmetic.
  }
}

// ---------------------------------------------------------------------------
// Popup and overlay messages
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.molt === "stop") {
    const tabId = msg.tabId ?? sender.tab?.id;
    if (tabId != null) {
      stopped.add(tabId);
      if (agentTab === tabId) agentTab = null;
      persist();
      detach(tabId).then(() => sendResponse({ ok: true }));
      return true;
    }
  }
  if (msg?.molt === "allow") {
    stopped.delete(msg.tabId);
    persist();
    sendResponse({ ok: true });
  }
  if (msg?.molt === "state") {
    ready.then(() => {
      if (!port) connect();
      sendResponse({
        bridge,
        version: VERSION,
        tab: msg.tabId == null ? null : { controlled: sessions.has(msg.tabId), stopped: stopped.has(msg.tabId) },
      });
    });
    return true;
  }
});
