// node --test test/  — when the Molt app expects a newer extension build.
import { test } from "node:test";
import assert from "node:assert/strict";
import { compareVersions, extensionUpdate } from "../extension/update.js";

const self = { version: "0.4.0", protocol: 3 };
const bridge = (hostVersion, minProtocol = 3) => ({ connected: true, hostVersion, minProtocol });

test("compareVersions orders dotted versions and ignores dev builds", () => {
  assert.equal(compareVersions("0.4.0", "0.4.0"), 0);
  assert.equal(compareVersions("0.3.9", "0.4.0"), -1);
  assert.equal(compareVersions("0.10.0", "0.9.1"), 1);
  assert.equal(compareVersions("1.0", "1.0.0"), 0);
  assert.equal(compareVersions("0.4.0", "dev"), 0);
  assert.equal(compareVersions(undefined, "0.4.0"), 0);
});

test("up to date, or newer than the plugin, needs nothing", () => {
  assert.equal(extensionUpdate(bridge("0.4.0"), self), null);
  assert.equal(extensionUpdate(bridge("0.3.0"), self), null);
  assert.equal(extensionUpdate(bridge("dev"), self), null);
});

test("an older build than the plugin is an available update", () => {
  assert.deepEqual(extensionUpdate(bridge("0.5.0"), self), { state: "available", expected: "0.5.0" });
});

test("below the bridge's min protocol the update is required", () => {
  assert.deepEqual(extensionUpdate(bridge("0.9.0", 4), self), { state: "required", expected: "0.9.0" });
});

test("no bridge, or a bridge too old to say, shows nothing", () => {
  assert.equal(extensionUpdate({ connected: false, hostVersion: null }, self), null);
  // A 0.4.0 bridge sends no min_protocol; the version still counts.
  assert.deepEqual(extensionUpdate({ connected: true, hostVersion: "0.5.0", minProtocol: null }, self), {
    state: "available",
    expected: "0.5.0",
  });
});
