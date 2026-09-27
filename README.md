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
3. Connect it: click the Molt icon in Chrome's toolbar and follow the three
   steps. **Sign in** with the same Molt account as the app, then
   **Connect**; the Molt app asks you to **Allow** it. `molt-browser status`
   should print `extension: connected` and `auth: connected as <you>`.

## Auth

Opening the bridge socket drives nothing. The extension signs in to Molt on
its own, connects to the Molt app on this computer only after the platform
confirms both are signed in to the same account, and runs a command only
when the command carries a grant that app signed:

- **Sign-in** uses the platform's redirect login. The extension trades the
  platform token for a browser-only token at once and keeps only that; it is
  good for nothing but the verify call below.
- **Connect** starts in Chrome. The request (request id, browser profile id,
  signed-in account; nothing secret) waits in the host until the Molt app
  picks it up with `molt-browser watch` and shows an Allow/Deny modal. On
  Allow the app asks the platform for a 5-minute connect token naming its
  user, machine and Ed25519 *public* key and hands it to Chrome. Chrome sends
  it to the platform's `POST /api/browser/verify` with its own token; the
  platform checks both signatures and compares the two account ids in
  constant time (no database lookup). Only then does Chrome store the app's
  key. The private key stays with the app, so nothing in the Chrome profile
  can mint grants.
- **Grants** are signed for one Molt agent session and live 5 minutes. The
  CLI fetches a fresh one per command with the session's
  `MOLT_BROWSER_LEASE`; the app signs only while its signed-in user is the
  connected one. The extension checks signature, connection, user, machine,
  browser profile, audience, scope and expiry before any handler runs, and
  the session in the grant is the only one tab ownership sees.
- **Sign-out or account switch** in Molt rotates the app's key (every lease
  and outstanding grant dies with it) and pushes a signed unpair when Chrome
  is connected. If Chrome was closed at the time, a grant already in flight
  stays valid until it expires, at most 5 minutes. **Disconnect** or
  **Sign out** in the toolbar popup drops the connection immediately.
- The host is a pipe: it relays grants, never logs them, and refuses to
  drive an extension older than protocol 3 (0.3.0 paired without the
  platform; that pairing is dropped).

This stops any process that can open the socket from driving Chrome. It
does not defend against malware that already runs as you and can read the
app's data directory.

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
