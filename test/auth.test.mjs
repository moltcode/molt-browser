// node --test test/  — grant verification against real Ed25519 keys.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkOffer, verifyGrant, verifyRevoke } from "../extension/auth.js";

const b64url = (bytes) => Buffer.from(bytes).toString("base64url");
const now = Math.floor(Date.now() / 1000);

async function keypair() {
  const k = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  return { privateKey: k.privateKey, publicKey: b64url(await crypto.subtle.exportKey("raw", k.publicKey)) };
}

const backend = await keypair();
const other = await keypair();

const pairing = {
  pair_id: "p1",
  kid: "k1",
  public_key: backend.publicKey,
  user_id: "u1",
  machine_id: "m1",
  browser_install_id: "b1",
};

const baseClaims = () => ({
  v: 1,
  aud: "molt-browser",
  scope: "drive",
  kid: "k1",
  pair_id: "p1",
  user_id: "u1",
  machine_id: "m1",
  browser_install_id: "b1",
  session_id: "sess-a",
  iat: now,
  exp: now + 300,
});

async function sign(claims, key = backend.privateKey) {
  const body = b64url(Buffer.from(JSON.stringify(claims)));
  const sig = await crypto.subtle.sign({ name: "Ed25519" }, key, new TextEncoder().encode(body));
  return `${body}.${b64url(new Uint8Array(sig))}`;
}

async function rejects(promise, code) {
  await assert.rejects(promise, (e) => {
    assert.equal(e.code, code, e.message);
    return true;
  });
}

test("a valid grant yields the signed session", async () => {
  const c = await verifyGrant(await sign(baseClaims()), pairing, now);
  assert.equal(c.session_id, "sess-a");
});

test("no pairing rejects everything", async () => {
  await rejects(verifyGrant(await sign(baseClaims()), null, now), "unpaired");
});

test("missing or malformed grant", async () => {
  await rejects(verifyGrant(undefined, pairing, now), "no_grant");
  await rejects(verifyGrant("", pairing, now), "no_grant");
  await rejects(verifyGrant("a.b.c", pairing, now), "bad_grant");
  await rejects(verifyGrant("not base64!.x", pairing, now), "bad_grant");
});

test("a grant signed by any other key is rejected", async () => {
  await rejects(verifyGrant(await sign(baseClaims(), other.privateKey), pairing, now), "bad_grant");
});

test("tampered claims break the signature", async () => {
  const token = await sign(baseClaims());
  const [, sig] = token.split(".");
  const forged = b64url(Buffer.from(JSON.stringify({ ...baseClaims(), session_id: "sess-b" })));
  await rejects(verifyGrant(`${forged}.${sig}`, pairing, now), "bad_grant");
});

for (const [field, value, code] of [
  ["user_id", "u2", "wrong_user"],
  ["pair_id", "p2", "pair_mismatch"],
  ["kid", "k0", "pair_mismatch"],
  ["machine_id", "m2", "wrong_machine"],
  ["browser_install_id", "b2", "wrong_browser"],
  ["aud", "someone-else", "bad_grant"],
  ["scope", "revoke", "bad_grant"],
  ["v", 2, "bad_grant"],
  ["session_id", "", "bad_grant"],
  ["session_id", undefined, "bad_grant"],
]) {
  test(`wrong ${field} (${value}) is rejected`, async () => {
    await rejects(verifyGrant(await sign({ ...baseClaims(), [field]: value }), pairing, now), code);
  });
}

test("expired, over-long and future grants are rejected", async () => {
  await rejects(verifyGrant(await sign({ ...baseClaims(), iat: now - 900, exp: now - 120 }), pairing, now), "grant_expired");
  await rejects(verifyGrant(await sign({ ...baseClaims(), exp: now + 12 * 3600 }), pairing, now), "bad_grant");
  await rejects(verifyGrant(await sign({ ...baseClaims(), iat: now + 600, exp: now + 900 }), pairing, now), "bad_grant");
  await rejects(verifyGrant(await sign({ ...baseClaims(), exp: now }), pairing, now), "bad_grant");
});

test("an old grant dies with the pairing generation it was minted for", async () => {
  const old = await sign(baseClaims());
  const rotated = { ...pairing, kid: "k2" };
  await rejects(verifyGrant(old, rotated, now), "pair_mismatch");
});

test("revoke needs the paired key and revoke scope", async () => {
  const { session_id, ...revoke } = { ...baseClaims(), scope: "revoke" };
  assert.equal((await verifyRevoke(await sign(revoke), pairing, now)).scope, "revoke");
  await rejects(verifyRevoke(await sign(revoke, other.privateKey), pairing, now), "bad_grant");
  await rejects(verifyRevoke(await sign(baseClaims()), pairing, now), "bad_grant");
});

test("pair offers must be well-formed and short-lived", () => {
  const offer = {
    pair_id: "p1",
    nonce: "n",
    code: "482913",
    kid: "k1",
    public_key: backend.publicKey,
    user_id: "u1",
    email: "me@example.com",
    machine_id: "m1",
    machine_name: "mac",
    expires_at: now + 120,
  };
  assert.equal(checkOffer(offer, now).code, "482913");
  assert.throws(() => checkOffer({ ...offer, code: "12345" }, now), { code: "bad_offer" });
  assert.throws(() => checkOffer({ ...offer, public_key: b64url(new Uint8Array(16)) }, now), { code: "bad_offer" });
  assert.throws(() => checkOffer({ ...offer, expires_at: now + 3600 }, now), { code: "bad_offer" });
  assert.throws(() => checkOffer({ ...offer, expires_at: now - 1 }, now), { code: "bad_offer" });
  assert.throws(() => checkOffer({ ...offer, user_id: undefined }, now), { code: "bad_offer" });
});
