# Molt Code Browser: privacy policy

Last updated: 2026-09-27

The Molt Code Browser extension lets the Molt Code desktop app on your own
computer control and inspect tabs in your browser when you ask one of your
Molt agents to.

## What the extension accesses

To do what an agent asks, the extension can read the content of the tab it's
working in: page text, the page's interactive elements, screenshots, console
messages and network requests. It can also act in that tab: click, type,
scroll and navigate.

## Where that data goes

Everything the extension reads from pages goes to one place: the Molt Code
app on the same computer, over Chrome's native messaging channel. We (Molt
Code) never receive page data from the extension.

The extension talks to the Molt Code platform (platform.moltcode.com) only to
sign you in and to confirm that the Molt Code app asking to connect is signed
in to the same account. Those calls carry your sign-in token and the app's
connect token, nothing from any page.

What the Molt Code app and your agents then do with page content is covered
by their own settings and the AI provider you chose to use with them.

## What the extension stores

In Chrome's local storage, until you sign out or disconnect:

- a Molt sign-in token for this browser, with your account id, email and name
- the connected Molt Code app's public key and machine name
- a random id for this browser profile

In Chrome's session storage, which is cleared when the browser closes:

- which tabs you have stopped agents on
- which tab an agent opened last

Console and network logs are held in memory only while a tab is under agent
control.

## What the extension doesn't do

- It doesn't collect analytics or telemetry.
- It doesn't sell or share data.
- It doesn't use data for advertising or creditworthiness.
- It doesn't run in a tab unless a Molt agent is acting on it. You can press
  **Stop** in the page or in the toolbar popup at any time.

## Contact

junaid1460@gmail.com
