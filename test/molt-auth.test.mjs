// node --test test/  — the extension's own Molt Auth client (molt-auth.js):
// the shared vectors (mxw1, JWS, proofs, nonces) and the routes it calls,
// against a fake auth that speaks the real protocol.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ANSWER_CAP,
  MoltAuthError,
  authClient,
  authConfig,
  deviceProof,
  ensureDevice,
  jwkThumbprint,
  openWrap,
  parseAuthKeys,
  signInNonce,
  verifyAuthJws,
} from "../extension/molt-auth.js";
import { fakeAuth } from "./fake-auth.mjs";

const V = JSON.parse(readFileSync(new URL("./molt-auth-vectors.json", import.meta.url)));
const hex = (h) => new Uint8Array(Buffer.from(h, "hex"));
const subtle = globalThis.crypto.subtle;
const X25519_PKCS8 = hex("302e020100300506032b656e04220420");
const ED25519_PKCS8 = hex("302e020100300506032b657004220420");
const join = (a, b) => new Uint8Array([...a, ...b]);

// A device holding the vector's keys as non-extractable CryptoKeys, as the extension holds its own.
async function vectorDevice(c) {
  const encPrivate = await subtle.importKey("pkcs8", join(X25519_PKCS8, hex(c.device_enc_private)), { name: "X25519" }, false, ["deriveBits"]);
  const encPublic = c.device_enc_public ? hex(c.device_enc_public) : null;
  return { enc: { privateKey: encPrivate, publicKey: encPublic }, jkt: c.binding?.jkt ?? c.expect.jkt };
}

const store = () => {
  const m = new Map();
  return { get: async (k) => m.get(k), set: async (k, v) => void m.set(k, v), delete: async (k) => void m.delete(k), m };
};

async function codeOf(promise) {
  try {
    await promise;
    return "ok";
  } catch (e) {
    return e instanceof MoltAuthError ? e.code : `threw ${e.message}`;
  }
}

test("mxw1: every wrap of the shared vectors opens to its secret", async () => {
  for (const c of V.mxw1) {
    const device = await vectorDevice(c);
    const keys = { [c.auth_kid]: hex(c.auth_public) };
    const plain = await openWrap(c.wrap, device, keys, { purpose: c.binding.purpose, jti: c.binding.jti, ref: c.binding.ref });
    assert.equal(Buffer.from(plain).toString("hex"), c.secret, c.name);
  }
});

test("mxw1: every rejected vector is refused with its error, before anything opens", async () => {
  const publicOf = Object.fromEntries(V.mxw1.map((c) => [c.device_enc_private, c.device_enc_public]));
  for (const c of V.mxw1_reject) {
    const device = await vectorDevice({ ...c, device_enc_public: publicOf[c.device_enc_private] });
    const keys = Object.fromEntries(Object.entries(c.auth_keys).map(([k, v]) => [k, hex(v)]));
    assert.equal(await codeOf(openWrap(c.wrap, device, keys, { purpose: c.expect.purpose, jti: c.expect.jti, ref: c.expect.ref })), c.error, c.name);
  }
});

test("the sign-in nonce, the key thumbprint and the device proof match the shared vectors", async () => {
  for (const c of V.proof.sign_in_nonce) assert.equal(await signInNonce(c.jkt, c.sign_in_id), c.nonce);
  for (const c of V.jwk) assert.equal(await jwkThumbprint(hex(c.public)), c.thumbprint, c.name);
  const p = V.jws.find((c) => c.typ === "molt-proof");
  const claims = JSON.parse(p.payload_json);
  const privateKey = await subtle.importKey("pkcs8", join(ED25519_PKCS8, hex(p.seed)), { name: "Ed25519" }, false, ["sign"]);
  const device = { sig: { privateKey, publicKey: hex(p.public) } };
  const body = V.proof.body_hash.find((b) => b.bh === claims.bh).body;
  const compact = await deviceProof(device, { did: claims.did, htm: claims.htm, htu: claims.htu, iat: claims.iat, jti: claims.jti }, new TextEncoder().encode(body));
  assert.equal(compact, p.compact);
});

test("auth's JWS: the vector verifies; each rejected one is refused", async () => {
  const t = V.jws.find((c) => c.typ === "molt-access");
  const keys = { tk1: hex(t.public) };
  assert.deepEqual(await verifyAuthJws(t.compact, keys, t.typ), JSON.parse(t.payload_json));
  for (const c of V.jws_reject) {
    const code = await codeOf(verifyAuthJws(c.compact, { tk1: hex(c.public) }, c.typ));
    assert.ok(["bad_signature", "bad_token"].includes(code), `${c.name}: ${code}`);
  }
  assert.equal(await codeOf(verifyAuthJws(t.compact, { other: hex(t.public) }, t.typ)), "unknown_kid");
});

test("no auth in this build: no config, so nothing can call one; a local stack's override is read", () => {
  assert.equal(authConfig({}), null);
  assert.equal(authConfig({ authUrl: "http://127.0.0.1:4383" }), null, "a URL with no pinned key is none");
  assert.equal(authConfig({ authUrl: "http://127.0.0.1:4383", authKeys: "tk1:short" }), null, "a key that is not 32 bytes is dropped");
  const x = Buffer.alloc(32, 1).toString("base64url");
  const local = authConfig({ authUrl: "http://127.0.0.1:4383/", authKeys: `tk1:${x}` });
  assert.equal(local.base, "http://127.0.0.1:4383");
  assert.deepEqual(local.providers, ["dev", "google"]);
  assert.deepEqual(authConfig({ authUrl: "https://auth.example", authKeys: JSON.stringify({ keys: [{ kid: "tk2", x }] }) }).providers, ["google", "apple"]);
  assert.deepEqual(Object.keys(parseAuthKeys(`a:${x},b:nope,:${x}`)), ["a"]);
});

test("a packaged build takes only its own edge and pins: stored overrides are ignored", () => {
  const x = Buffer.alloc(32, 1).toString("base64url");
  const y = Buffer.alloc(32, 2).toString("base64url");
  const built = { url: "https://id.moltcode.com", keys: JSON.stringify({ keys: [{ kid: "tk-prod-1", x }] }) };
  for (const saved of [{}, { authUrl: "https://evil.example", authKeys: `evil:${y}` }, { authUrl: "https://evil.example" }, { authKeys: `evil:${y}` }]) {
    const config = authConfig(saved, built);
    assert.equal(config.base, "https://id.moltcode.com", JSON.stringify(saved));
    assert.deepEqual(Object.keys(config.keys), ["tk-prod-1"], JSON.stringify(saved));
  }
  // A build that carries none (the source tree, a local stack) still reads the override.
  assert.equal(authConfig({ authUrl: "http://127.0.0.1:4383", authKeys: `tk1:${x}` }, { url: null, keys: "" }).base, "http://127.0.0.1:4383");
});

async function client(over = {}) {
  const auth = await fakeAuth({ base: "http://127.0.0.1:4383" });
  const s = store();
  const config = authConfig({ authUrl: auth.base, authKeys: auth.keysText });
  const fetch = over.fetch ? over.fetch(auth) : auth.fetch(() => assert.fail("only auth is called"));
  return { auth, s, api: authClient({ fetch, store: s, config }) };
}

async function signedIn() {
  const c = await client();
  const start = await c.api.startSignIn("dev");
  c.auth.complete(start.id, "u1");
  const done = await c.api.pollSignIn(start.id);
  return { ...c, start, done };
}

test("sign-in: the page opens only for this device's nonce; the poll gives the session's ids, no tokens kept", async () => {
  const { auth, s, start, done } = await signedIn();
  assert.ok(start.url.startsWith(`${auth.base}/v1/sign-in/dev?`));
  assert.equal(start.interval, 1);
  assert.equal(done.status, "complete");
  assert.deepEqual(Object.keys(done.session).sort(), ["device_id", "email", "sid", "user_id"]);
  assert.equal(done.session.user_id, "u1");
  assert.equal(done.session.email, "me@example.com");
  const stored = s.m.get("device");
  assert.equal(stored.did, done.session.device_id);
  assert.equal(stored.sig.privateKey.extractable, false);
  assert.equal(stored.enc.privateKey.extractable, false);
  assert.equal(auth.signIns.size, 0);
  const startCall = auth.requests.find((r) => r.path === "/v1/sign-in/start");
  assert.ok(startCall);
});

test("sign-in: a start whose nonce names another key is refused before any page opens", async () => {
  const { auth, api } = await client();
  auth.tamper.nonce = true;
  assert.equal(await codeOf(api.startSignIn("dev")), "nonce_mismatch");
  assert.equal(await codeOf(api.startSignIn("apple")), "bad_provider", "a provider the config does not offer");
});

test("sign-in: the start asks for the app code and shows the one auth wrapped to this device and this start", async () => {
  const { auth, api } = await client();
  const start = await api.startSignIn("dev");
  assert.match(start.code, /^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
  assert.equal(start.code, auth.signIns.get(start.id).code, "the code auth's page will ask for");
  assert.ok(start.deadline > Math.floor(Date.now() / 1000) + 590);
});

test("sign-in: a swapped, unsigned or off-provider start, or a code for another sign-in, opens no page (ba63438d)", async () => {
  for (const [tamper, code] of [
    ["swap", "invalid_sign_in_start"],
    ["unsigned", "invalid_sign_in_start"],
    ["url", "invalid_sign_in_start"],
    ["code", "invalid_confirmation_code"],
  ]) {
    const { auth, api } = await client();
    auth.tamper.start = tamper;
    assert.equal(await codeOf(api.startSignIn("dev")), code, tamper);
    auth.tamper.start = null;
    assert.equal(await codeOf(api.startSignIn("dev")), "ok", `${tamper}: the next honest start opens`);
  }
});

test("sign-in: the start proof must name this device, this provider, a live window and the answer's own fields", async () => {
  const now = Math.floor(Date.now() / 1000);
  for (const [name, edit] of [
    ["another device's key", (c) => ({ ...c, jkt: "another-jkt" })],
    ["another provider", (c) => ({ ...c, provider: "google" })],
    ["expired", (c) => ({ ...c, iat: now - 700, exp: now - 100 })],
    ["issued in the future", (c) => ({ ...c, iat: now + 120, exp: now + 720 })],
    ["window not expires_in", (c) => ({ ...c, exp: c.iat + 300 })],
    ["another sign-in id", (c) => ({ ...c, sign_in_id: "si_other" })],
    ["another page", (c) => ({ ...c, authorize_url: `${c.authorize_url}&x=1` })],
    ["another interval", (c) => ({ ...c, interval: 9 })],
  ]) {
    const { auth, api } = await client();
    auth.tamper.startClaims = edit;
    assert.equal(await codeOf(api.startSignIn("dev")), "invalid_sign_in_start", name);
  }
  const { auth, api } = await client();
  auth.tamper.startTyp = "molt-browser";
  assert.equal(await codeOf(api.startSignIn("dev")), "invalid_sign_in_start", "a token of another typ");
});

test("sign-in: the page is the provider's own, on https, with no credentials or fragment", async () => {
  const { providerUrlOk } = await import("../extension/molt-auth.js");
  const base = "https://id.moltcode.com";
  assert.ok(providerUrlOk(base, "google", "https://accounts.google.com/o/oauth2/v2/auth?x=1"));
  assert.ok(providerUrlOk(base, "apple", "https://appleid.apple.com/auth/authorize?x=1"));
  assert.ok(providerUrlOk("http://127.0.0.1:4383", "dev", "http://127.0.0.1:4383/v1/sign-in/dev?x=1"));
  for (const [p, u] of [
    ["google", "http://accounts.google.com/o/oauth2/v2/auth"],
    ["google", "https://accounts.google.com.evil.test/o/oauth2/v2/auth"],
    ["google", "https://accounts.google.com:8443/o/oauth2/v2/auth"],
    ["google", "https://u:p@accounts.google.com/o/oauth2/v2/auth"],
    ["google", "https://accounts.google.com/o/oauth2/v2/auth#frag"],
    ["google", "https://appleid.apple.com/auth/authorize"],
    ["apple", "https://accounts.google.com/o/oauth2/v2/auth"],
    ["dev", "https://id.moltcode.com/v1/sign-in/dev"],
    ["other", "https://accounts.google.com/o/oauth2/v2/auth"],
  ]) assert.equal(providerUrlOk(p === "dev" ? "http://127.0.0.1:4383" : base, p, u), false, `${p} ${u}`);
});

test("extension token: asked by the device, opened from its wrap, checked for this install", async () => {
  const { auth, api, done } = await signedIn();
  const t = await api.extensionToken("install-1");
  assert.equal(t.user_id, "u1");
  assert.ok(t.expires_at > Date.now() / 1000 + 29 * 86400);
  const [h, p] = t.token.split(".");
  assert.equal(JSON.parse(Buffer.from(h, "base64url")).typ, "molt-browser");
  const claims = JSON.parse(Buffer.from(p, "base64url"));
  assert.equal(claims.bid, "install-1");
  assert.equal(claims.did, done.session.device_id);
  // The platform takes it as auth's pair.
  const connect = await (await auth.appDevice("u1"))({ machine_id: "m1", request_id: "r1", browser_install_id: "install-1", kid: "k1", public_key: "x".repeat(43) });
  assert.ok((await auth.verifyPair(t.token, connect)).ok);
});

test("extension token: a token for another install, a wrap for another ref, or a removed device is refused", async () => {
  const { auth, api, done } = await signedIn();
  auth.tamper.tokenBid = "install-2";
  assert.equal(await codeOf(api.extensionToken("install-1")), "binding");
  auth.tamper.tokenBid = null;
  auth.tamper.tokenRef = "browser/install-2";
  assert.equal(await codeOf(api.extensionToken("install-1")), "binding");
  auth.tamper.tokenRef = null;
  auth.removeDevice(done.session.device_id);
  const e = await api.extensionToken("install-1").catch((x) => x);
  assert.equal(e.code, "unauthorized");
  assert.equal(e.status, 401);
});

test("extension token: none before a sign-in names the device", async () => {
  const { auth, api } = await client();
  assert.equal(await codeOf(api.extensionToken("install-1")), "signed_out");
  assert.equal(auth.requests.length, 0);
});

test("a refused proof is signed again once, with a new jti; a second refusal is the answer", async () => {
  let refusals = 2;
  const jtis = [];
  const { api, auth } = await client({
    fetch: (auth) => async (url, init) => {
      jtis.push(JSON.parse(Buffer.from(init.headers["molt-proof"].split(".")[1], "base64url")).jti);
      if (refusals-- > 0) return new Response(JSON.stringify({ error: "replayed" }), { status: 401 });
      return auth.fetch(() => assert.fail())(url, init);
    },
  });
  assert.equal(await codeOf(api.startSignIn("dev")), "replayed");
  assert.equal(jtis.length, 2);
  assert.notEqual(jtis[0], jtis[1]);
  refusals = 1;
  assert.ok((await api.startSignIn("dev")).id);
  assert.equal(auth.requests.length, 1);
});

test("an answer over 256 KiB is refused unread", async () => {
  const { api } = await client({ fetch: () => async () => new Response("x".repeat(ANSWER_CAP + 1), { status: 200 }) });
  assert.equal(await codeOf(api.startSignIn("dev")), "too_large");
});

test("sign-out revokes the session and the device forgets its id", async () => {
  const { auth, api, s, done } = await signedIn();
  await api.signOut(done.session.sid);
  assert.deepEqual(auth.revoked, [done.session.sid]);
  assert.equal(s.m.get("device").did, null);
  // The same key signs in again as the same device.
  const again = await api.startSignIn("dev");
  auth.complete(again.id, "u1");
  assert.equal((await api.pollSignIn(again.id)).session.device_id, done.session.device_id);
});

test("a device key auth retired is replaced, and the start goes again as a new device", async () => {
  const { s, api } = await client({
    fetch: (auth) => {
      let first = true;
      return async (url, init) => {
        if (first && url.endsWith("/v1/sign-in/start")) {
          first = false;
          return new Response(JSON.stringify({ error: "device_key_retired" }), { status: 409 });
        }
        return auth.fetch(() => assert.fail())(url, init);
      };
    },
  });
  await ensureDevice(s);
  const before = s.m.get("device");
  assert.ok((await api.startSignIn("dev")).id);
  assert.notEqual(s.m.get("device"), before);
});
