// This browser's own device at the Molt key service (molt_auth; Settled S3,
// S17, S21 to S23, S86, S98, S220): the extension's port of molt-web's
// sealedAuth/{device,session}.ts, cut to what the extension needs.
//
// Dormant: nothing here runs unless the platform answered the extension's
// sign-in with 403 `auth_required` (the account holds an auth session: one
// of its workspaces is sealing or sealed), or this browser already signed in
// at auth. An account with no sealed workspace never reaches this file's
// network calls.
//
// The device: an Ed25519 key that signs every request (`molt-proof`) and an
// X25519 key auth wraps answers to, both non-extractable CryptoKeys kept in
// IndexedDB, so their private halves never exist as bytes in script. A
// sign-in (S23) opens auth's page in a tab after checking its nonce names
// this key, and polls; its session wrap (S22) is opened only to learn the
// user, the device id and the session id. The session's tokens are dropped
// at once: the extension token (`POST /v1/browser/extension-token`, 30 days,
// `molt-browser`) needs only an active device, so nothing that renews a
// session is ever kept here.
//
// Every answer is read with a 256 KiB cap; no token or key goes in a log, an
// error or a URL.

export const ANSWER_CAP = 256 * 1024;
// The key service this build signs in at. `make dist` writes both from the
// apps.env MOLT_APPS_ENV names (scripts/apps-env.mjs) and refuses without
// one; the source tree has none, so an unpacked copy says so and never calls
// one. A local stack sets `authUrl` and `authKeys` in chrome.storage.local,
// as `platformUrl`.
export const AUTH_URL = null;
export const AUTH_KEYS = "";
// The extension token lives 30 days; a new one is asked this long before.
export const RENEW_BEFORE = 3 * 86_400;
export const EXTENSION_TYP = "molt-browser";
const REQUEST_MS = 15_000;
const EXTENSION_TTL = 30 * 86_400;
const CLOCK_SKEW = 60;

export class MoltAuthError extends Error {
  constructor(code, message, status = 0) {
    super(message || code);
    this.code = code;
    this.status = status;
  }
}

const fail = (code, message, status) => {
  throw new MoltAuthError(code, message, status);
};

const subtle = () => globalThis.crypto.subtle;
const utf8 = (text) => new TextEncoder().encode(text);
const nowS = () => Math.floor(Date.now() / 1000);

export function concat(...parts) {
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function b64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function unb64url(text) {
  if (typeof text !== "string" || !/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) throw new Error("not base64url");
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

const sha256 = async (bytes) => new Uint8Array(await subtle().digest("SHA-256", bytes));

// -- Config --------------------------------------------------------------------

/** `kid:x,kid:x` or a JWKS document; a key that is not 32 bytes is dropped. */
export function parseAuthKeys(text) {
  const keys = {};
  if (typeof text !== "string" || !text.trim()) return keys;
  let pairs = [];
  try {
    const doc = JSON.parse(text.trim());
    if (Array.isArray(doc?.keys)) pairs = doc.keys.flatMap((k) => (typeof k?.kid === "string" && typeof k?.x === "string" ? [[k.kid, k.x]] : []));
  } catch {
    pairs = text.split(",").flatMap((pair) => {
      const at = pair.indexOf(":");
      return at > 0 ? [[pair.slice(0, at).trim(), pair.slice(at + 1).trim()]] : [];
    });
  }
  for (const [kid, x] of pairs) {
    try {
      const key = unb64url(x);
      if (kid && key.length === 32) keys[kid] = key;
    } catch {
      // not base64url: dropped
    }
  }
  return keys;
}

const LOOPBACK = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;

/**
 * The key service: `{base, keys, providers}`, or null when this build has
 * none (no URL, or no usable pinned key). A packaged build (`make dist`,
 * scripts/apps-env.mjs) carries its edge and pins and takes only those:
 * `saved`, chrome.storage.local's `authUrl` and `authKeys`, is a local
 * stack's override and is read only by a build that carries none
 * (Morpheus's re-review: a page or a person who could write local storage
 * must never repoint a release at another edge or pins). `built` is the
 * build's own pair; tests pass one.
 */
export function authConfig(saved = {}, built = { url: AUTH_URL, keys: AUTH_KEYS }) {
  const own = typeof built?.url === "string" && built.url !== "";
  const base = own ? built.url : typeof saved.authUrl === "string" ? saved.authUrl : "";
  const keys = parseAuthKeys(own ? built.keys : typeof saved.authKeys === "string" ? saved.authKeys : "");
  if (!base || !/^https?:\/\//.test(base) || Object.keys(keys).length === 0) return null;
  const clean = base.replace(/\/+$/, "");
  return { base: clean, keys, providers: LOOPBACK.test(clean) ? ["dev", "google"] : ["google", "apple"] };
}

// -- The device ----------------------------------------------------------------

/** IndexedDB, one object store; CryptoKeys are kept as they are (structured clone). */
export function idbStore(name = "molt-auth") {
  let db = null;
  const open = () =>
    (db ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(name, 1);
      req.onupgradeneeded = () => req.result.createObjectStore("kv");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
  const run = async (mode, fn) => {
    const d = await open();
    return new Promise((resolve, reject) => {
      const t = d.transaction("kv", mode);
      const req = fn(t.objectStore("kv"));
      t.oncomplete = () => resolve(req?.result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  };
  return {
    get: (k) => run("readonly", (s) => s.get(k)),
    set: (k, v) => run("readwrite", (s) => s.put(v, k)),
    delete: (k) => run("readwrite", (s) => s.delete(k)),
  };
}

const DEVICE = "device";

async function rawPublic(key) {
  return new Uint8Array(await subtle().exportKey("raw", key));
}

/** RFC 7638 thumbprint of an Ed25519 public key. */
export async function jwkThumbprint(publicKey) {
  return b64url(await sha256(utf8(`{"crv":"Ed25519","kty":"OKP","x":"${b64url(publicKey)}"}`)));
}

function usable(d) {
  const pair = (p) => !!p && typeof p === "object" && "privateKey" in p && "publicKey" in p;
  return !!d && pair(d.sig) && pair(d.enc);
}

async function fromStored(stored) {
  const sigPublic = await rawPublic(stored.sig.publicKey);
  return {
    sig: { privateKey: stored.sig.privateKey, publicKey: sigPublic },
    enc: { privateKey: stored.enc.privateKey, publicKey: await rawPublic(stored.enc.publicKey) },
    jkt: await jwkThumbprint(sigPublic),
    did: typeof stored.did === "string" ? stored.did : null,
  };
}

async function generate() {
  const sig = await subtle().generateKey({ name: "Ed25519" }, false, ["sign", "verify"]);
  const enc = await subtle().generateKey({ name: "X25519" }, false, ["deriveBits"]);
  return { sig, enc, did: null };
}

/** The device, made once when there is none. */
export async function ensureDevice(store) {
  const stored = await store.get(DEVICE);
  if (usable(stored)) return fromStored(stored);
  const made = await generate();
  await store.set(DEVICE, made);
  return fromStored(made);
}

/** S30: a key auth will not admit again is replaced; the next sign-in is a new device. */
export async function retireDevice(store) {
  const made = await generate();
  await store.set(DEVICE, made);
  return fromStored(made);
}

/** Keeps auth's id for the device (null: forget it, as at sign-out). */
export async function saveDid(store, did) {
  const stored = await store.get(DEVICE);
  if (usable(stored) && stored.did !== did) await store.set(DEVICE, { ...stored, did });
}

export function deviceKeys(device) {
  return {
    sig: { kty: "OKP", crv: "Ed25519", x: b64url(device.sig.publicKey), kid: null, use: "sig", alg: "EdDSA" },
    enc: { kty: "OKP", crv: "X25519", x: b64url(device.enc.publicKey), kid: null, use: "enc", alg: null },
  };
}

// -- Proofs (S17, S21) -----------------------------------------------------------

/** JSON with keys sorted and null or undefined members left out, as molt_auth writes device claims. */
export function sortedJson(claims) {
  const out = {};
  for (const k of Object.keys(claims).sort()) if (claims[k] !== undefined && claims[k] !== null) out[k] = claims[k];
  return JSON.stringify(out);
}

/** The `molt-proof` header: method, URL, time, jti, `did` (absent at a sign-in's start and polls) and `bh`. */
export async function deviceProof(device, { did, htm, htu, iat, jti }, body) {
  const header = `{"alg":"EdDSA","jwk":{"crv":"Ed25519","kty":"OKP","x":"${b64url(device.sig.publicKey)}"},"typ":"molt-proof"}`;
  const claims = { did, htm, htu, iat, jti, bh: b64url(await sha256(body)) };
  const input = `${b64url(utf8(header))}.${b64url(utf8(sortedJson(claims)))}`;
  const sig = new Uint8Array(await subtle().sign({ name: "Ed25519" }, device.sig.privateKey, utf8(input)));
  return `${input}.${b64url(sig)}`;
}

/** S23: the nonce a sign-in's `authorize_url` must carry for this device's key. */
export async function signInNonce(jkt, signInId) {
  return b64url(await sha256(concat(utf8(jkt), new Uint8Array([0]), utf8(signInId))));
}

// -- Wraps (mxw1, S22) -------------------------------------------------------------

/** "mxw1", purpose, jkt, jti, ref: each as a u16 big-endian length and its bytes. */
export function wrapBinding({ purpose, jkt, jti, ref }) {
  const parts = [];
  for (const field of ["mxw1", purpose, jkt, jti, ref]) {
    const bytes = utf8(field);
    parts.push(new Uint8Array([bytes.length >> 8, bytes.length & 0xff]), bytes);
  }
  return concat(...parts);
}

const wrapSigned = (aad, epk, c) => concat(utf8("molt mxw1 sig"), new Uint8Array([0]), aad, epk, c);

/**
 * Opens a wrap auth made for this device: its purpose and ref must be the
 * expected ones, and its signature, by a pinned key, is checked before
 * anything is decrypted. The binding is rebuilt from this device and this
 * request, never from the answer.
 */
export async function openWrap(w, device, keys, expect) {
  if (!w || typeof w !== "object" || w.v !== "mxw1") fail("bad_wrap");
  if (w.purpose !== expect.purpose || w.ref !== expect.ref) fail("binding");
  let epk, c, sig;
  try {
    epk = unb64url(w.epk);
    c = unb64url(w.c);
    sig = unb64url(w.sig);
  } catch {
    fail("bad_wrap");
  }
  if (epk.length !== 32 || sig.length !== 64 || c.length < 16) fail("bad_wrap");
  const authKey = typeof w.kid === "string" && Object.hasOwn(keys, w.kid) ? keys[w.kid] : null;
  if (!authKey) fail("unknown_kid");
  const aad = wrapBinding({ ...expect, jkt: device.jkt });
  const verifyKey = await subtle().importKey("raw", authKey, { name: "Ed25519" }, false, ["verify"]);
  if (!(await subtle().verify({ name: "Ed25519" }, verifyKey, sig, wrapSigned(aad, epk, c)))) fail("bad_signature");
  let shared;
  try {
    const peer = await subtle().importKey("raw", epk, { name: "X25519" }, false, []);
    shared = new Uint8Array(await subtle().deriveBits({ name: "X25519", public: peer }, device.enc.privateKey, 256));
  } catch {
    fail("bad_wrap");
  }
  const ikm = await subtle().importKey("raw", shared, "HKDF", false, ["deriveBits"]);
  const raw = await subtle().deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: concat(epk, device.enc.publicKey), info: utf8(`molt mxw1 ${w.purpose}`) },
    ikm,
    256
  );
  const key = await subtle().importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
  try {
    return new Uint8Array(await subtle().decrypt({ name: "AES-GCM", iv: new Uint8Array(12), additionalData: aad, tagLength: 128 }, key, c));
  } catch {
    fail("decrypt");
  }
}

// -- Auth's JWS ------------------------------------------------------------------

/** A compact JWS auth signed: `alg` EdDSA, `typ`, a pinned `kid`, the signature. Answers its claims. */
export async function verifyAuthJws(compact, keys, typ) {
  const parts = typeof compact === "string" && compact.length <= 8192 ? compact.split(".") : [];
  if (parts.length !== 3) fail("bad_token");
  let header, claims, sig;
  try {
    header = JSON.parse(new TextDecoder().decode(unb64url(parts[0])));
    claims = JSON.parse(new TextDecoder().decode(unb64url(parts[1])));
    sig = unb64url(parts[2]);
  } catch {
    fail("bad_token");
  }
  if (header?.alg !== "EdDSA" || header?.typ !== typ) fail("bad_token");
  const key = typeof header.kid === "string" && Object.hasOwn(keys, header.kid) ? keys[header.kid] : null;
  if (!key) fail("unknown_kid");
  const verifyKey = await subtle().importKey("raw", key, { name: "Ed25519" }, false, ["verify"]);
  const ok = sig.length === 64 && (await subtle().verify({ name: "Ed25519" }, verifyKey, sig, utf8(`${parts[0]}.${parts[1]}`)));
  if (!ok) fail("bad_signature");
  if (!claims || typeof claims !== "object" || Array.isArray(claims)) fail("bad_token");
  return claims;
}

const id = (v) => typeof v === "string" && v.length > 0 && v.length <= 256;

/** The extension token's claims, checked for this install and this device: `{sub, did, bid, iat, exp}`. */
export async function checkExtensionToken(token, keys, { installId, did, now = nowS() }) {
  const c = await verifyAuthJws(token, keys, EXTENSION_TYP);
  if (c.iss !== "molt-auth" || !id(c.sub) || !id(c.did) || !id(c.bid)) fail("bad_token");
  if (c.bid !== installId) fail("binding", "the extension token names another Chrome install");
  if (did && c.did !== did) fail("binding", "the extension token names another device");
  if (!Number.isInteger(c.iat) || !Number.isInteger(c.exp) || c.exp <= c.iat || c.exp - c.iat > EXTENSION_TTL) fail("bad_token");
  if (c.iat > now + CLOCK_SKEW || c.exp <= now) fail("bad_token", "the extension token is not live");
  return c;
}

// -- A sign-in's start ---------------------------------------------------------------

/**
 * `start_proof`, a `molt-sign-in-start` JWS by a pinned auth key, names this
 * provider, this device's key and this request's proof `jti`, is fresh, and
 * carries the same `sign_in_id`, `authorize_url`, `interval` and
 * `expires_in` the answer does (molt_wire's `start_proof_ok`). A start
 * answered for another device or another request (ba63438d) never opens.
 */
export async function checkStartProof(answer, { keys, provider, jkt, jti, now = nowS() }) {
  let c;
  try {
    c = await verifyAuthJws(answer?.start_proof, keys, "molt-sign-in-start");
  } catch {
    fail("invalid_sign_in_start", "Molt Auth's sign-in did not come signed for this browser");
  }
  const int = (v) => (Number.isInteger(v) ? v : null);
  const [iat, exp, ttl, interval] = [int(c.iat), int(c.exp), int(c.expires_in), int(c.interval)];
  const fresh =
    iat !== null && exp !== null && ttl !== null && interval !== null &&
    iat <= now + 5 && exp > now && exp - iat === ttl && ttl >= 1 && ttl <= 600 && interval >= 1 && interval <= 60;
  const same = ["sign_in_id", "authorize_url", "interval", "expires_in"].every(
    (k) => c[k] !== undefined && c[k] !== null && c[k] === answer[k]
  );
  if (!fresh || !same || c.provider !== provider || c.request_jti !== jti || c.jkt !== jkt) {
    fail("invalid_sign_in_start", "Molt Auth's sign-in did not come signed for this browser");
  }
  return c;
}

/**
 * The tab opens only the provider's own page: auth's dev page on auth's own
 * origin, Google's and Apple's authorize endpoints over https.
 */
export function providerUrlOk(base, provider, url) {
  let u, auth;
  try {
    u = new URL(url);
    auth = new URL(base);
  } catch {
    return false;
  }
  if (u.username || u.password || u.hash) return false;
  if (provider === "dev") return u.origin === auth.origin && u.pathname === "/v1/sign-in/dev";
  const want = { google: ["accounts.google.com", "/o/oauth2/v2/auth"], apple: ["appleid.apple.com", "/auth/authorize"] }[provider];
  return !!want && u.protocol === "https:" && u.port === "" && u.hostname === want[0] && u.pathname === want[1];
}

const CROCKFORD = /^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/;

/**
 * The app code (S279): auth's `confirmation` wrap, purpose `enroll-code`,
 * bound to this device's key, the start's `jti` and `sign-in/<id>`, signed
 * by a pinned key. The browser's page asks for it after the provider, so a
 * sign-in finished in a browser without it never becomes this device's.
 */
export async function openConfirmation(wrap, device, keys, { jti, signInId }) {
  let code = null;
  try {
    const plain = await openWrap(wrap, device, keys, { purpose: "enroll-code", jti, ref: `sign-in/${signInId}` });
    code = new TextDecoder().decode(plain);
  } catch {
    code = null;
  }
  if (typeof code !== "string" || !CROCKFORD.test(code)) fail("invalid_confirmation_code", "Molt Auth's sign-in code did not open on this browser");
  return code;
}

// -- Requests ----------------------------------------------------------------------

async function readCapped(res, cap) {
  const declared = Number(res.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > cap) fail("too_large");
  if (!res.body?.getReader) {
    const text = await res.text();
    if (text.length > cap) fail("too_large");
    return text;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > cap) {
      reader.cancel().catch(() => {});
      fail("too_large");
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(concat(...chunks));
}

// A proof auth refused as such: signed again once (a new jti and iat), never more.
const proofRefused = (status, code) => status === 401 && (code === "stale_proof" || code === "replayed");

/**
 * One device-signed request: `{status, json, jti}`. `did` goes in the proof
 * except at a sign-in's start and polls. A refused proof is signed again
 * once; a second refusal is the answer.
 */
async function signed(fetch, config, device, method, path, body, { withDid }) {
  const once = async () => {
    const raw = body === undefined ? "" : JSON.stringify(body);
    const jti = b64url(crypto.getRandomValues(new Uint8Array(16)));
    const url = `${config.base}${path}`;
    const proof = await deviceProof(device, { did: withDid ? device.did : null, htm: method, htu: url, iat: nowS(), jti }, utf8(raw));
    const headers = { "molt-proof": proof };
    if (body !== undefined) headers["content-type"] = "application/json";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_MS);
    try {
      const res = await fetch(url, { method, headers, body: body === undefined ? undefined : raw, credentials: "omit", cache: "no-store", signal: controller.signal });
      let json = {};
      try {
        const parsed = JSON.parse(await readCapped(res, ANSWER_CAP));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) json = parsed;
      } catch (e) {
        if (e instanceof MoltAuthError) throw e;
      }
      return { status: res.status, json, jti };
    } catch (e) {
      if (e instanceof MoltAuthError) throw e;
      fail(controller.signal.aborted ? "timeout" : "unreachable", "could not reach Molt Auth");
    } finally {
      clearTimeout(timer);
    }
  };
  const first = await once();
  return proofRefused(first.status, first.json.error) ? once() : first;
}

const refused = (a) => new MoltAuthError(typeof a.json.error === "string" && a.json.error ? a.json.error : `http_${a.status}`, undefined, a.status);

/**
 * The extension's calls to the key service. `store` keeps the device;
 * `config` is `authConfig()`'s (never null here).
 */
export function authClient({ fetch, store, config }) {
  return {
    /**
     * S23: a sign-in with `provider`. Its page is answered only once its
     * nonce names this device, auth's signed start proof matches this
     * request (ba63438d) and the page is the provider's; `code` is the app
     * code (S279) the user types on auth's page after the provider.
     */
    async startSignIn(provider) {
      if (!config.providers.includes(provider)) fail("bad_provider");
      for (let retries = 1; ; retries--) {
        const device = await ensureDevice(store);
        const body = { provider, device: deviceKeys(device), client: "web", device_name: "Chrome extension", confirmation: "app_code" };
        const a = await signed(fetch, config, device, "POST", "/v1/sign-in/start", body, { withDid: false });
        if (a.status === 409 && a.json.error === "device_key_retired" && retries > 0) {
          await retireDevice(store);
          continue;
        }
        if (a.status !== 200) throw refused(a);
        const signInId = a.json.sign_in_id;
        const url = a.json.authorize_url;
        if (!id(signInId) || typeof url !== "string" || !/^https?:\/\//.test(url)) fail("bad_answer");
        let nonce = null;
        try {
          nonce = new URL(url).searchParams.get("nonce");
        } catch {
          nonce = null;
        }
        if (nonce !== (await signInNonce(device.jkt, signInId))) fail("nonce_mismatch", "Molt Auth's sign-in page does not name this browser's key");
        const proof = await checkStartProof(a.json, { keys: config.keys, provider, jkt: device.jkt, jti: a.jti });
        if (!providerUrlOk(config.base, provider, url)) fail("invalid_sign_in_start", "Molt Auth's sign-in page is not the provider's");
        const code = await openConfirmation(a.json.confirmation, device, config.keys, { jti: a.jti, signInId });
        return {
          id: signInId,
          url,
          code,
          interval: Math.min(30, proof.interval),
          deadline: nowS() + proof.expires_in,
        };
      }
    },

    /**
     * One poll. `{status: "pending" | "link_required"}` while it waits;
     * `{status: "complete", session}` with the session's user, device and
     * id (its tokens are not kept); `denied` or `expired` end it.
     */
    async pollSignIn(signInId) {
      const device = await ensureDevice(store);
      const a = await signed(fetch, config, device, "POST", "/v1/sign-in/poll", { sign_in_id: signInId }, { withDid: false });
      if (a.status !== 200) return { status: "pending" };
      switch (a.json.status) {
        case "complete": {
          const w = a.json.session;
          const ref = typeof w?.ref === "string" && w.ref.startsWith("session/") ? w.ref : null;
          if (!ref) fail("binding");
          const plain = await openWrap(w, device, config.keys, { purpose: "session", jti: a.jti, ref });
          let bundle = null;
          try {
            bundle = JSON.parse(new TextDecoder().decode(plain));
          } catch {
            bundle = null;
          }
          if (!bundle || !id(bundle.sid) || !id(bundle.user_id) || !id(bundle.device_id)) fail("bad_bundle");
          if (ref !== `session/${bundle.sid}`) fail("binding");
          await saveDid(store, bundle.device_id);
          return {
            status: "complete",
            session: { sid: bundle.sid, user_id: bundle.user_id, device_id: bundle.device_id, email: typeof bundle.email === "string" && bundle.email ? bundle.email : null },
          };
        }
        case "denied":
          if (a.json.reason === "device_key_retired") await retireDevice(store);
          return { status: "denied", reason: typeof a.json.reason === "string" ? a.json.reason : "denied" };
        case "expired":
          return { status: "expired" };
        case "link_required":
          return { status: "link_required" };
        default:
          return { status: "pending" };
      }
    },

    /** `POST /v1/browser/extension-token` from this device: `{token, expires_at, user_id}`, checked. */
    async extensionToken(installId) {
      const device = await ensureDevice(store);
      if (!device.did) fail("signed_out", "sign in to Molt Auth first");
      const a = await signed(fetch, config, device, "POST", "/v1/browser/extension-token", { browser_install_id: installId }, { withDid: true });
      if (a.status !== 200) throw refused(a);
      const plain = await openWrap(a.json.token, device, config.keys, { purpose: "session", jti: a.jti, ref: `browser/${installId}` });
      const token = new TextDecoder().decode(plain);
      const claims = await checkExtensionToken(token, config.keys, { installId, did: device.did });
      if (a.json.expires_at !== claims.exp) fail("bad_answer");
      return { token, expires_at: claims.exp, user_id: claims.sub };
    },

    /** Best effort `POST /v1/revoke` for the session, then the device forgets its id: no more tokens until a sign-in. */
    async signOut(sid) {
      const device = await ensureDevice(store);
      try {
        if (device.did && id(sid)) await signed(fetch, config, device, "POST", "/v1/revoke", { sid }, { withDid: true });
      } catch {
        // best effort: the session ends on its own
      } finally {
        await saveDid(store, null);
      }
    },
  };
}
