# molt-browser

Lets Molt agents drive and debug **your real Chrome**: your profile, your
logins, your open tabs. Every action shows an agent cursor in the page, the
tab glows and shows a purple agent favicon while an agent has it, and a
**Stop** pill hands control back to you. The original favicon returns when
the agent releases the tab.

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
   - **Chrome Web Store:** [Molt Code Browser](https://chromewebstore.google.com/detail/fbcpkgpfkngdmblgndnahfilmblciggp)
     (in review). Then run `molt-browser setup` once to register the bridge.
   - **Unpacked, for now:** run `molt-browser setup`. It registers the native
     host with every Chromium-family browser it finds (Chrome, Chromium,
     Brave, Edge, Arc) and prints the extension folder. Open
     `chrome://extensions`, turn on Developer mode, click **Load unpacked**
     and pick that folder. The extension id is always
     `gajikdfpamklabiiaonmdeamjabehoig`.
3. Pair it: **Plugins → Browser (Chrome) → Pair Chrome** in Molt Code. Chrome
   opens a page with the same 6-digit code the desktop shows; click
   **Allow**. `molt-browser status` should print `extension: connected` and
   `auth: paired with <you>`.

## Auth

Opening the bridge socket drives nothing. The extension is paired with one
Molt backend and the platform account signed in there, and it runs a
command only when the command carries a grant that backend signed:

- **Pairing** stores the backend's Ed25519 *public* key in the extension.
  The private key stays with the backend, so nothing in the Chrome profile
  can mint grants. A second pairing replaces the first only after you
  approve it in Chrome.
- **Grants** are signed for one Molt agent session and live 5 minutes. The
  CLI fetches a fresh one per command with the session's
  `MOLT_BROWSER_LEASE`; the backend signs only while its signed-in user is
  the paired one. The extension checks signature, pairing, user, machine,
  browser profile, audience, scope and expiry before any handler runs, and
  the session in the grant is the only one tab ownership sees.
- **Sign-out or account switch** in Molt rotates the backend key (every
  lease and outstanding grant dies with it) and pushes a signed unpair when
  Chrome is connected. If Chrome was closed at the time, a grant already in
  flight stays valid until it expires, at most 5 minutes. **Unpair** in the
  toolbar popup drops the pairing immediately.
- The host is a pipe: it relays grants, never logs them, and refuses to
  drive an extension older than protocol 2.

This stops any process that can open the socket from driving Chrome. It
does not defend against malware that already runs as you and can read the
backend's data directory.

## Commands

```
molt-browser status | setup | tabs | reload-extension
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
- **Foreground protection.** Each Molt session keeps its own background tab.
  Commands never silently fall back to the tab you're using. If you switch
  to an agent tab, further actions are refused until it is in the background again.
  `--allow-active` is an explicit opt-in for sharing the foreground tab.
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
