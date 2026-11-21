// node --test test/  — the package's Molt Auth edge and pins (scripts/apps-env.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { bake, checkLive, readAppsEnv } from "../scripts/apps-env.mjs";
import { parseAuthKeys } from "../extension/molt-auth.js";

const root = resolve(import.meta.dirname, "..");
const X = Buffer.alloc(32, 7).toString("base64url");
const key = (kid, extra = {}) => ({ kid, kty: "OKP", crv: "Ed25519", x: X, alg: "EdDSA", use: "sig", ...extra });
const envText = (url, keys) => `MOLT_AUTH_URL=${url}\nMOLT_AUTH_PUBLIC_KEYS='${JSON.stringify({ keys })}'\n`;
const run = (env) =>
  new Promise((done) =>
    execFile(process.execPath, [join(root, "scripts/apps-env.mjs"), ...env.files], { env: { PATH: process.env.PATH, ...env.vars } }, (err, stdout, stderr) =>
      done({ code: err ? err.code : 0, stdout, stderr })
    )
  );

test("apps.env: the public pair is read under the release loader's rules", () => {
  const s = readAppsEnv(envText("https://id.moltcode.com/", [key("tk1")]));
  assert.equal(s.url, "https://id.moltcode.com");
  assert.deepEqual(s.keys, { keys: [key("tk1")] });
  for (const [why, text] of [
    ["http", envText("http://id.moltcode.com", [key("tk1")])],
    ["no keys", "MOLT_AUTH_URL=https://id.moltcode.com\n"],
    ["a private key", envText("https://id.moltcode.com", [key("tk1", { d: X })])],
    ["five keys", envText("https://id.moltcode.com", ["a", "b", "c", "d", "e"].map((k) => key(k)))],
    ["the same kid twice", envText("https://id.moltcode.com", [key("tk1"), key("tk1")])],
    ["production pins without the offline key", envText("https://id.moltcode.com", [key("tk-prod-1")])],
    ["a short key", envText("https://id.moltcode.com", [key("tk1", { x: "AAAA" })])],
  ]) assert.throws(() => readAppsEnv(text), /apps-env:/, why);
});

test("apps.env: the edge must serve exactly the pins", async () => {
  const s = readAppsEnv(envText("https://id.moltcode.com", [key("tk1")]));
  const serve = (doc) => async () => new Response(JSON.stringify(doc));
  await checkLive(s, serve({ keys: [key("tk1")] }));
  await assert.rejects(checkLive(s, serve({ keys: [key("tk2")] })), /do not match/);
  await assert.rejects(checkLive(s, async () => { throw new Error("down"); }), /could not verify/);
});

test("apps.env: the packaged molt-auth.js carries the edge and pins; the source tree carries none", () => {
  const source = readFileSync(join(root, "extension/molt-auth.js"), "utf8");
  assert.match(source, /^export const AUTH_URL = null;$/m, "the source tree stays dormant");
  const baked = bake(source, readAppsEnv(envText("https://id.moltcode.com", [key("tk1")])));
  const url = baked.match(/^export const AUTH_URL = (.*);$/m)[1];
  const keys = baked.match(/^export const AUTH_KEYS = (.*);$/m)[1];
  assert.equal(JSON.parse(url), "https://id.moltcode.com");
  assert.deepEqual(Object.keys(parseAuthKeys(JSON.parse(keys))), ["tk1"]);
  assert.throws(() => bake(baked, readAppsEnv(envText("https://id.moltcode.com", [key("tk1")]))), /no unset/, "never baked twice");
});

test("apps.env: without MOLT_APPS_ENV the package is refused and nothing is written", async () => {
  const dir = mkdtempSync(join(tmpdir(), "apps-env-"));
  try {
    const file = join(dir, "molt-auth.js");
    writeFileSync(file, readFileSync(join(root, "extension/molt-auth.js")));
    const before = readFileSync(file, "utf8");
    const r = await run({ files: [file], vars: {} });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no MOLT_APPS_ENV/);
    assert.equal(readFileSync(file, "utf8"), before);
    const missing = await run({ files: [file], vars: { MOLT_APPS_ENV: join(dir, "none.env") } });
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /is not a file/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
