// node --test test/  — connecting to the Molt app through the platform's
// verify, driven through the real service worker and popup.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeChrome, loadServiceWorker, renderPopup } from "./fakes.mjs";

const now = Math.floor(Date.now() / 1000);
const appKey = Buffer.alloc(32, 7).toString("base64url");
const account = { token: "ext-token", expires_at: now + 3600, user: { id: "u1", email: "me@example.com", name: "Me" } };
const oldPairing = {
  pair_id: "r0",
  kid: "k0",
  public_key: Buffer.alloc(32, 3).toString("base64url"),
  user_id: "u1",
  email: "me@example.com",
  machine_id: "m1",
  machine_name: "mac",
  browser_install_id: "b1",
  verified: "platform",
  paired_at: 1,
};

// The platform's POST /api/browser/verify, answering `status` with `body`.
function platform(status, body) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: status >= 200 && status < 300, status, json: async () => structuredClone(body) };
  };
  return { fetch, calls };
}

const refused = (status, code, message) => platform(status, { valid: false, error: { code, message } });

// Verifies the connect token connect() hands over, which names its request.
const verifies = async (url, init) => {
  const requestId = JSON.parse(init.body).token.replace(/^connect:/, "");
  return platform(200, {
    valid: true,
    user: { id: "u1", email: "me@example.com", name: "Me" },
    connection: {
      user_id: "u1",
      machine_id: "m1",
      machine_name: "mac",
      request_id: requestId,
      browser_install_id: "b1",
      kid: "k1",
      public_key: appKey,
      exp: now + 300,
    },
  }).fetch(url, init);
};

// A signed-in extension, optionally paired, with the host bridge up.
async function boot(t, { pairing = oldPairing, reconnect, fetch } = {}) {
  const local = { installId: "b1", account: structuredClone(account) };
  if (pairing) local.pairing = structuredClone(pairing);
  if (reconnect) local.reconnect = true;
  const fake = await loadServiceWorker(t, fakeChrome({ local }), fetch);
  fake.port.deliver({ type: "ready", version: "0.4.2", min_protocol: 3 });
  return fake;
}

let ids = 0;

// Connect in the popup: the service worker posts its request to the host.
async function requestConnect(fake) {
  assert.deepEqual(await fake.send({ molt: "connect" }), { ok: true });
  return fake.port.sent.findLast((m) => m.type === "connect_request").request;
}

// The Molt app's Allow: the host hands over the connect token. Resolves with
// the service worker's answer to the host.
function accept(fake, request) {
  const id = ++ids;
  fake.port.deliver({
    id,
    method: "connect_accept",
    params: { request_id: request.request_id, token: `connect:${request.request_id}`, kid: "k1", public_key: appKey },
  });
  return fake.port.next((m) => m.id === id);
}

async function connect(fake) {
  const request = await requestConnect(fake);
  return { request, reply: await accept(fake, request) };
}

const state = (fake) => fake.send({ molt: "state" });

test("403 install_mismatch drops the stale pairing and asks to connect again; the sign-in stays", async (t) => {
  const { fetch, calls } = refused(403, "install_mismatch", "The app's connect token was made for another Chrome install");
  const fake = await boot(t, { fetch });

  const { reply } = await connect(fake);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.headers.authorization, "Bearer ext-token");
  assert.equal(reply.ok, false);
  assert.equal(reply.error.code, "install_mismatch");
  assert.equal(fake.local.pairing, undefined);
  assert.equal(fake.local.reconnect, true);
  assert.deepEqual(fake.local.account, account);
  // The host and `molt-browser status` learn the pairing is gone.
  await fake.port.next((m) => m.type === "hello" && m.paired === null);
  const s = await state(fake);
  assert.equal(s.pairing, null);
  assert.equal(s.reconnect, true);
  assert.equal(s.connecting, null);
  assert.deepEqual(s.account, { email: "me@example.com", name: "Me" });
});

test("the ask outlives a service worker restart, and a later pairing clears it", async (t) => {
  const fake = await boot(t, { pairing: null, reconnect: true, fetch: verifies });
  assert.equal((await state(fake)).reconnect, true);

  const { request, reply } = await connect(fake);

  assert.equal(reply.ok, true, JSON.stringify(reply.error));
  assert.equal(fake.local.reconnect, undefined);
  assert.equal(fake.local.pairing.pair_id, request.request_id);
  const s = await state(fake);
  assert.equal(s.reconnect, false);
  assert.equal(s.pairing.machine_name, "mac");
});

test("signing out clears the ask", async (t) => {
  const fake = await boot(t, { pairing: null, reconnect: true });
  assert.deepEqual(await fake.send({ molt: "sign_out" }), { ok: true });
  assert.equal(fake.local.reconnect, undefined);
  assert.equal((await state(fake)).reconnect, false);
});

for (const [status, code, message] of [
  [403, "account_mismatch", "Chrome and the Molt app are signed in to different accounts"],
  [401, "bad_connect_token", "The app's connect token is invalid or expired"],
  [400, "bad_request", "An extension token and a connect token are required"],
  [409, "install_mismatch", "not the platform's 403"],
]) {
  test(`${status} ${code} keeps today's behaviour: the failure shows, the pairing and sign-in stay`, async (t) => {
    const fake = await boot(t, { fetch: refused(status, code, message).fetch });

    const { reply } = await connect(fake);

    assert.equal(reply.error.code, code);
    assert.deepEqual(fake.local.pairing, oldPairing);
    assert.deepEqual(fake.local.account, account);
    assert.equal(fake.local.reconnect, undefined);
    const s = await state(fake);
    assert.ok(!s.reconnect);
    assert.deepEqual(s.connecting, { state: "failed", error: message });
  });
}

test("401 signed_out still signs the extension out", async (t) => {
  const fake = await boot(t, { fetch: refused(401, "signed_out", "Sign in to Molt in the extension again").fetch });

  const { reply } = await connect(fake);

  assert.equal(reply.error.code, "signed_out");
  assert.equal(fake.local.account, undefined);
  assert.equal(fake.local.pairing, undefined);
  assert.equal(fake.local.reconnect, undefined);
  const s = await state(fake);
  assert.equal(s.account, null);
  assert.ok(!s.reconnect);
});

test("a late install_mismatch for a request the user replaced changes nothing", async (t) => {
  let answer;
  const held = new Promise((resolve) => (answer = resolve));
  const fake = await boot(t, { fetch: () => held });

  // The first request reaches the platform and waits there...
  const first = await requestConnect(fake);
  const late = accept(fake, first);
  assert.equal((await state(fake)).connecting.state, "verifying");
  // ...while the user cancels and connects again.
  assert.deepEqual(await fake.send({ molt: "cancel_connect" }), { ok: true });
  const second = await requestConnect(fake);
  assert.notEqual(second.request_id, first.request_id);

  answer({ ok: false, status: 403, json: async () => ({ valid: false, error: { code: "install_mismatch", message: "x" } }) });
  const reply = await late;

  assert.equal(reply.error.code, "install_mismatch");
  assert.deepEqual(fake.local.pairing, oldPairing);
  assert.equal(fake.local.reconnect, undefined);
  const s = await state(fake);
  assert.equal(s.reconnect, false);
  assert.deepEqual(s.connecting, { state: "waiting", error: null });
});

// The service worker's answer to {molt: "state"} for a signed-in, bridged,
// unpaired browser.
const popupState = (over = {}) => ({
  bridge: { connected: true, error: null, hostVersion: "0.4.2", minProtocol: 3 },
  version: "0.4.2",
  update: null,
  updatePending: false,
  unpacked: false,
  account: { email: "me@example.com", name: "Me" },
  protectForeground: false,
  pairing: null,
  connecting: null,
  reconnect: false,
  tab: { controlled: false, stopped: false },
  ...over,
});

test("the popup asks to connect again, with Connect right there", async () => {
  const p = await renderPopup(popupState({ reconnect: true }));

  assert.ok(p.visible("connect-again"));
  assert.equal(p.el("connect-again").textContent, "Connect the Molt app again. Click Connect, then Allow in the app.");
  assert.ok(p.visible("connect"));
  assert.equal(p.el("connect").disabled, false);
  assert.equal(p.el("step-connect").className, "current");
  assert.ok(!p.visible("connect-error"));
  assert.ok(!p.visible("connect-waiting"));

  await p.el("connect").onclick();
  assert.ok(p.sent.some((m) => m.molt === "connect"));
});

test("the ask gives way to waiting, to a newer failure, and to a pairing", async () => {
  const waiting = await renderPopup(popupState({ reconnect: true, connecting: { state: "waiting", error: null } }));
  assert.ok(!waiting.visible("connect-again"));
  assert.ok(waiting.visible("connect-waiting"));

  const failed = await renderPopup(popupState({ reconnect: true, connecting: { state: "failed", error: "Declined in the Molt app." } }));
  assert.ok(!failed.visible("connect-again"));
  assert.ok(failed.visible("connect-error"));
  assert.equal(failed.el("connect-error").textContent, "Declined in the Molt app.");

  const paired = await renderPopup(popupState({ reconnect: true, pairing: { email: "me@example.com", machine_name: "mac", paired_at: 1 } }));
  assert.ok(!paired.visible("connect-again"));
  assert.equal(paired.el("connect-detail").textContent, "Connected to mac. Agents can use this browser.");
});

test("without the ask the popup is as before", async () => {
  const p = await renderPopup(popupState());
  assert.ok(!p.visible("connect-again"));
  assert.ok(p.visible("connect"));
  assert.equal(p.el("connect-detail").textContent, "Until then no agent can use this browser.");
  assert.ok(!p.visible("connect-error"));
});
