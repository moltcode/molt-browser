// The extension against a real local stack: Molt's platform and Molt Auth on
// a slot of the molt checkout (molt_auth/docs/plan.md S98, S220), in a real
// Chrome with a throwaway profile.
//
//   # in the molt checkout, a slot whose walk sealed one of A's workspaces:
//   LOCAL_STACK_SLOT=5 scripts/local-stack/web-sealed-check.sh up
//   LOCAL_STACK_SLOT=5 scripts/local-stack/web-sealed-check.sh walk
//   # here:
//   make build && LOCAL_STACK_SLOT=5 MOLT_ROOT=../acp node scripts/slot-e2e.mjs
//   # then, in the molt checkout: web-sealed-check.sh down
//
// Prints `ok|fail <step> <what>`; exits 1 on any fail. Never a token, a key
// or a body.
//
// - Dormant: C (no sealed workspace) signs in at the slot's platform with the
//   extension pointed at the slot's auth edge; the service worker sends
//   nothing to that edge.
// - A (a sealed workspace): the platform answers 403 auth_required; the
//   extension signs in at the auth edge (dev provider, as local-user-a) with
//   its own device and asks its extension token there.
// - This script plays the Molt app: a device of A's at auth asks
//   `POST /v1/browser/connect-token` (browser_pairing.ex's request). A token
//   naming another Chrome install is refused by the platform's real verify
//   (403 install_mismatch) and the popup asks to connect again; the right one
//   pairs, and sign-out revokes the session at auth.
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { arch, platform, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { authClient, authConfig, b64url, deviceProof, ensureDevice, openWrap } from "../extension/molt-auth.js";

const root = resolve(import.meta.dirname, "..");
const MOLT_ROOT = resolve(process.env.MOLT_ROOT || join(root, "..", "acp"));
const lib = (name) => import(pathToFileURL(join(MOLT_ROOT, "scripts/local-stack/lib", name)).href);
const { AUTH_EDGE, NODE_1, TOKENS } = await lib("ports.mjs");
const { readTokens } = await lib("rpc.mjs");

const chrome =
  process.env.CHROME || (platform() === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "google-chrome");
const bin = join(root, "dist", `${platform()}-${arch() === "arm64" ? "arm64" : "x64"}`, "molt-browser");
const OUT = process.env.OUT || join(MOLT_ROOT, "tmp/e2e/browser-slot");
mkdirSync(OUT, { recursive: true });

let failures = 0;
const step = (ok, id, what) => {
  console.log(`${ok ? "ok" : "fail"} extension-auth.${id} ${what}`);
  if (!ok) failures++;
  return ok;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (read, tries = 60, ms = 250) => {
  for (let i = 0; i < tries; i++) {
    const v = await read();
    if (v) return v;
    await sleep(ms);
  }
  return null;
};

if (!existsSync(bin)) throw new Error(`build first: ${bin} is missing`);
const { token: tokenOf } = readTokens(TOKENS);
const jwt = { a: tokenOf("a@molt.local"), c: tokenOf("c@molt.local") };
const sessionOf = async (t) => (await (await fetch(`${NODE_1}/api/auth/session`, { headers: { authorization: `Bearer ${t}` } })).json().catch(() => ({})));
const aSession = await sessionOf(jwt.a);
const cSession = await sessionOf(jwt.c);
if (!step(aSession?.auth?.required === true, "setup.a-sealed", "A's session answer names auth (one of A's workspaces is sealed; run web-sealed-check.sh walk first)")) process.exit(1);
step(!cSession?.auth, "setup.c-plain", "C's session answer has no auth block");
const jwks = await (await fetch(`${AUTH_EDGE}/.well-known/jwks.json`)).text();
const config = authConfig({ authUrl: AUTH_EDGE, authKeys: jwks });
if (!step(!!config, "setup.jwks", "the auth edge's JWKS pins a token key")) process.exit(1);

// -- Chrome, as scripts/e2e.mjs drives it -----------------------------------------
const tmp = mkdtempSync(join(tmpdir(), "molt-browser-slot-"));
const profile = join(tmp, "profile");
const state = join(tmp, "state");
const hostDir = join(profile, "NativeMessagingHosts");
mkdirSync(hostDir, { recursive: true });
const env = { ...process.env, MOLT_PLUGIN_DIR: root, MOLT_PLUGIN_STATE_DIR: state, MOLT_BROWSER_HOST_DIRS: hostDir };
const proc = spawn(
  chrome,
  [`--user-data-dir=${profile}`, "--remote-debugging-pipe", "--enable-unsafe-extension-debugging", "--no-first-run", "--no-default-browser-check", "--use-mock-keychain", "--headless=new", "about:blank"],
  { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"], env }
);
proc.stderr.on("data", () => {});
let nextId = 0;
const pending = new Map();
const swRequests = [];
let buf = "";
proc.stdio[4].on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\0")) >= 0) {
    const msg = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (msg.method === "Network.requestWillBeSent") swRequests.push(msg.params.request.url);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});
const cdp = (method, params = {}, sessionId) =>
  new Promise((res, rej) => {
    const id = ++nextId;
    pending.set(id, (m) => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result)));
    proc.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + "\0");
  });
const runCli = (args, timeout = 30000) =>
  new Promise((done) => execFile(bin, args, { env, encoding: "utf8", timeout }, (err, stdout) => done(err ? null : stdout.trim())));
const evalIn = async (sessionId, expression) =>
  (await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId)).result?.value;

// The script's own device of A's at auth: the Molt app's part of the pairing.
async function appDevice() {
  const store = new Map();
  const s = { get: async (k) => store.get(k), set: async (k, v) => void store.set(k, v), delete: async (k) => void store.delete(k) };
  const api = authClient({ fetch, store: s, config });
  const start = await api.startSignIn("dev");
  const page = await fetch(`${start.url}&as=a`);
  if (page.status !== 200) throw new Error(`dev sign-in page ${page.status}`);
  let done = null;
  for (let i = 0; i < 30 && done?.status !== "complete"; i++) {
    done = await api.pollSignIn(start.id);
    if (done.status !== "complete") await sleep(1000);
  }
  if (done?.status !== "complete") throw new Error(`app sign-in ${done?.status}`);
  return async (connection) => {
    const device = await ensureDevice(s);
    const raw = JSON.stringify(connection);
    const jti = b64url(crypto.getRandomValues(new Uint8Array(16)));
    const url = `${config.base}/v1/browser/connect-token`;
    const proof = await deviceProof(device, { did: device.did, htm: "POST", htu: url, iat: Math.floor(Date.now() / 1000), jti }, new TextEncoder().encode(raw));
    const res = await fetch(url, { method: "POST", headers: { "molt-proof": proof, "content-type": "application/json" }, body: raw });
    const body = await res.json();
    if (res.status !== 200) throw new Error(`connect-token ${res.status} ${body.error}`);
    return new TextDecoder().decode(await openWrap(body.token, device, config.keys, { purpose: "session", jti, ref: `browser-connect/${connection.request_id}` }));
  };
}

const appKey = b64url(crypto.getRandomValues(new Uint8Array(32)));
try {
  const { id: extId } = await cdp("Extensions.loadUnpacked", { path: join(root, "extension") });
  await runCli(["setup"]);
  step(!!(await until(async () => (await runCli(["status"]))?.includes("connected ("), 40, 500)), "bridge", "the native bridge connects");
  const sw = async () => {
    const { targetInfos } = await cdp("Target.getTargets");
    const t = targetInfos.find((x) => x.type === "service_worker" && x.url.includes(extId));
    return (await cdp("Target.attachToTarget", { targetId: t.targetId, flatten: true })).sessionId;
  };
  const swSession = await sw();
  await cdp("Network.enable", {}, swSession);
  const swEval = (expression) => evalIn(swSession, expression);
  await swEval(`chrome.storage.local.set(${JSON.stringify({ platformUrl: NODE_1, authUrl: AUTH_EDGE, authKeys: jwks })})`);
  const { targetId: popupTarget } = await cdp("Target.createTarget", { url: `chrome-extension://${extId}/popup.html` });
  const { sessionId: popup } = await cdp("Target.attachToTarget", { targetId: popupTarget, flatten: true });
  const inPopup = (e) => evalIn(popup, e);
  const shot = async (name) => {
    const h = await inPopup("document.body.scrollHeight");
    const { data } = await cdp("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: 320, height: h, scale: 2 } }, popup);
    writeFileSync(join(OUT, `${name}.png`), Buffer.from(data, "base64"));
  };
  // The platform's redirect login, as it returns: signed-in.html with this browser's state and the person's token.
  const landWith = async (token) => {
    const st = crypto.randomUUID();
    await swEval(`chrome.storage.session.set({ signInState: { state: ${JSON.stringify(st)}, expires_at: Date.now() + 600000 } })`);
    const { targetId } = await cdp("Target.createTarget", { url: `chrome-extension://${extId}/signed-in.html?state=${st}&token=${encodeURIComponent(token)}` });
    const { sessionId } = await cdp("Target.attachToTarget", { targetId, flatten: true });
    return { targetId, sessionId };
  };
  const toEdge = () => swRequests.filter((u) => u.startsWith(AUTH_EDGE));

  // Dormant: C.
  const c = await landWith(jwt.c);
  const cDone = await until(() => evalIn(c.sessionId, `!document.getElementById("done").hidden && document.getElementById("who").textContent`));
  step(!!cDone && cDone.includes("c@molt.local"), "dormant.signed-in", "C signs in at the platform as today");
  step(toEdge().length === 0, "dormant.no-auth", `the extension sent nothing to the auth edge (${toEdge().length} requests)`);
  await cdp("Target.closeTarget", { targetId: c.targetId });
  await inPopup(`document.getElementById("sign-out").click()`);
  step(!!(await until(() => inPopup(`!document.getElementById("sign-in").hidden`))), "dormant.signed-out", "C signs out");

  // A: the platform sends the extension to auth.
  const a = await landWith(jwt.a);
  const offered = await until(() => evalIn(a.sessionId, `!document.getElementById("auth").hidden && !document.getElementById("auth-dev").hidden`));
  step(!!offered, "sealed.auth-required", "A's sign-in: the platform answers auth_required and the page offers Molt Auth");
  step(toEdge().length === 0, "sealed.no-auth-yet", "nothing reaches auth before the person chooses");
  await shot("1-auth-choose");
  await evalIn(a.sessionId, `document.getElementById("auth-dev").click()`);
  // The dev provider's page lists the slot's users: A's link.
  const devPage = await until(() => evalIn(a.sessionId, `location.href.includes("/v1/sign-in/dev") && [...document.querySelectorAll("a")].find((x) => x.textContent.includes("local-user-a"))?.href`));
  step(!!devPage, "sealed.dev-page", "auth's dev sign-in page opens in the tab after the nonce check");
  if (devPage) await evalIn(a.sessionId, `location.href = ${JSON.stringify(devPage)}`);
  const signedIn = await until(() => inPopup(`document.getElementById("step-account").className === "done"`), 120, 500);
  step(!!signedIn, "sealed.signed-in", "the poll completes and the extension holds auth's token for A");
  const held = await swEval(`chrome.storage.local.get(["account", "authSession"]).then((s) => ({ auth: s.account?.auth === true, user: s.account?.user?.id ?? null, keys: Object.keys(s.authSession || {}).sort().join(",") }))`);
  step(held?.auth && held.user === "local-user-a" && held.keys === "device_id,email,sid,user_id", "sealed.held", `the account is auth's, A's, with no session token kept (${held?.user})`);
  const tokenCalls = toEdge().filter((u) => u.endsWith("/v1/browser/extension-token")).length;
  step(tokenCalls === 1, "sealed.extension-token", `one POST /v1/browser/extension-token through the edge (${tokenCalls})`);
  await cdp("Target.closeTarget", { targetId: a.targetId }).catch(() => {});

  // The Molt app's side, from auth.
  const app = await appDevice();
  const ask = async () => {
    const watching = runCli(["watch", "--json", "--timeout", "15"], 25000);
    await sleep(300);
    await inPopup(`document.getElementById("connect").click()`);
    return JSON.parse((await watching) || "{}").request;
  };
  let request = await ask();
  step(request?.user?.id === "local-user-a", "pair.request", "the app gets Chrome's connect request with A's id");
  const other = await app({ machine_id: "slot-proof-machine", request_id: request.request_id, browser_install_id: "another-install", kid: "k1", public_key: appKey, machine_name: "Slot proof" });
  step((await runCli(["connect", JSON.stringify({ request_id: request.request_id, kid: "k1", public_key: appKey, token: other })])) === null, "pair.install-mismatch", "auth's connect token for another install is refused by the platform's verify");
  const again = await until(() => inPopup(`!document.getElementById("connect-again").hidden`));
  step(!!again, "pair.connect-again", "the popup asks to connect the Molt app again; the sign-in stays");
  await shot("2-connect-again");
  request = await ask();
  const right = await app({ machine_id: "slot-proof-machine", request_id: request.request_id, browser_install_id: request.browser_install_id, kid: "k1", public_key: appKey, machine_name: "Slot proof" });
  const ack = JSON.parse((await runCli(["connect", JSON.stringify({ request_id: request.request_id, kid: "k1", public_key: appKey, token: right })])) || "{}");
  step(ack.connected === true && ack.user_id === "local-user-a" && ack.machine_id === "slot-proof-machine", "pair.connected", "auth's pair, verified by the slot's platform, connects this browser");
  await shot("3-connected");

  const before = toEdge().filter((u) => u.endsWith("/v1/revoke")).length;
  await inPopup(`document.getElementById("sign-out").click()`);
  const revoked = await until(() => toEdge().filter((u) => u.endsWith("/v1/revoke")).length > before);
  step(!!revoked, "sign-out", "signing out in the extension revokes its session at auth");
} catch (e) {
  step(false, "stopped", e.message.slice(0, 160));
} finally {
  proc.kill();
  await sleep(1000);
  if (failures === 0) rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  else console.log(`kept ${tmp}`);
}
console.log(failures ? `extension slot proof: ${failures} failure(s), shots in ${OUT}` : `extension slot proof: all passed, shots in ${OUT}`);
process.exit(failures ? 1 : 0);
