// Builds Molt Auth's edge and pinned keys into a packaged extension.
//
//   MOLT_APPS_ENV=<apps.env> node scripts/apps-env.mjs <molt-auth.js>...
//
// apps.env is the public file molt_auth's release-settings.py writes from the
// ceremony's pins (MOLT_AUTH_URL, MOLT_AUTH_PUBLIC_KEYS), the same one the
// app lanes read through the molt checkout's scripts/lib/release-auth.sh. It
// is read, never sourced, and held to the same rules: an https URL, a JWKS of
// one to four public Ed25519 keys with distinct kids, production pins only
// with the offline rotation key, and exactly the keys that edge serves now.
// Without MOLT_APPS_ENV the package is refused: the platform keeps no sign-in
// of its own, so an extension with no auth edge could not sign in.
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const CAP = 16 * 1024;

export function readAppsEnv(text) {
  if (Buffer.byteLength(text) > CAP) throw new Error("apps-env: public settings exceed 16 KiB");
  const values = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const at = line.indexOf("=");
    let value = line.slice(at + 1);
    if (value.length >= 2 && value[0] === value.at(-1) && (value[0] === "'" || value[0] === '"')) value = value.slice(1, -1);
    values[line.slice(0, at)] = value;
  }
  const url = values.MOLT_AUTH_URL || "";
  if (!url.startsWith("https://") || /\s/.test(url)) throw new Error("apps-env: MOLT_AUTH_URL must be an https URL");
  let doc;
  try {
    doc = JSON.parse(values.MOLT_AUTH_PUBLIC_KEYS || "");
  } catch {
    throw new Error("apps-env: MOLT_AUTH_PUBLIC_KEYS must be a JWKS");
  }
  const keys = Array.isArray(doc?.keys) ? doc.keys : null;
  if (!keys || keys.length < 1 || keys.length > 4) throw new Error("apps-env: MOLT_AUTH_PUBLIC_KEYS must be a JWKS of 1 to 4 keys");
  const kids = new Set(keys.map((k) => k?.kid));
  const prodPins = [...kids].some((kid) => typeof kid === "string" && kid.startsWith("tk-prod-"));
  if (kids.size !== keys.length || prodPins !== kids.has("tk-rotation-1")) throw new Error("apps-env: production pins require distinct online and offline kids");
  for (const k of keys) {
    if (k?.kty !== "OKP" || k?.crv !== "Ed25519" || "d" in k || !k?.kid || typeof k?.x !== "string") throw new Error("apps-env: every pinned key is a public Ed25519 key with a kid");
    if (Buffer.from(k.x, "base64url").length !== 32) throw new Error("apps-env: a pinned key is not 32 bytes");
  }
  return { url: url.replace(/\/+$/, ""), keys: { keys } };
}

const normalized = (doc) =>
  (Array.isArray(doc?.keys) ? doc.keys : [])
    .map((k) => JSON.stringify(Object.fromEntries(Object.keys(k).sort().map((n) => [n, k[n]]))))
    .sort();

/** The edge must serve exactly these pins now, or the package would pin keys nobody signs with. */
export async function checkLive({ url, keys }, fetchImpl = fetch) {
  let served;
  try {
    const res = await fetchImpl(`${url}/.well-known/jwks.json`, { signal: AbortSignal.timeout(15000) });
    const text = await res.text();
    if (!res.ok || Buffer.byteLength(text) > CAP) throw new Error("bad answer");
    served = JSON.parse(text);
  } catch {
    throw new Error("apps-env: could not verify the configured auth edge's public keys");
  }
  if (JSON.stringify(normalized(served)) !== JSON.stringify(normalized(keys))) throw new Error("apps-env: pins do not match the configured auth edge");
}

/** molt-auth.js with this build's edge and pins in place of the source tree's none. */
export function bake(source, { url, keys }) {
  const urlLine = "export const AUTH_URL = null;";
  const keysLine = 'export const AUTH_KEYS = "";';
  if (source.split(urlLine).length !== 2 || source.split(keysLine).length !== 2) throw new Error("apps-env: molt-auth.js has no unset AUTH_URL and AUTH_KEYS to fill");
  return source
    .replace(urlLine, `export const AUTH_URL = ${JSON.stringify(url)};`)
    .replace(keysLine, `export const AUTH_KEYS = ${JSON.stringify(JSON.stringify(keys))};`);
}

async function main(files) {
  const path = process.env.MOLT_APPS_ENV;
  if (!path) {
    throw new Error(
      "apps-env: no MOLT_APPS_ENV; name the apps.env with auth's edge and pinned keys (production's, or staging's for a package that is never published). A package without them cannot sign in."
    );
  }
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new Error(`apps-env: MOLT_APPS_ENV ${path} is not a file`);
  }
  const settings = readAppsEnv(text);
  await checkLive(settings);
  if (files.length === 0) throw new Error("apps-env: name the packaged molt-auth.js files to fill");
  for (const file of files) writeFileSync(file, bake(readFileSync(file, "utf8"), settings));
  console.log(`apps-env: this package signs in at ${settings.url} with ${settings.keys.keys.length} pinned key(s)`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
