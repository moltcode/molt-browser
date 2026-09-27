// Whether the Molt app expects a newer build of this extension. The plugin
// and the extension ship with the same version, so the bridge's version is
// the one Molt expects; below its min_protocol the bridge refuses commands.

// Orders dotted numeric versions; anything else (a "dev" bridge) compares
// equal so it never nags.
export function compareVersions(a, b) {
  const parse = (v) => (typeof v === "string" && /^\d+(\.\d+)*$/.test(v) ? v.split(".").map(Number) : null);
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

// null when up to date, else { state: "available" | "required", expected }.
export function extensionUpdate(bridge, { version, protocol }) {
  if (!bridge?.connected || !bridge.hostVersion) return null;
  const expected = bridge.hostVersion;
  if (Number.isInteger(bridge.minProtocol) && protocol < bridge.minProtocol) return { state: "required", expected };
  if (compareVersions(version, expected) < 0) return { state: "available", expected };
  return null;
}
