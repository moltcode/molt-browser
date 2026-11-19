// Fakes of the chrome.* APIs the service worker and the popup touch, enough
// to load the real extension/background.js and extension/popup.js in Node and
// drive them by their own messages: the native host's port, the popup's
// runtime messages, storage and fetch.
import { readFile } from "node:fs/promises";

function events() {
  const fns = [];
  return { fns, addListener: (f) => fns.push(f), removeListener: (f) => fns.splice(fns.indexOf(f) >>> 0, 1) };
}

function area(data) {
  return {
    data,
    async get(keys) {
      const out = {};
      for (const k of keys == null ? Object.keys(data) : [].concat(keys)) if (Object.hasOwn(data, k)) out[k] = structuredClone(data[k]);
      return out;
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) data[k] = structuredClone(v);
    },
    async remove(keys) {
      for (const k of [].concat(keys)) delete data[k];
    },
  };
}

// The native host's end of chrome.runtime.connectNative.
function hostPort() {
  const sent = [];
  const waiters = [];
  const port = {
    sent,
    onMessage: events(),
    onDisconnect: events(),
    postMessage(msg) {
      sent.push(msg);
      for (const w of [...waiters]) {
        if (w.match(msg)) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve(msg);
        }
      }
    },
    // The host sends the extension a message.
    deliver(msg) {
      for (const f of port.onMessage.fns) f(msg);
    },
    // The first message the extension posted that matches, now or later.
    next(match) {
      const seen = sent.find(match);
      return seen ? Promise.resolve(seen) : new Promise((resolve) => waiters.push({ match, resolve }));
    },
  };
  return port;
}

const EXT = "molt-test-extension";

// IndexedDB with what molt-auth.js's store uses: one database, one object
// store, get/put/delete. Values are kept as they are (CryptoKeys included).
export function fakeIndexedDB() {
  const dbs = new Map();
  return {
    dbs,
    open(name) {
      const req = {};
      setImmediate(() => {
        const fresh = !dbs.has(name);
        if (fresh) dbs.set(name, new Map());
        const stores = dbs.get(name);
        req.result = {
          createObjectStore: (n) => stores.set(n, new Map()),
          transaction(n) {
            const data = stores.get(n);
            const t = {
              objectStore: () => ({
                get: (k) => ({ result: data.get(k) }),
                put: (v, k) => (data.set(k, v), {}),
                delete: (k) => (data.delete(k), {}),
              }),
            };
            setImmediate(() => t.oncomplete?.());
            return t;
          },
        };
        if (fresh) req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req;
    },
  };
}

export function fakeChrome({ local = {}, session = {}, idb = fakeIndexedDB() } = {}) {
  const ports = [];
  const opened = [];
  const chrome = {
    runtime: {
      id: EXT,
      lastError: undefined,
      getManifest: () => ({ version: "0.4.2" }),
      getURL: (path) => `chrome-extension://${EXT}/${path}`,
      connectNative() {
        const port = hostPort();
        ports.push(port);
        return port;
      },
      onMessage: events(),
      onStartup: events(),
      onInstalled: events(),
      onUpdateAvailable: events(),
      reload() {},
      async requestUpdateCheck() {
        return { status: "no_update" };
      },
    },
    management: { getSelf: async () => ({ installType: "normal" }) },
    storage: { local: area(local), session: area(session), onChanged: events() },
    alarms: { create() {}, onAlarm: events() },
    action: { setBadgeText() {}, setTitle() {}, setBadgeBackgroundColor() {}, setBadgeTextColor() {} },
    tabs: {
      query: async () => [],
      get: async () => null,
      create: async ({ url }) => (opened.push({ url }), { id: 100 + opened.length }),
      update: async (id, { url }) => (opened.push({ id, url }), { id }),
      onRemoved: events(),
      onUpdated: events(),
    },
    debugger: { detach: async () => {}, onDetach: events(), onEvent: events() },
  };
  return {
    chrome,
    idb,
    // Tabs the extension opened or navigated: { url, id? }.
    opened,
    local: chrome.storage.local.data,
    session: chrome.storage.session.data,
    // The native host the service worker connected to at load.
    get port() {
      return ports.at(-1);
    },
    // A message from one of the extension's own pages, answered by the
    // service worker's sendResponse.
    send(msg, page = "popup.html", tab = null) {
      return new Promise((resolve) => {
        const sender = { id: EXT, url: chrome.runtime.getURL(page), tab };
        for (const f of chrome.runtime.onMessage.fns) f(msg, sender, resolve);
      });
    },
  };
}

// Swaps globals in for one test; the returned function puts them back.
function withGlobals(globals) {
  const saved = Object.entries(globals).map(([k]) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]);
  for (const [k, v] of Object.entries(globals)) Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  return () => {
    for (const [k, d] of saved) {
      if (d) Object.defineProperty(globalThis, k, d);
      else delete globalThis[k];
    }
  };
}

let loads = 0;

// Loads a fresh copy of the service worker against `fake`, with `fetch` as
// the platform. Its periodic timers are created stopped: tests wait on the
// messages it posts, never on the clock.
export async function loadServiceWorker(t, fake, fetch) {
  const restore = withGlobals({ chrome: fake.chrome, fetch, indexedDB: fake.idb });
  t.after(restore);
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = () => 0;
  try {
    await import(new URL(`../extension/background.js?load=${++loads}`, import.meta.url));
  } finally {
    globalThis.setInterval = realSetInterval;
  }
  return fake;
}

// A DOM with just what popup.js uses: elements by id, created on first use,
// hidden as popup.html's boxes and buttons start.
export function fakeDocument() {
  const els = new Map();
  const make = (tag) => ({
    tag,
    hidden: true,
    className: "",
    textContent: "",
    innerHTML: "",
    disabled: false,
    checked: false,
    append(...nodes) {
      this.textContent += nodes.map((n) => (typeof n === "string" ? n : n.textContent)).join("");
    },
  });
  return {
    els,
    getElementById(id) {
      if (!els.has(id)) els.set(id, make("div"));
      return els.get(id);
    },
    createElement: make,
  };
}

// Runs popup.js (a classic script) once against `state`, the service
// worker's answer to {molt: "state"}, and resolves when it has drawn.
export async function renderPopup(state) {
  const document = fakeDocument();
  const sent = [];
  const chrome = {
    tabs: { query: async () => [{ id: 1 }] },
    runtime: {
      async sendMessage(msg) {
        sent.push(msg);
        return msg.molt === "state" ? structuredClone(state) : { ok: true };
      },
    },
    storage: { local: { set: async () => {} } },
  };
  const source = await readFile(new URL("../extension/popup.js", import.meta.url), "utf8");
  // No periodic re-render: one draw per state.
  new Function("chrome", "document", "setInterval", source)(chrome, document, () => 0);
  // Both of render's awaits answer at once; a macrotask turn sees it done.
  await new Promise((resolve) => setImmediate(resolve));
  const el = (id) => document.getElementById(id);
  return { el, sent, visible: (id) => !el(id).hidden };
}
