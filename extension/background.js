// Molt Code browser bridge: service worker.
//
// Molt agents call the molt-browser CLI, which talks to the native messaging
// host over a private unix socket; the host forwards each request here as
// {id, method, params}. Actions go through chrome.debugger (trusted input that
// works in background tabs), page reads go through chrome.scripting in the
// extension's isolated world, and overlay.js draws the agent cursor, the
// glow border and the Stop pill.
//
// Nothing runs without auth: drive methods need a grant signed by the Molt
// backend this browser is paired with (auth.js), and the session a grant
// names is the only owner tab scoping ever sees.

import { AuthError, PROTOCOL, checkOffer, verifyGrant, verifyRevoke } from "./auth.js";

const HOST = "com.moltcode.browser";
const VERSION = chrome.runtime.getManifest().version;
// Debugging attaches on an agent's first action and detaches this long after
// its last one, so Chrome's "debugging this browser" bar only shows while an
// agent is working.
const IDLE_MS = 15 * 1000;
const RING = 500;

let port = null;
let bridge = { connected: false, error: null, hostVersion: null };
let reconnectTimer = null;

// tabId -> { console: [], network: Map, captures: Map, lastCapture, cursor, lastUsed }
const sessions = new Map();
const allowActive = new Map();
// Tabs where the user pressed Stop (or cancelled the debugger bar).
let stopped = new Set();
// Each Molt session keeps its own tab. A single browser-wide default lets one
// agent's `open` silently redirect another agent's next click.
let agentTabs = {};
let tabOwners = {};
// The Molt backend + user this browser answers to (auth.js), and this
// profile's install id, which every grant must name.
let pairing = null;
let installId = null;
// The one pair offer waiting for the user's Allow/Deny in pair.html.
let pending = null;

const ready = Promise.all([
  chrome.storage.session.get(["stopped", "agentTabs", "tabOwners"]).then((saved) => {
    stopped = new Set(saved.stopped || []);
    agentTabs = saved.agentTabs || {};
    tabOwners = saved.tabOwners || {};
  }),
  chrome.storage.local.get(["pairing", "installId"]).then(async (saved) => {
    pairing = saved.pairing || null;
    installId = saved.installId;
    if (!installId) {
      installId = crypto.randomUUID();
      await chrome.storage.local.set({ installId });
    }
  }),
]);

function persist() {
  chrome.storage.session.set({ stopped: [...stopped], agentTabs, tabOwners });
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
  sendHello();
}

// No secrets: the host and `molt-browser status` show which account this
// browser is paired with, so Molt can tell paired, unpaired and mismatched
// apart.
function sendHello() {
  ready.then(() => {
    port?.postMessage({
      type: "hello",
      version: VERSION,
      protocol: PROTOCOL,
      browser: browserName(),
      paired: pairing && { pair_id: pairing.pair_id, kid: pairing.kid, user_id: pairing.user_id, email: pairing.email },
    });
  });
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
  const { id, method, params, grant } = msg;
  let reply;
  try {
    await ready;
    let result;
    if (Object.hasOwn(control, method)) {
      result = await control[method](params || {});
    } else {
      if (!Object.hasOwn(handlers, method)) fail("unknown_method", `unknown method ${method}`);
      const claims = await verifyGrant(grant, pairing);
      // Tab ownership comes from the signed session, never from params.
      result = await handlers[method]({ ...(params || {}), session: claims.session_id });
    }
    reply = { id, ok: true, result };
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
  const owner = params.session;
  let tab;
  if (params.tab != null) {
    tab = await chrome.tabs.get(params.tab).catch(() => null);
    if (!tab) fail("no_tab", `tab ${params.tab} does not exist (molt-browser tabs lists them)`);
  } else if (agentTabs[owner] != null) {
    tab = await chrome.tabs.get(agentTabs[owner]).catch(() => null);
    if (!tab) {
      delete agentTabs[owner];
      persist();
    }
  }
  if (!tab) fail("no_agent_tab", "open a background tab first, or pass --tab ID explicitly (molt-browser tabs lists them)");
  if (tabOwners[tab.id] && tabOwners[tab.id] !== owner) {
    fail("tab_in_use", `tab ${tab.id} belongs to another agent session; open your own tab`);
  }
  if (!params.allow_active) await assertBackground(tab.id);
  allowActive.set(tab.id, !!params.allow_active);
  if (agentTabs[owner] !== tab.id || tabOwners[tab.id] !== owner) {
    agentTabs[owner] = tab.id;
    tabOwners[tab.id] = owner;
    persist();
  }
  return tab;
}

async function assertBackground(tabId) {
  const [front] = await chrome.tabs.query({ active: true, lastFocusedWindow: true, windowType: "normal" });
  if (front?.id === tabId) {
    fail("active_tab", `tab ${tabId} is the user's foreground tab. Work in a background tab, or pass --allow-active only when the user asked to share it.`);
  }
}

function forgetTab(tabId) {
  allowActive.delete(tabId);
  let changed = tabOwners[tabId] != null;
  delete tabOwners[tabId];
  for (const [session, id] of Object.entries(agentTabs)) {
    if (id === tabId) {
      delete agentTabs[session];
      changed = true;
    }
  }
  if (changed) persist();
}

async function guardInput(tabId) {
  checkAllowed({ id: tabId, url: "" });
  if (!allowActive.get(tabId)) await assertBackground(tabId);
}

function checkAllowed(tab) {
  if (stopped.has(tab.id)) {
    fail(
      "stopped_by_user",
      `The user pressed Stop on tab ${tab.id}. Ask them before using it again; they can re-allow it from the Molt toolbar button.`
    );
  }
  const url = tab.url || tab.pendingUrl || "";
  if (/^(chrome|edge|brave|about|devtools|chrome-extension|view-source):/.test(url) || url.startsWith("https://chromewebstore.google.com") || url.startsWith("https://chrome.google.com/webstore")) {
    fail("restricted_page", `Chrome does not let any extension control ${url}. Ask the user to do this page by hand.`);
  }
}

async function cdp(tabId, method, params = {}) {
  try {
    return await chrome.debugger.sendCommand({ tabId }, method, params);
  } catch (e) {
    // An input event that lands while a browser popup (autofill, a native
    // picker) is closing loses its ack: the popup widget goes away mid-way.
    // The event itself was delivered, so carry on.
    if (method.startsWith("Input.") && /Detached while handling command/i.test(e.message)) {
      await sleep(100);
      return {};
    }
    // ...and then Chrome can drop the debugger from the tab. Attach again
    // and retry the command once.
    if (/not attached/i.test(e.message) && sessions.has(tabId)) {
      try {
        await reattach(tabId);
        return await chrome.debugger.sendCommand({ tabId }, method, params);
      } catch (retry) {
        fail("cdp_error", `${method}: ${retry.message}`);
      }
    }
    fail("cdp_error", `${method}: ${e.message}`);
  }
}

async function attach(tab) {
  checkAllowed(tab);
  await guardInput(tab.id);
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
    await keepAlive(tab.id);
  }
  session.lastUsed = Date.now();
  await overlay(tab.id, { op: "show" });
  return session;
}

// Agents work in tabs the user isn't looking at, without switching to them.
// A hidden tab has no focus (typed text is dropped) and runs no animation
// frames. Focus emulation fixes both: Chrome treats the tab as focused and
// keeps it rendering while the debugger is attached.
async function keepAlive(tabId) {
  await cdp(tabId, "Emulation.setFocusEmulationEnabled", { enabled: true });
}

async function detach(tabId) {
  if (!sessions.has(tabId)) return false;
  sessions.delete(tabId);
  allowActive.delete(tabId);
  await chrome.debugger.detach({ tabId }).catch(() => {});
  await overlay(tabId, { op: "hide" }, { inject: false });
  return true;
}

// Detach idle tabs so Chrome's "is debugging this browser" bar goes away.
setInterval(() => {
  const now = Date.now();
  for (const [tabId, s] of sessions) if (now - s.lastUsed > IDLE_MS) detach(tabId);
}, 3000);

chrome.debugger.onDetach.addListener(({ tabId }, reason) => {
  if (!sessions.has(tabId)) return;
  // Only the user's Cancel on Chrome's debugging bar ends the session; other
  // detaches (closing popups, crashes) are re-attached on the next command.
  if (reason !== "canceled_by_user") return;
  sessions.delete(tabId);
  overlay(tabId, { op: "hide" }, { inject: false });
  stopped.add(tabId);
  persist();
});

async function reattach(tabId) {
  // Chrome can report the tab as still attached after dropping it; start
  // clean.
  await chrome.debugger.detach({ tabId }).catch(() => {});
  await chrome.debugger.attach({ tabId }, "1.3");
  await Promise.all(
    ["Runtime.enable", "Log.enable", "Network.enable", "Page.enable"].map((m) => chrome.debugger.sendCommand({ tabId }, m).catch(() => {}))
  );
  await keepAlive(tabId).catch(() => {});
}

chrome.tabs.onRemoved.addListener((tabId) => {
  if (pending?.tabId === tabId) settlePending(new AuthError("pair_denied", "the pair request was closed in Chrome"));
  sessions.delete(tabId);
  if (stopped.delete(tabId)) persist();
  forgetTab(tabId);
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

// Calls window.__molt.<name>(...args) from lib.js in the page's isolated
// world, injecting lib.js first (a no-op when it's already there).
async function inPage(tabId, name, ...args) {
  if (["target", "field", "findOption", "selectOption", "selectContents", "markFileInput", "scrollBy"].includes(name)) {
    await guardInput(tabId);
  }
  let results;
  try {
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ["lib.js"] });
    results = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      func: (n, a) => window.__molt[n](...a),
      args: [name, args],
    });
  } catch (e) {
    fail("script_failed", e.message);
  }
  const value = results?.[0]?.result;
  if (value?.error) fail(value.error, value.message);
  return value;
}

// A target from CLI params: a ref, a visible name, or css=<selector>.
function specOf(p) {
  return p.target ?? p.ref ?? (p.selector ? `css=${p.selector}` : null);
}

// Actions answer with the page as it is afterwards, so an agent rarely needs
// a separate snapshot call.
async function withPage(tabId, result, p) {
  if (p.page === false) return result;
  try {
    const snap = await inPage(tabId, "snapshot", { limit: 80 });
    return { ...result, page: snap };
  } catch {
    return result;
  }
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
  await guardInput(tab.id);
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
  await guardInput(tabId);
  const ev = keyEvent(spec);
  const base = { key: ev.key, code: ev.code, windowsVirtualKeyCode: ev.keyCode, modifiers: ev.modifiers };
  await cdp(tabId, "Input.dispatchKeyEvent", { type: ev.text ? "keyDown" : "rawKeyDown", ...base, text: ev.text, unmodifiedText: ev.text });
  await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...base });
}

async function mouseClick(tabId, x, y) {
  await guardInput(tabId);
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
    case "Page.fileChooserOpened":
      s.onFileChooser?.(params);
      break;
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

// Methods that run without a grant. None of them touches a page.
const control = {
  // Picks up a new build of the unpacked extension without a trip to
  // chrome://extensions. The bridge reconnects on its own.
  async reload_extension() {
    setTimeout(() => chrome.runtime.reload(), 100);
    return { summary: "extension reloading; it reconnects in a few seconds" };
  },

  // Molt asks to pair. The answer waits for the user's Allow in pair.html,
  // next to the same code the desktop shows.
  async pair_offer(params) {
    const offer = checkOffer(params);
    settlePending(new AuthError("pair_superseded", "a newer pair request replaced this one"));
    const ms = offer.expires_at * 1000 - Date.now();
    const answer = new Promise((resolve, reject) => {
      pending = { offer, resolve, reject, timer: setTimeout(() => settlePending(new AuthError("pair_expired", "nobody answered the pair request in Chrome")), ms) };
    });
    const tab = await chrome.tabs.create({ url: chrome.runtime.getURL("pair.html"), active: true });
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    pending.tabId = tab.id;
    return answer;
  },

  // Molt signed out or switched accounts.
  async unpair(params) {
    if (!pairing) return { unpaired: false, summary: "not paired" };
    await verifyRevoke(params.token, pairing);
    await clearPairing();
    return { unpaired: true, summary: "pairing removed" };
  },
};

function settlePending(error, value) {
  if (!pending) return;
  const p = pending;
  pending = null;
  clearTimeout(p.timer);
  if (p.tabId != null) chrome.tabs.remove(p.tabId).catch(() => {});
  if (error) p.reject(error);
  else p.resolve(value);
}

async function acceptPending() {
  const { offer } = pending;
  pairing = {
    pair_id: offer.pair_id,
    kid: offer.kid,
    public_key: offer.public_key,
    user_id: offer.user_id,
    email: offer.email,
    machine_id: offer.machine_id,
    machine_name: offer.machine_name,
    browser_install_id: installId,
    paired_at: Date.now(),
  };
  await chrome.storage.local.set({ pairing });
  sendHello();
  settlePending(null, { accepted: true, pair_id: offer.pair_id, nonce: offer.nonce, browser_install_id: installId });
}

async function clearPairing() {
  pairing = null;
  await chrome.storage.local.remove("pairing");
  for (const tabId of [...sessions.keys()]) await detach(tabId);
  sendHello();
}

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
        agent: tabOwners[t.id] != null,
        controlled: sessions.has(t.id),
        stopped: stopped.has(t.id),
        url: t.url,
        title: t.title,
      })),
    };
  },

  async open({ url, focus, session }) {
    const [current] = await chrome.tabs.query({ active: true, lastFocusedWindow: true, windowType: "normal" });
    const tab = await chrome.tabs.create({ url, active: !!focus, windowId: current?.windowId });
    const loaded = waitForLoad(tab.id);
    agentTabs[session] = tab.id;
    tabOwners[tab.id] = session;
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
    const tab = await targetTab({ ...p, allow_active: true });
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    return pageSummary(tab.id, "focused");
  },

  async release(p) {
    const tab = await targetTab({ ...p, allow_active: true });
    const was = await detach(tab.id);
    forgetTab(tab.id);
    return { tab: tab.id, summary: was ? `released tab ${tab.id}` : `tab ${tab.id} was not under control` };
  },

  async snapshot(p) {
    const tab = await targetTab(p);
    await attach(tab);
    const snap = await inPage(tab.id, "snapshot", { limit: p.limit ?? 150, offset: p.offset ?? 0, all: !!p.all });
    return { tab: tab.id, ...snap };
  },

  async text(p) {
    const tab = await targetTab(p);
    checkAllowed(tab);
    return inPage(tab.id, "text", p.max ?? 20000);
  },

  async screenshot(p) {
    const tab = await targetTab(p);
    const s = await attach(tab);
    const view = await inPage(tab.id, "viewport");
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
      const now = await inPage(tab.id, "viewport");
      if (now.scroll_x !== cap.scroll_x || now.scroll_y !== cap.scroll_y || now.url !== cap.url) {
        fail("stale_capture", "the page scrolled or navigated since that screenshot; take a new one");
      }
      x = p.x / cap.dpr;
      y = p.y / cap.dpr;
      what = `point (${Math.round(p.x)},${Math.round(p.y)})`;
    } else {
      const target = await inPage(tab.id, "target", specOf(p));
      ({ x, y } = target);
      what = describe(target);
      if (target.obscured_by) what += ` (covered by ${target.obscured_by})`;
    }
    await clickAt(tab.id, s, x, y, `Clicking ${what}`);
    await sleep(400);
    return withPage(tab.id, await pageSummary(tab.id, `clicked ${what}`), p);
  },

  async type(p) {
    const tab = await targetTab(p);
    const s = await attach(tab);
    let what = "the focused element";
    const spec = specOf(p);
    if (spec) {
      const target = await inPage(tab.id, "target", spec);
      what = describe(target);
      await clickAt(tab.id, s, target.x, target.y, `Typing into ${what}`, { pulse: false });
    }
    if (p.clear) await inPage(tab.id, "selectContents");
    // One insertText for the whole string: long text lands at once.
    await guardInput(tab.id);
    if (p.text) await cdp(tab.id, "Input.insertText", { text: p.text });
    if (p.submit) await pressKey(tab.id, "Enter");
    await sleep(p.submit ? 600 : 100);
    return withPage(tab.id, await pageSummary(tab.id, `typed ${p.text.length} characters into ${what}${p.submit ? " and pressed Enter" : ""}`), p);
  },

  // Fills a whole form in one call: [{target, value}, ...]. Text fields get
  // their contents replaced, selects and custom dropdowns pick the option,
  // checkboxes are set to true/false, file fields get the file paths.
  async fill(p) {
    const tab = await targetTab(p);
    const s = await attach(tab);
    const done = [];
    for (const { target, value, files } of p.fields || []) {
      try {
        done.push(files ? await uploadFiles(tab.id, s, target, files) : await fillField(tab.id, s, target, value));
      } catch (e) {
        e.message = `${target}: ${e.message}${done.length ? ` (already set: ${done.join("; ")})` : ""}`;
        throw e;
      }
    }
    if (p.submit) {
      await pressKey(tab.id, "Enter");
      await sleep(600);
    }
    return withPage(tab.id, await pageSummary(tab.id, `filled ${done.length} field(s): ${done.join("; ")}${p.submit ? "; pressed Enter" : ""}`), p);
  },

  async select(p) {
    const tab = await targetTab(p);
    const s = await attach(tab);
    const what = await chooseOption(tab.id, s, specOf(p), p.option);
    return withPage(tab.id, await pageSummary(tab.id, what), p);
  },

  async press(p) {
    const tab = await targetTab(p);
    const s = await attach(tab);
    await overlay(tab.id, { op: "label", label: `Pressing ${p.key}`, at: s.cursor });
    await pressKey(tab.id, p.key);
    await sleep(200);
    return withPage(tab.id, await pageSummary(tab.id, `pressed ${p.key}`), p);
  },

  async scroll(p) {
    const tab = await targetTab(p);
    const s = await attach(tab);
    const spec = specOf(p);
    if (spec) {
      const target = await inPage(tab.id, "target", spec);
      await moveCursor(tab.id, s, target.x, target.y, `Scrolled to ${describe(target)}`);
      return withPage(tab.id, await pageSummary(tab.id, `scrolled ${describe(target)} into view`), p);
    }
    const view = await inPage(tab.id, "viewport");
    const sign = p.direction === "up" ? -1 : 1;
    const x = view.w / 2;
    const y = view.h / 2;
    const deltaY = sign * (p.pages ?? 1) * view.h * 0.85;
    await moveCursor(tab.id, s, x, y, `Scrolling ${p.direction}`);
    await guardInput(tab.id);
    if (view.hidden) {
      // Chrome holds synthetic wheel events for tabs that aren't painting.
      await inPage(tab.id, "scrollBy", deltaY);
    } else {
      // A wheel event scrolls whatever is under the cursor, like a user would.
      await cdp(tab.id, "Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY });
    }
    await sleep(300);
    const after = await inPage(tab.id, "viewport");
    return withPage(
      tab.id,
      { tab: tab.id, scroll_y: after.scroll_y, page_h: after.page_h, summary: `scrolled ${p.direction} to ${after.scroll_y}/${after.page_h - after.h} px` },
      p
    );
  },

  async eval(p) {
    const tab = await targetTab(p);
    await guardInput(tab.id);
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
    return { tab: tab.id, entries, note: "recorded while molt-browser is attached to this tab" };
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

  // Gives a page files without the OS file picker: straight onto the file
  // input when there is one, otherwise by clicking the target with Chrome's
  // file chooser intercepted.
  async upload(p) {
    const tab = await targetTab(p);
    const s = await attach(tab);
    const what = await uploadFiles(tab.id, s, specOf(p), p.files);
    return withPage(tab.id, await pageSummary(tab.id, what), p);
  },
};

async function clickAt(tabId, s, x, y, label, { pulse = true } = {}) {
  await guardInput(tabId);
  await moveCursor(tabId, s, x, y, label);
  await mouseClick(tabId, x, y);
  if (pulse) await overlay(tabId, { op: "pulse" });
}

async function fillField(tabId, s, target, value) {
  const f = await inPage(tabId, "field", target);
  const what = describe(f);
  switch (f.kind) {
    case "select":
    case "choose":
      return chooseOption(tabId, s, target, value);
    case "check": {
      const want = /^(true|on|yes|1|checked)$/i.test(String(value));
      if (want !== f.checked) await clickAt(tabId, s, f.x, f.y, `${want ? "Checking" : "Unchecking"} ${what}`);
      return `${what} ${want ? "checked" : "unchecked"}`;
    }
    case "file":
      return uploadFiles(tabId, s, target, [].concat(value));
    case "text":
      await clickAt(tabId, s, f.x, f.y, `Filling ${what}`, { pulse: false });
      await inPage(tabId, "selectContents");
      await guardInput(tabId);
      await cdp(tabId, "Input.insertText", { text: String(value) });
      // Let the page settle (autofill popups, input handlers) before the
      // next field's click.
      await sleep(250);
      return `${what} = ${String(value).length} chars`;
    default:
      fail("not_fillable", `${what} is not a form field; use click`);
  }
}

// Native <select> is set directly; custom dropdowns are clicked open and the
// option clicked, like a user would.
async function chooseOption(tabId, s, target, option) {
  const f = await inPage(tabId, "field", target);
  const what = describe(f);
  if (f.kind === "select") {
    await guardInput(tabId);
    await moveCursor(tabId, s, f.x, f.y, `Choosing ${option}`);
    const r = await inPage(tabId, "selectOption", target, option);
    return `${what} set to "${r.chosen}"`;
  }
  await clickAt(tabId, s, f.x, f.y, `Opening ${what}`);
  let opt;
  for (let i = 0; i < 15; i++) {
    await sleep(150);
    try {
      opt = await inPage(tabId, "findOption", option);
      break;
    } catch (e) {
      if (i === 14) throw e;
    }
  }
  await clickAt(tabId, s, opt.x, opt.y, `Choosing ${opt.name}`);
  await sleep(200);
  return `${what} set to "${opt.name}"`;
}

async function uploadFiles(tabId, s, target, files) {
  await guardInput(tabId);
  const mark = `u${Date.now().toString(36)}`;
  const marked = await inPage(tabId, "markFileInput", target, mark);
  if (marked.ok) {
    const found = await cdp(tabId, "Runtime.evaluate", { expression: `document.querySelector('[data-molt-upload="${mark}"]')` });
    if (!found.result?.objectId) fail("not_found", "could not reach the file input from the page");
    await guardInput(tabId);
    await cdp(tabId, "DOM.setFileInputFiles", { files, objectId: found.result.objectId });
    await sleep(300);
    return `attached ${files.length} file(s)`;
  }
  if (!target) fail("not_found", "no single file input on the page; pass the upload button or field as the target");
  // No input to reach: click the control with the chooser intercepted, and
  // hand the files to whatever input the page opens it for.
  const t = await inPage(tabId, "target", target);
  await cdp(tabId, "Page.setInterceptFileChooserDialog", { enabled: true });
  try {
    const opened = new Promise((resolve) => (s.onFileChooser = resolve));
    await clickAt(tabId, s, t.x, t.y, `Uploading via ${describe(t)}`);
    const chooser = await withTimeout(opened, 5000, "no_file_chooser", `clicking ${describe(t)} did not open a file chooser`);
    await guardInput(tabId);
    await cdp(tabId, "DOM.setFileInputFiles", { files, backendNodeId: chooser.backendNodeId });
  } finally {
    s.onFileChooser = null;
    await cdp(tabId, "Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => {});
  }
  await sleep(300);
  return `attached ${files.length} file(s) via ${describe(t)}`;
}

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

// Pairing decisions only count from the extension's own pages; content
// scripts report the page's URL here.
const fromExtensionPage = (sender, page) => sender.id === chrome.runtime.id && sender.url?.startsWith(chrome.runtime.getURL(page));

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.molt === "pair_state" && fromExtensionPage(sender, "pair.html")) {
    ready.then(() => {
      const o = pending?.offer;
      sendResponse({
        offer: o && { pair_id: o.pair_id, code: o.code, email: o.email, machine_name: o.machine_name, expires_at: o.expires_at },
        replaces: pairing && { email: pairing.email, machine_name: pairing.machine_name },
      });
    });
    return true;
  }
  if (msg?.molt === "pair_decision" && fromExtensionPage(sender, "pair.html")) {
    if (!pending || pending.offer.pair_id !== msg.pair_id) {
      sendResponse({ ok: false, error: "this pair request is no longer active" });
      return;
    }
    if (msg.allow) acceptPending().then(() => sendResponse({ ok: true }));
    else {
      settlePending(new AuthError("pair_denied", "the user declined pairing in Chrome"));
      sendResponse({ ok: true });
    }
    return true;
  }
  if (msg?.molt === "unpair" && fromExtensionPage(sender, "popup.html")) {
    clearPairing().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg?.molt === "stop") {
    const tabId = msg.tabId ?? sender.tab?.id;
    if (tabId != null) {
      stopped.add(tabId);
      forgetTab(tabId);
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
        pairing: pairing && { email: pairing.email, machine_name: pairing.machine_name, paired_at: pairing.paired_at },
        tab: msg.tabId == null ? null : { controlled: sessions.has(msg.tabId), stopped: stopped.has(msg.tabId) },
      });
    });
    return true;
  }
});
