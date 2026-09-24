// End-to-end check against a real Chrome, in a throwaway profile.
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

const page = `<!doctype html><title>Molt e2e</title>
<body style="font:16px sans-serif;padding:40px;height:3000px">
<h1 id=h>Molt e2e</h1>
<input id=name placeholder="Your name">
<button id=go onclick="document.getElementById('h').textContent='Hello, '+document.getElementById('name').value; console.log('clicked', 42); fetch('/api/ping')">Greet</button>
<a href="/two">Second page</a>
<input type=file id=file style="display:none" onchange="document.title='got '+this.files[0].name">
<button style="position:absolute;top:2400px">Far button</button>
<script>console.warn('page ready')</script></body>`;
// A form with every kind of field fill handles, including a custom dropdown
// and an upload button whose file input is detached from the document.
// autocomplete=off: headless Chrome drops the debugger when a click lands
// while its autofill popup closes (a real window doesn't).
const form = `<!doctype html><title>Form</title><body style="font:16px sans-serif;padding:30px">
<label for=email>Email</label> <input id=email autocomplete=off><br><br>
<label for=role>Role</label> <select id=role><option>Viewer</option><option>Editor</option><option>Admin</option></select><br><br>
<div id=plan role=combobox aria-label="Plan" tabindex=0 style="border:1px solid #999;padding:6px;width:160px"
  onclick="document.getElementById('plans').hidden=false">Pick a plan</div>
<ul id=plans role=listbox hidden>
  <li role=option onclick="plan.textContent='Free';plans.hidden=true">Free</li>
  <li role=option onclick="plan.textContent='Pro';plans.hidden=true">Pro</li>
</ul>
<label><input type=checkbox id=agree> Agree to terms</label><br><br>
<label for=avatar>Avatar</label> <input type=file id=avatar><br><br>
<button id=pick onclick="const i=document.createElement('input');i.type='file';i.onchange=()=>{window.picked=i.files[0].name};i.click()">Pick file</button>
<button onclick="const $=(id)=>document.getElementById(id);window.result={email:$('email').value,role:$('role').value,plan:$('plan').textContent,agree:$('agree').checked,avatar:$('avatar').files[0]?.name,picked:window.picked}">Submit</button>
</body>`;
const server = createServer((req, res) => {
  if (req.url === "/api/ping") return res.end(JSON.stringify({ pong: true }));
  if (req.url === "/form") {
    res.setHeader("content-type", "text/html");
    return res.end(form);
  }
  if (req.url === "/two") return res.end("<title>Two</title><p>second page</p>");
  res.setHeader("content-type", "text/html");
  res.end(page);
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
    "--window-size=1200,800",
    ...(headed ? ["--window-position=3000,3000"] : ["--headless=new"]),
    "about:blank",
  ],
  // Chrome passes its environment to the native host; the test host must
  // never see the user's own browser.
  { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"], env }
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

let failures = 0;
// Async on purpose: the test page is served from this process.
const cli = (...args) =>
  new Promise((resolve) => {
    execFile(bin, args, { env, encoding: "utf8", timeout: 30000 }, (err, stdout, stderr) => {
      console.log(`$ molt-browser ${args.join(" ")}\n${(stdout + stderr).trim()}\n`);
      resolve(err ? null : stdout.trim());
    });
  });
const expect = (ok, what) => {
  console.log(ok ? `ok   ${what}` : `FAIL ${what}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const { id: extId } = await cdp("Extensions.loadUnpacked", { path: join(root, "extension") });
  expect(extId === "gajikdfpamklabiiaonmdeamjabehoig", `extension loaded with the pinned id (${extId})`);
  (await cli("setup"));
  if (process.env.DEBUG) {
    await sleep(500);
    const { targetInfos } = await cdp("Target.getTargets");
    const sw = targetInfos.find((t) => t.type === "service_worker" && t.url.includes(extId));
    const { sessionId } = await cdp("Target.attachToTarget", { targetId: sw.targetId, flatten: true });
    await cdp("Runtime.enable", {}, sessionId);
  }

  let status = null;
  for (let i = 0; i < 20 && !status; i++) {
    await sleep(1000);
    status = (await cli("status"));
  }
  expect(status?.includes("connected ("), "bridge connects");

  if (!process.env.FORM_ONLY) {
  const opened = (await cli("open", `${base}/`, ...(process.env.FOCUS ? ["--focus"] : [])));
  expect(opened?.includes("opened tab"), "open creates a tab");
  const tabId = opened?.match(/tab (\d+)/)?.[1];

  let snap = (await cli("snapshot"));
  expect(/\[g1:e\d+\] textbox "Your name"/.test(snap || ""), "snapshot lists the input with a ref");
  expect(/offscreen/.test(snap || ""), "snapshot reports offscreen elements");
  const input = snap.match(/\[(g1:e\d+)\] textbox/)[1];
  const button = snap.match(/\[(g1:e\d+)\] button "Greet"/)[1];

  const typed = await cli("type", input, "Stewie");
  expect(typed?.includes("typed 6"), "type into ref");
  expect(/\[g2:e\d+\] textbox "Your name" value="Stewie"/.test(typed || ""), "an action prints the page with fresh refs");
  expect((await cli("click", button)) === null, "refs from before an action are stale afterwards");
  expect((await cli("click", "Greet"))?.includes('clicked button "Greet"'), "click by visible name");
  const h = (await cli("eval", "document.getElementById('h').textContent"));
  expect(h === '"Hello, Stewie"', "trusted click ran the page handler");

  snap = await cli("snapshot");
  const fresh = snap.match(/\[(g\d+:e\d+)\] button "Greet"/)[1];
  expect((await cli("click", fresh, "--no-page")) !== null, "a ref from the latest output works");

  const shot = (await cli("screenshot", "--json"));
  const capture = shot && JSON.parse(shot);
  expect(capture?.width > 0 && existsSync(capture.path), "screenshot writes a PNG with a capture id");

  expect((await cli("upload", "--selector", "#file", join(root, "icon.png")))?.includes("attached 1 file"), "upload to a hidden file input");
  expect((await cli("eval", "document.title")) === '"got icon.png"', "page saw the uploaded file");

  const consoleOut = (await cli("console"));
  expect(consoleOut?.includes("clicked 42"), "console captured page logs");
  const net = (await cli("network", "--filter", "/api/"));
  expect(net?.includes("/api/ping") && net.includes('"status":200'), "network captured the fetch");

  const scrolled = await cli("scroll", "down", "--pages", "2");
  expect(scrolled?.includes("scrolled down"), "scroll");
  await sleep(1500);
  const y = scrolled?.match(/to (\d+)\//)?.[1];
  expect((await cli("eval", "Math.round(scrollY)")) === y, "scroll lands once (no replayed wheel events)");
  expect((await cli("press", "Tab"))?.includes("pressed Tab"), "press key");
  expect((await cli("navigate", `${base}/two`))?.includes("Two"), "navigate");
  expect((await cli("text"))?.includes("second page"), "text");
  expect((await cli("back"))?.includes("went back"), "back");

  // The overlay stays visible after actions; capture it from outside.
  snap = (await cli("snapshot"));
  const greet = snap.match(/\[(g\d+:e\d+)\] button "Greet"/)[1];
  (await cli("click", greet));
  const { targetInfos } = await cdp("Target.getTargets");
  const target = targetInfos.find((t) => t.type === "page" && t.url.startsWith(base));
  const { sessionId } = await cdp("Target.attachToTarget", { targetId: target.targetId, flatten: true });
  const png = await cdp("Page.captureScreenshot", { format: "png" }, sessionId);
  const overlayShot = join(state, "overlay.png");
  writeFileSync(overlayShot, Buffer.from(png.data, "base64"));
  console.log(`overlay screenshot: ${overlayShot}`);

  // Stop from the page's pill equivalent: the popup/overlay message path.
  expect((await cli("tabs"))?.includes(" molt"), "tabs marks the agent tab");
  expect((await cli("release"))?.includes(`released tab ${tabId}`), "release detaches");

  }
  // A whole form in three calls: open, fill, click. No snapshot, no refs,
  // no OS file picker.
  const formTab = (await cli("open", `${base}/form`, "--no-page"))?.match(/tab (\d+)/)?.[1];
  // The agent's tab stays in the background: another tab is in front, and
  // the form tab is hidden before the agent touches it. Checked from outside
  // (raw DevTools), since attaching changes what the page reports.
  const { targetInfos: pages } = await cdp("Target.getTargets");
  const front = pages.find((t) => t.type === "page" && !t.url.includes("/form"));
  const formTarget = pages.find((t) => t.type === "page" && t.url.includes("/form"));
  await cdp("Target.activateTarget", { targetId: front.targetId });
  await sleep(300);
  const visibility = async (target) => {
    const { sessionId } = await cdp("Target.attachToTarget", { targetId: target.targetId, flatten: true });
    const r = await cdp("Runtime.evaluate", { expression: "document.visibilityState", returnByValue: true }, sessionId);
    await cdp("Target.detachFromTarget", { sessionId });
    return r.result.value;
  };
  if (headed) expect((await visibility(formTarget)) === "hidden", "the agent's tab starts hidden in the background");
  const filled = await cli("fill", "--tab", formTab, "Email", "sam@x.com", "Role", "Admin", "Plan", "Pro", "Agree to terms", "true", "Avatar", join(root, "icon.png"), "Pick file", join(root, "icon.png"));
  expect(filled?.includes("filled 6 field(s)"), "one fill: text, select, custom dropdown, checkbox, file input and upload button");
  expect(filled?.includes('via button "Pick file"'), "the upload button's file chooser is intercepted, no OS picker");
  expect(/\[g\d+:e\d+\] button "Submit"/.test(filled || ""), "fill prints the page afterwards");
  await cli("click", "--tab", formTab, "Submit", "--no-page");
  const result = JSON.parse((await cli("eval", "--tab", formTab, "JSON.stringify(window.result)")) || '""');
  const got = result ? JSON.parse(result) : {};
  if (headed) expect((await visibility(front)) === "visible", "the user's tab stayed in front the whole time");
  expect(got.email === "sam@x.com" && got.role === "Admin" && got.plan === "Pro" && got.agree === true, "form values landed");
  expect(got.avatar === "icon.png" && got.picked === "icon.png", "both uploads landed without a file picker");
  const ambiguous = await cli("click", "--tab", formTab, "i");
  expect(ambiguous === null, "an ambiguous name is refused instead of guessed");
} finally {
  proc.kill();
  server.close();
  await sleep(1000);
  if (failures === 0 && !process.env.KEEP) rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  else console.log(`kept ${tmp}`);
}
console.log(failures ? `\n${failures} failure(s)` : "\nall passed");
process.exit(failures ? 1 : 0);
