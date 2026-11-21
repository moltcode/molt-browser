// node --test test/  — the extension signing in at Molt Auth (S220), driven
// through the real service worker and popup: from the first screen in a
// build that carries auth, with the app code shown while it waits; in one
// without, only after the platform's 403 auth_required; the auth pair
// verified at the platform, install_mismatch included; renewal and sign-out.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeAuth } from "./fake-auth.mjs";
import { fakeChrome, fakeIndexedDB, loadServiceWorker, renderPopup } from "./fakes.mjs";

const AUTH = "http://127.0.0.1:4383";
const PLATFORM = "https://platform.moltcode.com";
const now = () => Math.floor(Date.now() / 1000);
const appKey = Buffer.alloc(32, 7).toString("base64url");
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// The platform: `/api/browser/session` answers `session` (a platform token
// for an account with no sealed workspace, else 403 auth_required), and
// `/api/browser/verify` checks auth's pair with the fake auth's keys.
function platform(auth, { session = "auth_required" } = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, auth: init.headers?.authorization ?? null });
    const path = new URL(url).pathname;
    if (path === "/api/browser/session") {
      if (session === "auth_required") return json(403, { valid: false, error: { code: "auth_required", message: "This account signs in to Chrome through Molt Auth" } });
      return json(200, { token: "platform-ext-token", expires_at: now() + 3600, user: { id: "u9", email: "plain@example.com", name: "Plain" } });
    }
    if (path === "/api/browser/verify") {
      const bearer = (init.headers?.authorization ?? "").replace(/^Bearer /, "");
      const r = await auth.verifyPair(bearer, JSON.parse(init.body).token);
      return r.ok ? json(200, r.ok) : json(r.error === "install_mismatch" || r.error === "account_mismatch" ? 403 : 401, { valid: false, error: { code: r.error === "bad_extension_token" ? "signed_out" : r.error, message: r.error } });
    }
    return json(404, {});
  };
  return { fetch, calls };
}

// An extension whose sign-in at the platform comes back now; `authUrl` set
// as a local stack sets it (null: this build's, which has none).
async function boot(t, { authConfigured = true, session, local = {}, sessionStore = {}, idb } = {}) {
  const auth = await fakeAuth({ base: AUTH, users: { u1: "me@example.com" } });
  const p = platform(auth, { session });
  const store = { installId: "b1", ...local };
  if (authConfigured) Object.assign(store, { authUrl: AUTH, authKeys: auth.keysText });
  const fake = await loadServiceWorker(t, fakeChrome({ local: store, session: { signInState: { state: "st", expires_at: Date.now() + 60_000 }, ...sessionStore }, idb }), auth.fetch(p.fetch));
  fake.port.deliver({ type: "ready", version: "0.4.2", min_protocol: 3 });
  return { fake, auth, platform: p };
}

// Resolves with what the service worker stores under `key` next.
function stored(fake, key) {
  return new Promise((resolve) => {
    const set = fake.chrome.storage.local.set;
    fake.chrome.storage.local.set = async (items) => {
      await set(items);
      if (Object.hasOwn(items, key)) {
        fake.chrome.storage.local.set = set;
        resolve(items[key]);
      }
    };
  });
}

const state = (fake) => fake.send({ molt: "state" });
const signedInPage = (fake) => fake.send({ molt: "signed_in", token: "platform-jwt", state: "st" }, "signed-in.html", { id: 7 });

// Through auth's dev page: the platform says auth_required, the person picks
// the dev provider on the signed-in page, finishes on auth's page, and the
// poll brings the extension token.
async function signInAtAuth(fake, auth) {
  const r = await signedInPage(fake);
  assert.deepEqual(r, { ok: true, authRequired: true, reachable: true, providers: ["dev", "google"] });
  const account = stored(fake, "account");
  assert.deepEqual(await fake.send({ molt: "auth_sign_in", provider: "dev" }, "signed-in.html", { id: 7 }), { ok: true });
  const page = fake.opened.at(-1);
  assert.equal(page.id, 7, "auth's page opens in the signed-in tab");
  assert.ok(page.url.startsWith(`${AUTH}/v1/sign-in/dev?`));
  auth.complete(new URL(page.url).searchParams.get("sign_in_id"), "u1");
  return account;
}

let ids = 0;
async function connectWith(fake, token) {
  assert.deepEqual(await fake.send({ molt: "connect" }), { ok: true });
  const request = fake.port.sent.findLast((m) => m.type === "connect_request").request;
  const id = ++ids;
  fake.port.deliver({ id, method: "connect_accept", params: { request_id: request.request_id, token: await token(request), kid: "k1", public_key: appKey } });
  return { request, reply: await fake.port.next((m) => m.id === id) };
}

test("dormant: an account with no sealed workspace signs in at the platform and nothing reaches auth", async (t) => {
  const { fake, auth, platform: p } = await boot(t, { session: "platform" });
  const r = await signedInPage(fake);
  assert.deepEqual(r, { ok: true, email: "plain@example.com" });
  assert.equal(fake.local.account.token, "platform-ext-token");
  assert.equal((await state(fake)).auth, null);
  assert.deepEqual(auth.requests, []);
  assert.ok(p.calls.every((c) => !c.url.startsWith(AUTH)));
  assert.equal(fake.idb.dbs.size, 0, "no device key is even made");
});

test("auth_required: the extension signs in at auth with its own device and pairs with auth's tokens", async (t) => {
  const { fake, auth, platform: p } = await boot(t);
  const account = await signInAtAuth(fake, auth);
  const a = await account;
  assert.equal(a.auth, true);
  assert.deepEqual(a.user, { id: "u1", email: "me@example.com", name: null });
  assert.equal(JSON.parse(Buffer.from(a.token.split(".")[0], "base64url")).typ, "molt-browser");
  assert.equal(fake.local.authRequired, undefined, "the ask is done");
  assert.deepEqual(Object.keys(fake.local.authSession).sort(), ["device_id", "email", "sid", "user_id"]);
  assert.ok(!JSON.stringify(fake.local).includes("refresh-secret"), "the session's tokens are not kept");
  const s = await state(fake);
  assert.deepEqual(s.account, { email: "me@example.com", name: null });

  const app = await auth.appDevice("u1");
  const { reply } = await connectWith(fake, (request) => app({ machine_id: "m1", request_id: request.request_id, browser_install_id: request.browser_install_id, kid: "k1", public_key: appKey, machine_name: "mac" }));
  assert.equal(reply.ok, true, JSON.stringify(reply.error));
  assert.equal(fake.local.pairing.user_id, "u1");
  assert.equal(fake.local.pairing.machine_id, "m1");
  assert.equal(p.calls.at(-1).auth, `Bearer ${a.token}`);
});

test("auth_required: an auth connect token for another Chrome install is install_mismatch, and the popup asks to connect again", async (t) => {
  const { fake, auth } = await boot(t);
  await (await signInAtAuth(fake, auth));
  const app = await auth.appDevice("u1");
  const { reply } = await connectWith(fake, (request) => app({ machine_id: "m1", request_id: request.request_id, browser_install_id: "another-install", kid: "k1", public_key: appKey }));
  assert.equal(reply.ok, false);
  assert.equal(reply.error.code, "install_mismatch");
  assert.equal(fake.local.pairing, undefined);
  assert.equal(fake.local.reconnect, true);
  assert.equal(fake.local.account.auth, true, "the sign-in stays");
  assert.equal((await state(fake)).reconnect, true);
});

test("auth_required with no auth in this build: the popup says so and nothing is sent anywhere new", async (t) => {
  const { fake, auth } = await boot(t, { authConfigured: false });
  assert.deepEqual(await signedInPage(fake), { ok: true, authRequired: true, reachable: false, providers: [] });
  const s = await state(fake);
  assert.deepEqual(s.auth, { required: true, direct: false, reachable: false, providers: [], signingIn: false, code: null, error: null });
  const r = await fake.send({ molt: "auth_sign_in", provider: "google" });
  assert.equal(r.ok, false);
  assert.match(r.error, /cannot reach/);
  assert.deepEqual(auth.requests, []);
  assert.equal(fake.idb.dbs.size, 0);

  const p = await renderPopup({ ...popupState(), auth: s.auth });
  assert.equal(p.el("account-detail").textContent, "This account signs in through Molt Auth, which this version of the extension cannot reach yet.");
  assert.ok(!p.visible("sign-in"));
  assert.ok(!p.visible("auth-google") && !p.visible("auth-dev"));
  assert.ok(p.visible("auth-cancel"));
});

test("the popup's own sign-in at auth opens a new tab; Cancel drops it, and finishing its page afterwards signs nobody in", async (t) => {
  const { fake, auth } = await boot(t);
  await signedInPage(fake);
  assert.deepEqual(await fake.send({ molt: "auth_sign_in", provider: "dev" }), { ok: true });
  const page = fake.opened.at(-1);
  assert.equal(page.id, undefined, "a new tab");
  assert.equal((await state(fake)).auth.signingIn, true);
  assert.deepEqual(await fake.send({ molt: "auth_cancel" }), { ok: true });
  // The person finishes on the page after all: the cancelled sign-in is not polled.
  auth.complete(new URL(page.url).searchParams.get("sign_in_id"), "u1");
  const s = await state(fake);
  assert.equal(s.auth.signingIn, false, "back to the first screen's offer");
  assert.equal(s.auth.code, null);
  assert.equal(fake.local.account, undefined);
  assert.equal(fake.session.authSignIn, undefined);
});

test("a sign-in waiting when the service worker stopped is polled again by the next one", async (t) => {
  const idb = fakeIndexedDB();
  const first = await boot(t, { idb });
  await signedInPage(first.fake);
  assert.deepEqual(await first.fake.send({ molt: "auth_sign_in", provider: "dev" }), { ok: true });
  const pending = first.fake.session.authSignIn;
  assert.ok(pending?.id);
  await first.fake.send({ molt: "auth_cancel" }); // stops this worker's timer; the restart below brings the saved one back

  const auth = first.auth;
  const p = platform(auth);
  const fake = await loadServiceWorker(
    t,
    fakeChrome({ local: { installId: "b1", authUrl: AUTH, authKeys: auth.keysText, authRequired: true }, session: { authSignIn: pending }, idb }),
    auth.fetch(p.fetch)
  );
  const account = stored(fake, "account");
  auth.complete(pending.id, "u1");
  assert.equal((await account).user.id, "u1");
});

test("an auth token near its end is asked again before the platform sees it; a removed device signs out", async (t) => {
  const { fake, auth } = await boot(t);
  const first = await (await signInAtAuth(fake, auth));
  // 2 days left: inside the 3-day renewal window.
  await fake.chrome.storage.local.set({ account: { ...first, expires_at: now() + 2 * 86400 } });
  const fresh = await loadServiceWorker(t, fakeChrome({ local: structuredClone(fake.local), idb: fake.idb }), auth.fetch(platform(auth).fetch));
  fresh.port.deliver({ type: "ready", version: "0.4.2", min_protocol: 3 });
  const app = await auth.appDevice("u1");
  const tokens = auth.requests.filter((r) => r.path === "/v1/browser/extension-token").length;
  const { reply } = await connectWith(fresh, (request) => app({ machine_id: "m1", request_id: request.request_id, browser_install_id: request.browser_install_id, kid: "k1", public_key: appKey }));
  assert.equal(reply.ok, true, JSON.stringify(reply.error));
  assert.equal(auth.requests.filter((r) => r.path === "/v1/browser/extension-token").length, tokens + 1);
  assert.ok(fresh.local.account.expires_at > now() + 29 * 86400);

  // The device is removed at auth: the next renewal signs this browser out.
  await fresh.chrome.storage.local.set({ account: { ...fresh.local.account, expires_at: now() + 60 } });
  auth.removeDevice(fresh.local.authSession.device_id);
  const third = await loadServiceWorker(t, fakeChrome({ local: structuredClone(fresh.local), idb: fake.idb }), auth.fetch(platform(auth).fetch));
  third.port.deliver({ type: "ready", version: "0.4.2", min_protocol: 3 });
  const { reply: refused } = await connectWith(third, (request) => app({ machine_id: "m1", request_id: request.request_id, browser_install_id: request.browser_install_id, kid: "k1", public_key: appKey }));
  assert.equal(refused.error.code, "signed_out");
  assert.equal(third.local.account, undefined);
  assert.equal(third.local.authSession, undefined);
});

test("sign-out ends the auth session at auth and forgets the device's id", async (t) => {
  const { fake, auth } = await boot(t);
  await (await signInAtAuth(fake, auth));
  const sid = fake.local.authSession.sid;
  assert.deepEqual(await fake.send({ molt: "sign_out" }), { ok: true });
  assert.deepEqual(auth.revoked, [sid]);
  assert.equal(fake.local.account, undefined);
  assert.equal(fake.local.authSession, undefined);
  assert.equal(fake.local.authRequired, undefined);
  const s = await state(fake);
  assert.equal(s.auth.direct, true, "signed out: the first screen offers auth again");
  assert.equal(s.auth.signingIn, false);
  assert.equal(fake.idb.dbs.get("molt-auth").get("kv").get("device").did, null);
});

test("a build that carries auth signs in there from the first screen, shows the app code, and never asks the platform", async (t) => {
  const { fake, auth, platform: p } = await boot(t);
  const first = await state(fake);
  assert.deepEqual(first.auth, { required: true, direct: true, reachable: true, providers: ["dev", "google"], signingIn: false, code: null, error: null });
  const r = await fake.send({ molt: "sign_in" });
  assert.equal(r.ok, false, "the platform's redirect login is not offered");
  assert.match(r.error, /Molt Auth/);

  const account = stored(fake, "account");
  assert.deepEqual(await fake.send({ molt: "auth_sign_in", provider: "dev" }), { ok: true });
  const page = fake.opened.at(-1);
  const id = new URL(page.url).searchParams.get("sign_in_id");
  const waiting = await state(fake);
  assert.equal(waiting.auth.signingIn, true);
  assert.equal(waiting.auth.code, auth.signIns.get(id).code, "the code auth's page will ask for");
  assert.match(waiting.auth.code, /^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
  auth.complete(id, "u1");
  const a = await account;
  assert.equal(a.auth, true);
  assert.equal(a.user.id, "u1");
  assert.equal(fake.session.authSignIn, undefined, "the code goes with the sign-in");
  assert.equal((await state(fake)).auth, null, "signed in: nothing to offer");
  assert.deepEqual(p.calls, [], "the platform saw nothing");
});

test("a build that carries auth refuses a swapped start: no tab opens and the popup says why", async (t) => {
  const { fake, auth } = await boot(t);
  auth.tamper.start = "swap";
  const opened = fake.opened.length;
  const r = await fake.send({ molt: "auth_sign_in", provider: "dev" });
  assert.equal(r.ok, false);
  assert.match(r.error, /signed for this browser/);
  assert.equal(fake.opened.length, opened, "no page opened");
  assert.equal((await state(fake)).auth.signingIn, false);
  assert.equal(fake.session.authSignIn, undefined);
});

// The service worker's answer to {molt: "state"}, signed out and bridged.
const popupState = (over = {}) => ({
  bridge: { connected: true, error: null, hostVersion: "0.4.2", minProtocol: 3 },
  version: "0.4.2",
  update: null,
  updatePending: false,
  unpacked: false,
  account: null,
  protectForeground: false,
  pairing: null,
  connecting: null,
  reconnect: false,
  auth: null,
  tab: { controlled: false, stopped: false },
  ...over,
});

test("the popup: the platform's ask offers the providers; a sign-in in flight waits with Open and Cancel", async () => {
  const choose = await renderPopup(popupState({ auth: { required: true, reachable: true, providers: ["google", "apple"], signingIn: false, error: null } }));
  assert.equal(choose.el("account-detail").textContent, "This account signs in through Molt Auth. Use the same account as the Molt app.");
  assert.ok(choose.visible("auth-google") && choose.visible("auth-apple"));
  assert.ok(!choose.visible("auth-dev"));
  assert.ok(!choose.visible("sign-in"));
  assert.ok(choose.visible("auth-cancel"));
  await choose.el("auth-apple").onclick();
  assert.ok(choose.sent.some((m) => m.molt === "auth_sign_in" && m.provider === "apple"));

  const waiting = await renderPopup(popupState({ auth: { required: true, reachable: true, providers: ["google", "apple"], signingIn: true, error: null } }));
  assert.equal(waiting.el("account-detail").textContent, "Finish signing in to Molt Auth in the tab that opened.");
  assert.ok(waiting.visible("auth-waiting") && waiting.visible("auth-reopen") && waiting.visible("auth-cancel"));
  assert.ok(!waiting.visible("auth-google"));

  const ended = await renderPopup(popupState({ auth: { required: true, reachable: true, providers: ["google"], signingIn: false, error: "The sign-in expired. Start it again." } }));
  assert.equal(ended.el("account-error").textContent, "The sign-in expired. Start it again.");
  assert.ok(ended.visible("auth-google"));

  const direct = await renderPopup(popupState({ auth: { required: true, direct: true, reachable: true, providers: ["google", "apple"], signingIn: false, code: null, error: null } }));
  assert.equal(direct.el("account-detail").textContent, "Sign in at Molt Auth with the account you use in the Molt app.");
  assert.ok(direct.visible("auth-google") && direct.visible("auth-apple"));
  assert.ok(!direct.visible("sign-in") && !direct.visible("auth-cancel"));

  const code = await renderPopup(popupState({ auth: { required: true, direct: true, reachable: true, providers: ["google", "apple"], signingIn: true, code: "7K2QF-M9XWD", error: null } }));
  assert.equal(code.el("auth-waiting").textContent, "When Molt Auth asks for a code, enter 7K2QF-M9XWD. It shows only here.");
  assert.ok(code.visible("auth-waiting") && code.visible("auth-reopen") && code.visible("auth-cancel"));

  const plain = await renderPopup(popupState());
  assert.ok(plain.visible("sign-in"));
  assert.ok(!plain.visible("auth-google") && !plain.visible("auth-cancel") && !plain.visible("auth-waiting"));
  assert.equal(plain.el("account-detail").textContent, "Use the same account as the Molt app.");
});
