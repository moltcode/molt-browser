// A Molt Auth that speaks the real protocol (molt_auth's routes the extension
// calls; Settled S17, S21 to S23, S86), for the node tests and the real-Chrome
// e2e: it checks each `molt-proof` (signature by the key in its header, `bh`,
// `htm`, `htu`, `iat`, a `jti` used once, `did` present or absent as the
// route wants), answers a sign-in's start with a nonce naming the device's
// key, wraps the session and the extension token to the device (mxw1, signed
// by its token key) and signs the extension token as `molt-browser`.
//
// `answer(method, url, headers, body)` is the core; `fetch` and `node` adapt
// it. `requests` lists every call it saw, for the dormant checks.

const subtle = globalThis.crypto.subtle;
const utf8 = (t) => new TextEncoder().encode(t);
const b64u = (bytes) => Buffer.from(bytes).toString("base64url");
const unb64u = (t) => new Uint8Array(Buffer.from(t, "base64url"));
const concat = (...parts) => new Uint8Array(Buffer.concat(parts.map((p) => Buffer.from(p))));
const sha256 = async (b) => new Uint8Array(await subtle.digest("SHA-256", b));
const now = () => Math.floor(Date.now() / 1000);

// An app code as auth makes one: two groups of five Crockford base32 letters.
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const appCode = () => {
  const r = globalThis.crypto.getRandomValues(new Uint8Array(10));
  const s = [...r].map((b) => CROCKFORD[b & 31]).join("");
  return `${s.slice(0, 5)}-${s.slice(5)}`;
};

export const thumbprint = async (x) => b64u(await sha256(utf8(`{"crv":"Ed25519","kty":"OKP","x":"${x}"}`)));
const binding = ({ purpose, jkt, jti, ref }) =>
  concat(...["mxw1", purpose, jkt, jti, ref].flatMap((f) => [new Uint8Array([utf8(f).length >> 8, utf8(f).length & 0xff]), utf8(f)]));

export async function fakeAuth({ base = "http://127.0.0.1:1", kid = "tk1", users = { u1: "me@example.com" } } = {}) {
  const tokenKey = await subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const publicX = b64u(new Uint8Array(await subtle.exportKey("raw", tokenKey.publicKey)));
  const signIns = new Map();
  const devices = new Map(); // did -> { jkt, enc, user, removed }
  const seenJti = new Set();
  const requests = [];
  const revoked = [];
  let nextId = 0;

  const self = {
    base,
    kid,
    // What a client pins: `kid:x`.
    keysText: `${kid}:${publicX}`,
    requests,
    revoked,
    devices,
    // Test knobs: the next answers changed on the way.
    // `start`: "swap" answers with the start auth made for another request
    // (ba63438d), "unsigned" drops `start_proof`, "url" points the page at
    // another host, "code" binds the app code to another sign-in.
    // `startClaims` edits the signed claims, `startTyp` signs them as another typ.
    tamper: { nonce: false, tokenBid: null, tokenRef: null, signInStatus: null, extensionStatus: null, start: null, startClaims: null, startTyp: null },
    signIns,
    // The person finishes the sign-in on auth's page as `user`.
    complete(signInId, user = Object.keys(users)[0]) {
      const s = signIns.get(signInId);
      if (!s) return false;
      s.user = user;
      return true;
    },
    removeDevice(did) {
      const d = devices.get(did);
      if (d) d.removed = true;
    },
  };

  async function sign(typ, claims) {
    const input = `${b64u(utf8(JSON.stringify({ alg: "EdDSA", kid, typ })))}.${b64u(utf8(JSON.stringify(claims)))}`;
    return `${input}.${b64u(new Uint8Array(await subtle.sign({ name: "Ed25519" }, tokenKey.privateKey, utf8(input))))}`;
  }

  async function wrap(encX, bind, secret) {
    const eph = await subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]);
    const epk = new Uint8Array(await subtle.exportKey("raw", eph.publicKey));
    const deviceEnc = unb64u(encX);
    const peer = await subtle.importKey("raw", deviceEnc, { name: "X25519" }, false, []);
    const shared = new Uint8Array(await subtle.deriveBits({ name: "X25519", public: peer }, eph.privateKey, 256));
    const ikm = await subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
    const raw = await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: concat(epk, deviceEnc), info: utf8(`molt mxw1 ${bind.purpose}`) }, ikm, 256);
    const key = await subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt"]);
    const aad = binding(bind);
    const c = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: new Uint8Array(12), additionalData: aad, tagLength: 128 }, key, utf8(secret)));
    const sig = new Uint8Array(await subtle.sign({ name: "Ed25519" }, tokenKey.privateKey, concat(utf8("molt mxw1 sig"), new Uint8Array([0]), aad, epk, c)));
    return { v: "mxw1", purpose: bind.purpose, ref: bind.ref, kid, epk: b64u(epk), c: b64u(c), sig: b64u(sig) };
  }

  // molt_auth's Proofs.check: `{ok, jkt, jti, did, x}` or `{error}`.
  async function check(method, url, headers, body) {
    const proof = headers["molt-proof"];
    const parts = typeof proof === "string" ? proof.split(".") : [];
    if (parts.length !== 3) return { error: "bad_proof" };
    let header, claims;
    try {
      header = JSON.parse(Buffer.from(parts[0], "base64url").toString());
      claims = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    } catch {
      return { error: "bad_proof" };
    }
    if (header.alg !== "EdDSA" || header.typ !== "molt-proof" || header.jwk?.crv !== "Ed25519" || header.jwk?.kty !== "OKP") return { error: "bad_proof" };
    const key = await subtle.importKey("raw", unb64u(header.jwk.x), { name: "Ed25519" }, false, ["verify"]);
    if (!(await subtle.verify({ name: "Ed25519" }, key, unb64u(parts[2]), utf8(`${parts[0]}.${parts[1]}`)))) return { error: "bad_proof" };
    // The claims as the device signs them: keys sorted, nulls left out.
    const sorted = JSON.stringify(Object.fromEntries(Object.keys(claims).sort().map((k) => [k, claims[k]])));
    if (sorted !== Buffer.from(parts[1], "base64url").toString()) return { error: "bad_proof" };
    if (claims.htm !== method || claims.htu !== url || claims.bh !== b64u(await sha256(utf8(body)))) return { error: "bad_proof" };
    if (!Number.isInteger(claims.iat) || claims.iat < now() - 60 || claims.iat > now() + 5) return { error: "stale_proof" };
    if (seenJti.has(claims.jti)) return { error: "replayed" };
    seenJti.add(claims.jti);
    return { ok: true, jkt: await thumbprint(header.jwk.x), jti: claims.jti, did: claims.did ?? null, x: header.jwk.x };
  }

  async function answer(method, url, headers, body) {
    const path = new URL(url).pathname;
    requests.push({ method, path });
    const json = (status, value) => ({ status, json: value });
    const error = (status, code) => json(status, { error: code, message: code });
    if (method === "GET" && path === "/v1/sign-in/dev") {
      // The dev provider's page, finished at once as the first user.
      const q = new URL(url).searchParams;
      return self.complete(q.get("sign_in_id"), q.get("as") || undefined) ? { status: 200, html: "Signed in." } : { status: 404, html: "No such sign-in." };
    }
    if (method !== "POST") return error(404, "not_found");
    const proof = await check(method, url, headers, body);
    if (proof.error) return error(401, proof.error);
    let req = {};
    try {
      req = body ? JSON.parse(body) : {};
    } catch {
      return error(400, "bad_request");
    }
    const device = proof.did ? devices.get(proof.did) : null;
    const signedIn = () => (!proof.did ? error(401, "bad_proof") : !device || device.removed ? error(401, "unauthorized") : device.jkt !== proof.jkt ? error(401, "bad_proof") : null);

    switch (path) {
      case "/v1/sign-in/start": {
        if (proof.did) return error(401, "bad_proof");
        if (req.device?.sig?.x !== proof.x || !req.device?.enc?.x) return error(400, "bad_request");
        const id = `si_${++nextId}`;
        const code = req.confirmation === "app_code" ? appCode() : null;
        signIns.set(id, { jkt: proof.jkt, enc: req.device.enc.x, user: null, provider: req.provider, client: req.client, code });
        const nonce = self.tamper.nonce ? "x".repeat(43) : b64u(await sha256(concat(utf8(proof.jkt), new Uint8Array([0]), utf8(id))));
        const host = self.tamper.start === "url" ? "http://127.0.0.2:1" : base;
        const reply = { sign_in_id: id, authorize_url: `${host}/v1/sign-in/dev?sign_in_id=${id}&state=s&nonce=${nonce}`, expires_in: 600, interval: 1 };
        // molt_auth's sign_start: the reply's fields plus whom it answers.
        const iat = now();
        const signedFor = self.tamper.start === "swap" ? "another-request-jti" : proof.jti;
        const claims = { ...reply, iss: "molt-auth", provider: req.provider, jkt: proof.jkt, request_jti: signedFor, iat, exp: iat + 600 };
        const start_proof = await sign(self.tamper.startTyp || "molt-sign-in-start", self.tamper.startClaims ? self.tamper.startClaims(claims) : claims);
        const ref = self.tamper.start === "code" ? `sign-in/si_other` : `sign-in/${id}`;
        const confirmation = code ? await wrap(req.device.enc.x, { purpose: "enroll-code", jkt: proof.jkt, jti: proof.jti, ref }, code) : null;
        return json(200, { ...reply, ...(self.tamper.start === "unsigned" ? {} : { start_proof }), confirmation });
      }
      case "/v1/sign-in/poll": {
        if (proof.did) return error(401, "bad_proof");
        const s = signIns.get(req.sign_in_id);
        if (!s || s.jkt !== proof.jkt) return json(200, { status: "expired" });
        if (self.tamper.signInStatus) return json(200, { status: self.tamper.signInStatus.status, reason: self.tamper.signInStatus.reason ?? null });
        if (!s.user) return json(200, { status: "pending" });
        signIns.delete(req.sign_in_id);
        let did = [...devices].find(([, d]) => d.jkt === s.jkt && !d.removed)?.[0];
        if (!did) {
          did = `dev_${++nextId}`;
          devices.set(did, { jkt: s.jkt, enc: s.enc, user: s.user, removed: false });
        }
        const sid = `sess_${++nextId}`;
        const bundle = {
          user_id: s.user,
          device_id: did,
          sid,
          access_token: "access-jws",
          access_expires_at: now() + 3600,
          refresh_token: "refresh-secret",
          refresh_expires_at: now() + 30 * 86400,
          device_cert: "cert-jws",
          email: users[s.user] ?? null,
        };
        const session = await wrap(s.enc, { purpose: "session", jkt: proof.jkt, jti: proof.jti, ref: `session/${sid}` }, JSON.stringify(bundle));
        return json(200, { status: "complete", session, reason: null });
      }
      case "/v1/browser/extension-token": {
        const refusal = signedIn();
        if (refusal) return refusal;
        if (self.tamper.extensionStatus) return error(self.tamper.extensionStatus.status, self.tamper.extensionStatus.code);
        const bid = req.browser_install_id;
        if (typeof bid !== "string" || !bid || bid.includes("/")) return error(400, "bad_request");
        const iat = now();
        const claims = { iss: "molt-auth", sub: device.user, did: proof.did, bid: self.tamper.tokenBid ?? bid, iat, exp: iat + 30 * 86400 };
        const token = await sign("molt-browser", claims);
        const ref = self.tamper.tokenRef ?? `browser/${bid}`;
        return json(200, { token: await wrap(device.enc, { purpose: "session", jkt: proof.jkt, jti: proof.jti, ref }, token), expires_at: claims.exp });
      }
      case "/v1/browser/connect-token": {
        // The app's device asks; here any signed-in device of the user.
        const refusal = signedIn();
        if (refusal) return refusal;
        const iat = now();
        const claims = {
          iss: "molt-auth", sub: device.user, did: proof.did, mid: req.machine_id, request_id: req.request_id,
          browser_install_id: req.browser_install_id, kid: req.kid, public_key: req.public_key, iat, exp: iat + 300,
          ...(req.machine_name ? { machine_name: req.machine_name } : {}),
        };
        const token = await sign("molt-browser-connect", claims);
        return json(200, { token: await wrap(device.enc, { purpose: "session", jkt: proof.jkt, jti: proof.jti, ref: `browser-connect/${req.request_id}` }, token), expires_at: claims.exp });
      }
      case "/v1/revoke": {
        const refusal = signedIn();
        if (refusal) return refusal;
        revoked.push(req.sid);
        return json(200, { ok: true });
      }
      default:
        return error(404, "not_found");
    }
  }

  /** `fetch` for the node tests: only `base`'s URLs are auth's; others go to `other`. */
  self.fetch = (other) => async (url, init = {}) => {
    if (!String(url).startsWith(base)) return other(url, init);
    const a = await answer(init.method || "GET", String(url), init.headers || {}, init.body ?? "");
    return a.html !== undefined
      ? new Response(a.html, { status: a.status, headers: { "content-type": "text/html" } })
      : new Response(JSON.stringify(a.json), { status: a.status, headers: { "content-type": "application/json" } });
  };

  /** An http.Server handler for the e2e, mounted at `base`. */
  self.node = (req, res, body) =>
    answer(req.method, `${base}${req.url}`, req.headers, body).then((a) => {
      res.statusCode = a.status;
      if (a.html !== undefined) {
        res.setHeader("content-type", "text/html");
        return res.end(`<!doctype html><title>Molt Auth</title><p>${a.html}</p>`);
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(a.json));
    });

  /** The platform's check of auth's pair (Credentials.verify_browser_pair/4), for the fake platforms. */
  self.verifyPair = async (extensionToken, connectToken) => {
    const open = async (token, typ) => {
      const [h, p, s] = String(token).split(".");
      try {
        const header = JSON.parse(Buffer.from(h, "base64url").toString());
        if (header.typ !== typ || header.kid !== kid) return null;
        if (!(await subtle.verify({ name: "Ed25519" }, tokenKey.publicKey, unb64u(s), utf8(`${h}.${p}`)))) return null;
        const c = JSON.parse(Buffer.from(p, "base64url").toString());
        return c.exp > now() ? c : null;
      } catch {
        return null;
      }
    };
    const ext = await open(extensionToken, "molt-browser");
    if (!ext) return { error: "bad_extension_token" };
    const conn = await open(connectToken, "molt-browser-connect");
    if (!conn) return { error: "bad_connect_token" };
    if (ext.sub !== conn.sub) return { error: "account_mismatch" };
    if (ext.bid !== conn.browser_install_id) return { error: "install_mismatch" };
    const { request_id, browser_install_id, kid: k, public_key, machine_name, exp } = conn;
    return { ok: { valid: true, user: { id: ext.sub }, connection: { request_id, browser_install_id, kid: k, public_key, machine_name, exp, machine_id: conn.mid, user_id: conn.sub } } };
  };

  /** A device of `user` that is the Molt app's: signs in and asks connect tokens, as browser_pairing.ex does. */
  self.appDevice = async (user) => {
    const sig = await subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const x = b64u(new Uint8Array(await subtle.exportKey("raw", sig.publicKey)));
    const did = `dev_app_${++nextId}`;
    devices.set(did, { jkt: await thumbprint(x), enc: b64u(new Uint8Array(32).fill(9)), user, removed: false });
    // The connect token, as auth signs it (its wrap is the app's to open).
    return async (connection) => {
      const iat = now();
      return sign("molt-browser-connect", {
        iss: "molt-auth", sub: user, did, mid: connection.machine_id, request_id: connection.request_id,
        browser_install_id: connection.browser_install_id, kid: connection.kid, public_key: connection.public_key, iat, exp: iat + 300,
        ...(connection.machine_name ? { machine_name: connection.machine_name } : {}),
      });
    };
  };

  return self;
}
