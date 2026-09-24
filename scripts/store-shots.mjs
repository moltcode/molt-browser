// Chrome Web Store screenshots: the extension driving a demo page in a
// throwaway profile, captured mid-action at 1280x800.
//
//   make build && node scripts/e2e.mjs [--headed]
//
// Starts Chrome over --remote-debugging-pipe, loads extension/ unpacked
// (Extensions.loadUnpacked), registers the native host inside the temp
// profile, serves a small test page, then runs the molt-browser CLI against
// it exactly as an agent would. Your own Chrome profile is never touched.
import { spawn, execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir, platform, arch } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const headed = process.argv.includes("--headed");
const chrome =
  process.env.CHROME ||
  (platform() === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "google-chrome");
const plat = `${platform()}-${arch() === "arm64" ? "arm64" : "x64"}`;
const bin = join(root, "dist", plat, "molt-browser");
if (!existsSync(bin)) throw new Error(`build first: ${bin} is missing`);

const tmp = mkdtempSync(join(tmpdir(), "molt-browser-e2e-"));
const profile = join(tmp, "profile");
const state = join(tmp, "state");
const hostDir = join(profile, "NativeMessagingHosts");
mkdirSync(hostDir, { recursive: true });
const env = { ...process.env, MOLT_PLUGIN_DIR: root, MOLT_PLUGIN_STATE_DIR: state, MOLT_BROWSER_HOST_DIRS: hostDir };

const html = (body) => `<!doctype html><meta charset=utf-8><title>Acme Console</title>
<style>
body{margin:0;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#1f2937;background:#f6f7fb}
header{display:flex;align-items:center;gap:12px;padding:16px 32px;background:#fff;border-bottom:1px solid #e5e7eb}
header b{font-size:18px} nav a{margin-left:20px;color:#4b5563;text-decoration:none}
main{max-width:980px;margin:32px auto;padding:0 24px}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:24px;margin-bottom:20px}
label{display:block;font-weight:600;margin:12px 0 6px} input,select{width:100%;padding:10px 12px;border:1px solid #d1d5db;border-radius:8px;font:inherit;box-sizing:border-box}
button{margin-top:18px;padding:10px 18px;border:0;border-radius:8px;background:#2563eb;color:#fff;font:600 15px inherit;font-family:inherit}
table{width:100%;border-collapse:collapse} td,th{text-align:left;padding:10px;border-bottom:1px solid #f0f0f0}
.pill{display:inline-block;padding:2px 10px;border-radius:999px;background:#dcfce7;color:#166534;font-size:13px}
</style>
<header><b>Acme Console</b><nav><a href="#">Orders</a><a href="#">Customers</a><a href="#">Settings</a></nav></header>
<main>${body}</main>`;
const pages = {
  "/": html(`<div class="card"><h2 style="margin-top:0">Invite a teammate</h2>
<label for=email>Email</label><input id=email placeholder="name@company.com">
<label for=role>Role</label><select id=role><option>Viewer</option><option>Editor</option><option>Admin</option></select>
<button id=send onclick="console.log('invite sent'); fetch('/api/invite',{method:'POST'})">Send invite</button></div>
<div class="card"><h3 style="margin-top:0">Recent orders</h3><table>
<tr><th>Order</th><th>Customer</th><th>Total</th><th>Status</th></tr>
<tr><td>#1042</td><td>Northwind</td><td>$1,280.00</td><td><span class=pill>Paid</span></td></tr>
<tr><td>#1041</td><td>Globex</td><td>$640.50</td><td><span class=pill>Paid</span></td></tr>
<tr><td>#1040</td><td>Initech</td><td>$99.00</td><td><span class=pill>Paid</span></td></tr></table></div>`),
};
const server = createServer((req, res) => {
  if (req.url.startsWith("/api/")) return res.end("{}");
  res.setHeader("content-type", "text/html");
  res.end(pages["/"]);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const proc = spawn(
  chrome,
  [
    `--user-data-dir=${profile}`,
    "--remote-debugging-pipe",
    "--enable-unsafe-extension-debugging",
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1280,800",
    ...(headed ? ["--window-position=3000,3000"] : ["--headless=new"]),
    "about:blank",
  ],
  { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] }
);
proc.stderr.on("data", () => {});

let nextId = 0;
const pending = new Map();
let buf = "";
proc.stdio[4].on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\0")) >= 0) {
    const msg = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (!msg.id && process.env.DEBUG && /Runtime\.(consoleAPICalled|exceptionThrown)/.test(msg.method)) {
      console.log("[sw]", JSON.stringify(msg.params).slice(0, 600));
    }
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

const cli = (...args) =>
  new Promise((resolve) => {
    execFile(bin, args, { env, encoding: "utf8", timeout: 30000 }, (err, stdout) => resolve(err ? null : stdout.trim()));
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const outDir = join(root, "store");
mkdirSync(outDir, { recursive: true });

async function shot(name) {
  const { targetInfos } = await cdp("Target.getTargets");
  const target = targetInfos.find((t) => t.type === "page" && t.url.startsWith(base));
  const { sessionId } = await cdp("Target.attachToTarget", { targetId: target.targetId, flatten: true });
  await cdp("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }, sessionId);
  await sleep(150);
  const png = await cdp("Page.captureScreenshot", { format: "png" }, sessionId);
  writeFileSync(join(outDir, name), Buffer.from(png.data, "base64"));
  await cdp("Target.detachFromTarget", { sessionId });
  console.log(`wrote store/${name}`);
}

try {
  await cdp("Extensions.loadUnpacked", { path: join(root, "extension") });
  await cli("setup");
  for (let i = 0; i < 20 && !(await cli("status")); i++) await sleep(1000);
  await cli("open", `${base}/`);
  let snap = await cli("snapshot");
  const email = snap.match(/\[(g\d+:e\d+)\] textbox "Email"/)[1];
  const send = snap.match(/\[(g\d+:e\d+)\] button "Send invite"/)[1];
  const typing = cli("type", email, "sam@northwind.com");
  await sleep(700);
  await shot("1-typing.png");
  await typing;
  // Capture mid-action, while the cursor label is up.
  const clicking = cli("click", send);
  await sleep(700);
  await shot("2-clicking.png");
  await clicking;
} finally {
  proc.kill();
  server.close();
  await sleep(1000);
  rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}
process.exit(0);
