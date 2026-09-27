// Connection and grant verification.
//
// The extension signs in to Molt on its own, then connects to the Molt app on
// this computer: the app, once the user allows it there, hands over a connect
// token the platform signed, and the platform's verify API confirms that token
// names the same account the extension signed in with (checkConnection).
// The verified token also names the app's Ed25519 *public* key; the private
// key never leaves the app, so nothing in this profile can mint a grant.
// Every drive command carries a short-lived grant signed by that key; it is
// checked here before any handler runs, and the verified session id is the
// only one tab ownership ever sees.
//
// Token format: base64url(JSON claims) "." base64url(Ed25519 signature over
// the first segment's ASCII bytes).

export const PROTOCOL = 3;
export const PLATFORM_URL = "https://platform.moltcode.com";
// Marks a pairing the platform verified; anything else is dropped on load.
export const VERIFIED = "platform";
export const AUDIENCE = "molt-browser";
// Grants are minted for 5 minutes; anything claiming longer is rejected.
export const MAX_GRANT_SECONDS = 15 * 60;
export const CLOCK_SKEW_SECONDS = 60;

export class AuthError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const deny = (code, message) => {
  throw new AuthError(code, message);
};

export function b64urlDecode(s) {
  if (typeof s !== "string" || !/^[A-Za-z0-9_-]*$/.test(s)) deny("bad_grant", "grant is not base64url");
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  let bin;
  try {
    bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  } catch {
    deny("bad_grant", "grant is not base64url");
  }
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function importKey(publicKey) {
  const raw = b64urlDecode(publicKey);
  if (raw.length !== 32) deny("bad_pairing", "stored pairing key is not an Ed25519 public key");
  return crypto.subtle.importKey("raw", raw, { name: "Ed25519" }, false, ["verify"]);
}

// Checks the signature and the claims every signed message shares, then the
// scope-specific ones. Returns the verified claims.
async function verifySigned(token, pairing, scope, now) {
  if (!pairing?.public_key || pairing.verified !== VERIFIED) {
    deny("unpaired", "this browser is not connected to Molt. Open the Molt extension in Chrome, sign in and click Connect.");
  }
  if (typeof token !== "string" || token.length === 0 || token.length > 4096) {
    deny("no_grant", "request carries no Molt grant; molt-browser only drives Chrome from a Molt agent session");
  }
  const parts = token.split(".");
  if (parts.length !== 2) deny("bad_grant", "malformed grant");
  const [body, sig] = parts;

  const ok = await crypto.subtle.verify(
    { name: "Ed25519" },
    await importKey(pairing.public_key),
    b64urlDecode(sig),
    new TextEncoder().encode(body)
  );
  if (!ok) deny("bad_grant", "grant signature does not match the paired Molt backend");

  let c;
  try {
    c = JSON.parse(new TextDecoder().decode(b64urlDecode(body)));
  } catch {
    deny("bad_grant", "grant claims are not JSON");
  }
  if (!c || typeof c !== "object") deny("bad_grant", "grant claims are not an object");
  if (c.v !== 1) deny("bad_grant", `unsupported grant version ${c.v}`);
  if (c.aud !== AUDIENCE) deny("bad_grant", "grant audience is not molt-browser");
  if (c.scope !== scope) deny("bad_grant", `grant scope ${c.scope} cannot be used for ${scope}`);
  if (c.pair_id !== pairing.pair_id || c.kid !== pairing.kid) {
    deny("pair_mismatch", "grant was issued for a different connection; connect Chrome again from the Molt extension");
  }
  if (c.user_id !== pairing.user_id) deny("wrong_user", "grant belongs to a different Molt account than the one this browser is paired with");
  if (c.machine_id !== pairing.machine_id) deny("wrong_machine", "grant was issued by a different Molt machine");
  if (c.browser_install_id !== pairing.browser_install_id) deny("wrong_browser", "grant was issued for a different browser profile");
  if (!Number.isInteger(c.iat) || !Number.isInteger(c.exp)) deny("bad_grant", "grant has no validity window");
  if (c.exp - c.iat > MAX_GRANT_SECONDS || c.exp <= c.iat) deny("bad_grant", "grant lifetime is out of bounds");
  if (c.iat > now + CLOCK_SKEW_SECONDS) deny("bad_grant", "grant is issued in the future");
  if (c.exp <= now - CLOCK_SKEW_SECONDS) deny("grant_expired", "grant expired; the next command fetches a fresh one");
  return c;
}

export async function verifyGrant(token, pairing, now = Math.floor(Date.now() / 1000)) {
  const c = await verifySigned(token, pairing, "drive", now);
  if (typeof c.session_id !== "string" || c.session_id.length === 0) deny("bad_grant", "grant is not bound to a Molt session");
  return c;
}

// A backend-signed unpair (sign-out or account switch in Molt). Any
// same-user process can ask the extension to drop a pairing only with a
// message the paired backend signed.
export async function verifyRevoke(token, pairing, now = Math.floor(Date.now() / 1000)) {
  return verifySigned(token, pairing, "revoke", now);
}

export function sameId(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length || a.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// `verified` is the platform's answer to POST /api/browser/verify for the
// token the app handed over in `params`. The platform already compared the
// two accounts; this re-checks that its answer is about this request, this
// browser, this account and the key the app sent. Returns the pairing to store.
export function checkConnection(verified, { request, account, installId, params }) {
  const str = (v, max = 256) => typeof v === "string" && v.length > 0 && v.length <= max;
  const c = verified?.connection;
  const user = verified?.user;
  if (verified?.valid !== true || !c || !user) deny("bad_connection", "the platform did not verify the connection");
  if (!request || !sameId(c.request_id, request.request_id) || !sameId(params?.request_id, request.request_id)) {
    deny("request_gone", "the platform verified a different connect request");
  }
  if (!sameId(user.id, account?.user?.id) || !sameId(c.user_id, account?.user?.id)) {
    deny("account_mismatch", "Chrome and the Molt app are signed in to different accounts");
  }
  if (!sameId(c.browser_install_id, installId)) deny("bad_connection", "the connection was issued for another browser profile");
  if (!sameId(c.kid, params?.kid) || !sameId(c.public_key, params?.public_key)) {
    deny("bad_connection", "the app's key does not match the one the platform signed");
  }
  if (b64urlDecode(c.public_key).length !== 32) deny("bad_connection", "the app's key is not an Ed25519 public key");
  if (!str(c.machine_id)) deny("bad_connection", "the connection names no machine");
  return {
    pair_id: c.request_id,
    kid: c.kid,
    public_key: c.public_key,
    user_id: c.user_id,
    email: str(user.email) ? user.email : null,
    machine_id: c.machine_id,
    machine_name: str(c.machine_name) ? c.machine_name : null,
    browser_install_id: installId,
    verified: VERIFIED,
  };
}
