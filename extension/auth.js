// Pairing and grant verification.
//
// The extension is paired to one Molt backend and one signed-in platform user.
// Pairing stores the backend's Ed25519 *public* key; the private key never
// leaves the backend, so nothing in this profile can mint a grant. Every drive
// command carries a short-lived grant signed by that key; it is checked here
// before any handler runs, and the verified session id is the only one tab
// ownership ever sees.
//
// Token format: base64url(JSON claims) "." base64url(Ed25519 signature over
// the first segment's ASCII bytes).

export const PROTOCOL = 2;
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
  if (!pairing?.public_key) deny("unpaired", "this browser is not paired with Molt. Pair it from Molt → Plugins → Browser (Chrome).");
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
    deny("pair_mismatch", "grant was issued for a different pairing; re-pair Chrome from Molt → Plugins → Browser (Chrome)");
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

// Pair offers carry only public data: the backend's verification key and the
// identity the desktop shows next to the same code.
export function checkOffer(o, now = Math.floor(Date.now() / 1000)) {
  const str = (v, max = 256) => typeof v === "string" && v.length > 0 && v.length <= max;
  if (!o || typeof o !== "object") deny("bad_offer", "pair offer is not an object");
  for (const k of ["pair_id", "nonce", "kid", "public_key", "user_id", "machine_id"]) {
    if (!str(o[k])) deny("bad_offer", `pair offer is missing ${k}`);
  }
  if (!/^\d{6}$/.test(o.code || "")) deny("bad_offer", "pair offer code must be 6 digits");
  if (b64urlDecode(o.public_key).length !== 32) deny("bad_offer", "pair offer key is not an Ed25519 public key");
  if (!Number.isInteger(o.expires_at) || o.expires_at <= now || o.expires_at > now + 300) {
    deny("bad_offer", "pair offer is expired or too long-lived");
  }
  return {
    pair_id: o.pair_id,
    nonce: o.nonce,
    code: o.code,
    kid: o.kid,
    public_key: o.public_key,
    user_id: o.user_id,
    email: str(o.email) ? o.email : null,
    machine_id: o.machine_id,
    machine_name: str(o.machine_name) ? o.machine_name : null,
    expires_at: o.expires_at,
  };
}
