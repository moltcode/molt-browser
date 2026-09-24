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

Most tasks take a handful of calls. Every action prints the page afterwards,
so you rarely need a separate `snapshot`.

```sh
molt-browser open https://example.com/signup     # background tab; your user's tab stays put
molt-browser fill "Email" "sam@x.com" "Plan" "Pro" "Agree to terms" true "Avatar" ./me.png
molt-browser click "Create account"
```

- **Targets.** Anywhere a command takes a `<target>`, use an element's
  visible name (`"Save draft"`, `"Email"`), a ref from the last output
  (`g3:e12`), or `css=<selector>`. Names match exactly first, then by
  substring. An ambiguous name is an error that lists refs to choose from.
  Never guess.
- **`fill`** sets a whole form in one call: text fields (replaced),
  native and custom dropdowns (by option text), checkboxes and radios
  (`true`/`false`), and uploads. A value that is a path to an existing file
  is uploaded through the target, whether that's a file input, a button or a
  drop zone. The OS file picker never opens.
- **`select <target> <option>`** and **`upload [<target>] <file>...`** do
  the same for single fields.
- **Refs are scoped.** Each printed page is a new generation (`g4:...`);
  refs from earlier output fail with `stale_ref`. Names don't go stale.
- **Target tab.** After `open`, commands go to that Molt session's tab until
  it closes or you `release` it. Without one, open a new background tab or
  pass `--tab ID` from `molt-browser tabs`. The user's foreground tab is
  never an implicit target. Each Molt session has its own tab, and a tab in
  use by another agent session is refused.
- **Sharing the foreground.** If the user explicitly asks to work in the tab
  they're viewing, pass `--allow-active` on each command. Otherwise, if they
  switch to your tab, stop acting in it and wait for them to switch away.
  `--focus` and `molt-browser focus` move the browser to the front; use only
  when the user asks to watch.
- `text` returns readable page text, cheaper than a screenshot.
- `screenshot` saves a PNG and prints a capture id; `click --xy X,Y
  --capture ID` clicks a point read from it.
- `--no-page` skips the page printout when you don't need it.

## Debugging

```sh
molt-browser console [--limit 50] [--clear]   # logs + uncaught exceptions
molt-browser network [--filter /api/]          # method, url, status, ms, bytes
molt-browser body <request-id>                 # a response body
molt-browser eval "document.querySelectorAll('li').length"
```

Console and network are recorded while molt-browser is attached to the tab
(from your first action until 15 seconds after your last). Reload to capture a page load from the start.

## Etiquette

- `stopped_by_user` means the user pressed Stop on that tab. Don't retry, and
  don't switch tabs to get around it. Ask the user.
- `active_tab` means the user is viewing the target. Don't use
  `--allow-active` unless they explicitly asked to share that tab.
- Run `molt-browser release` when you're done with a tab. Debugging also
  detaches on its own 15 seconds after your last action.
- Don't submit payments, send messages or delete data without the user's
  explicit go-ahead in this conversation.
- Chrome blocks every extension on `chrome://` pages and the Web Store
  (`restricted_page`). Ask the user to do those by hand.
