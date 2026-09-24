# molt-browser

Lets Molt agents drive and debug **your real Chrome**: your profile, your
logins, your open tabs. Every action shows an agent cursor in the page, the
tab glows while an agent has it, and a **Stop** pill hands control back to you.

```
agent → molt-browser CLI → unix socket → native messaging host → Molt extension → Chrome
```

No TCP port is ever opened. The CLI and the native messaging host are the same
Go binary. Chrome starts the host when the extension connects, and the host
listens on a private socket in Molt's plugin state directory.

## What it adds

- `molt-browser` on every agent's PATH, through `~/.moltcode/bin`.
- The `molt-browser` skill, which teaches agents the snapshot → ref → act
  loop and the rules around Stop.
- The Molt Code Browser extension (`extension/`, Manifest V3).

## Install

1. In Molt Code, open **Plugins → Browser (Chrome) → Install**.
2. Install the extension:
   - **Chrome Web Store:** submitted for review.
   - **Unpacked, for now:** run `molt-browser setup`. It registers the native
     host with every Chromium-family browser it finds (Chrome, Chromium,
     Brave, Edge, Arc) and prints the extension folder. Open
     `chrome://extensions`, turn on Developer mode, click **Load unpacked**
     and pick that folder. The extension id is always
     `gajikdfpamklabiiaonmdeamjabehoig`.
3. `molt-browser status` should print `extension: connected`.

## Commands

```
molt-browser status | setup | tabs
molt-browser open <url> [--focus] | navigate <url> | back | forward | reload | focus | release
molt-browser snapshot [--limit N] [--offset N] [--all]
molt-browser text [--max N] | screenshot [--out FILE]
molt-browser click <ref> | --selector CSS | --xy X,Y --capture ID
molt-browser type [<ref>] <text> [--clear] [--submit]
molt-browser press <key> | scroll [down|up] [--pages N] | scroll --to <ref>
molt-browser console | network [--filter S] | body <request-id> | eval <js>
```

All commands accept `--tab ID`, `--json` and `--timeout SECONDS`.

## How it works

- **Actions** go through `chrome.debugger` (CDP `Input.*`), so clicks and
  keys are trusted events and work in background tabs without taking focus.
  Chrome shows its "started debugging this browser" bar while a tab is under
  control, and detaches 15 seconds after the last action, or on `release`.
- **Refs follow Cua Driver's rules.** Each snapshot bumps a per-page
  generation, and a ref such as `g3:e12` only resolves against the snapshot
  that produced it. Stale refs fail loudly instead of hitting the wrong
  element. Snapshots cap elements (`--limit`) and page with `--offset`.
  Coordinate clicks must name the screenshot (`--capture`) they came from.
- **Observation** (console, exceptions, network) is recorded from the moment
  the extension attaches to a tab.
- **Stop.** The pill in the page, the toolbar popup, or cancelling Chrome's
  debugging bar all block agents on that tab until you re-allow it from the
  popup. Agents get `stopped_by_user`.

## Development

```sh
make check          # go vet + tests, extension syntax, version match
make build          # dist/<platform>/molt-browser
node scripts/e2e.mjs [--headed]   # real Chrome, throwaway profile, full CLI run
make dist           # out/: plugin tarball, Web Store zip, artifacts.json
```

The e2e script loads the unpacked extension into a temporary profile through
`--remote-debugging-pipe` and `Extensions.loadUnpacked`. It never touches your
own Chrome profile.

## Releasing

Bump `version` in both `package.json` and `extension/manifest.json`, then
push the tag `v<version>`. The release workflow publishes the plugin tarball,
the Chrome Web Store zip (the same extension with the `key` field stripped)
and `artifacts.json` for the Molt catalog.

Once the store assigns its id, add it to `extensionIDs` in `setup.go` so the
native host accepts both builds.
