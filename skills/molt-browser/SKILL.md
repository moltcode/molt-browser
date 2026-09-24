---
name: molt-browser
description: Drive and debug the user's real Chrome from the shell with the molt-browser CLI - open tabs, navigate, read pages, click, type, scroll, screenshot, and inspect console, network and JS. Use whenever a task needs a web page, a logged-in site, or browser debugging.
---

# molt-browser

`molt-browser` controls the user's own Chrome (their profile, cookies and
logins) through the Molt Chrome extension. Every action shows a cursor in the
page, and the user can press **Stop** at any time. Nothing runs headless.

Start with `molt-browser status`. If it says the extension is not connected,
tell the user to install it (`molt-browser setup` prints the steps) and stop;
don't try other browser tools.

## Loop

```sh
molt-browser open https://example.com      # new background tab, prints its id
molt-browser snapshot                       # interactive elements with refs
molt-browser click g1:e7                    # act on a ref from the latest snapshot
molt-browser type g1:e3 "hello" --submit
molt-browser snapshot                       # refs change after every snapshot
```

- **Refs are scoped.** `g3:e12` means element 12 of snapshot generation 3.
  A new snapshot, navigation or re-render makes old refs fail with
  `stale_ref`; take a new snapshot and pick again. Never guess refs.
- The snapshot lists only elements in the viewport. It reports how many are
  offscreen; `scroll`, or `snapshot --all`, then `--offset N` to page.
- **Target tab.** After `open`, commands go to that tab until it closes or you
  `release` it. Otherwise they go to the tab the user is looking at. Pass
  `--tab ID` (from `molt-browser tabs`) whenever you mean a specific tab.
- `open` doesn't steal focus. Use `--focus` or `molt-browser focus` only when
  the user should watch, or when a background tab won't render a screenshot.
- `text` returns the page's readable text. It's cheaper than a screenshot when
  you only need to read.
- `screenshot` saves a PNG and prints its path and a capture id. To click a
  point you found in the image: `click --xy X,Y --capture ID`. Coordinates
  are image pixels, and the capture must be the latest one for the tab.
- `click --selector CSS` works when you already know a stable selector.

## Debugging

```sh
molt-browser console [--limit 50] [--clear]   # logs + uncaught exceptions
molt-browser network [--filter /api/]          # method, url, status, ms, bytes
molt-browser body <request-id>                 # a response body
molt-browser eval "document.querySelectorAll('li').length"
```

Console and network are recorded from the moment molt-browser first touches
the tab. Reload (`molt-browser reload`) to capture a page load from the start.

## Etiquette

- `stopped_by_user` means the user pressed Stop on that tab. Don't retry, and
  don't switch tabs to get around it. Ask the user.
- Run `molt-browser release` when you're done with a tab, so Chrome's
  "debugging this browser" bar goes away. Idle tabs are released after
  2 minutes anyway.
- Don't submit payments, send messages or delete data without the user's
  explicit go-ahead in this conversation.
- Chrome blocks extensions on `chrome://` pages and the Web Store
  (`restricted_page`).
