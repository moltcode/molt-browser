const $ = (id) => document.getElementById(id);
const show = (id, on) => ($(id).hidden = !on);

// Popup actions run in the service worker; errors come back as text.
const actionError = { account: null, connect: null, update: null };

async function act(molt, slot, extra = {}) {
  actionError[slot] = null;
  const r = await chrome.runtime.sendMessage({ molt, ...extra });
  if (!r?.ok) actionError[slot] = r?.error || "Something went wrong.";
  render();
}

// Text with one bold span, without innerHTML for account-controlled strings.
function detail(id, before, bold, after = "") {
  const el = $(id);
  el.textContent = before;
  if (bold) {
    const b = document.createElement("b");
    b.textContent = bold;
    el.append(b, after);
  }
}

async function render() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const s = await chrome.runtime.sendMessage({ molt: "state", tabId: tab?.id });
  $("version").textContent = `v${s.version}${s.bridge.hostVersion ? ` · bridge ${s.bridge.hostVersion}` : ""}`;

  // Molt expects a newer build of this extension.
  const u = s.update;
  show("update", !!u);
  if (u) {
    $("update").className = `update${u.state === "required" ? " required" : ""}`;
    detail(
      "update-detail",
      u.state === "required" ? "Molt needs extension " : "Molt expects extension ",
      `v${u.expected}`,
      u.state === "required"
        ? `. This is v${s.version}, which agents cannot use until it is updated.`
        : `. This is v${s.version}; agents still work, but update to get the fixes.`
    );
    $("update-button").textContent = s.unpacked ? "Reload extension" : "Update extension";
    $("update-button").disabled = s.updatePending;
    const note = actionError.update || (s.updatePending ? "Downloading; the extension reloads once agents are idle." : null);
    show("update-note", !!note);
    $("update-note").textContent = note || "";
  }

  // 1. Bridge
  const bridged = s.bridge.connected;
  $("step-bridge").className = bridged ? "done" : "current";
  $("bridge-detail").innerHTML = bridged
    ? "Running."
    : "Install the <b>Browser</b> plugin in the Molt app, then run <code>molt-browser setup</code> once.";

  // 2. Account. `s.auth` is null unless this build signs in at Molt Auth
  // (`direct`, from this first screen) or the platform sent the account there.
  const signedIn = !!s.account;
  const au = signedIn ? null : s.auth;
  const choosing = !!au?.required && au.reachable && !au.signingIn;
  $("step-account").className = signedIn ? "done" : "current";
  if (signedIn) detail("account-detail", "Signed in as ", s.account.email || s.account.name || "your Molt account");
  else if (au?.signingIn) detail("account-detail", "Finish signing in to ", "Molt Auth", " in the tab that opened.");
  else if (au?.direct) detail("account-detail", "Sign in at ", "Molt Auth", " with the account you use in the Molt app.");
  else if (au?.required && !au.reachable) detail("account-detail", "This account signs in through Molt Auth, which this version of the extension cannot reach yet.");
  else if (au?.required) detail("account-detail", "This account signs in through ", "Molt Auth", ". Use the same account as the Molt app.");
  else detail("account-detail", "Use the same account as the Molt app.");
  show("sign-in", !signedIn && !au?.required && !au?.signingIn);
  show("sign-out", signedIn);
  for (const p of ["google", "apple", "dev"]) show(`auth-${p}`, choosing && au.providers.includes(p));
  show("auth-waiting", !!au?.signingIn);
  if (au?.signingIn && au.code) detail("auth-waiting", "When Molt Auth asks for a code, enter ", au.code, ". It shows only here.");
  else $("auth-waiting").textContent = au?.signingIn ? "Waiting for Molt Auth…" : "";
  show("auth-reopen", !!au?.signingIn);
  show("auth-cancel", (!!au?.required && !au?.direct) || !!au?.signingIn);
  const accountError = actionError.account || au?.error || null;
  show("account-error", !!accountError);
  $("account-error").textContent = accountError || "";

  // 3. Connect
  const paired = s.pairing;
  const c = s.connecting;
  const waiting = c?.state === "waiting" || c?.state === "verifying";
  $("step-connect").className = paired ? "done" : signedIn && bridged ? "current" : "locked";
  if (paired) detail("connect-detail", "Connected to ", paired.machine_name || "this computer", ". Agents can use this browser.");
  else detail("connect-detail", "Until then no agent can use this browser.");
  show("connect-waiting", waiting);
  $("connect-waiting").textContent =
    c?.state === "verifying" ? "Verifying with Molt…" : "Click Allow in the Molt app on this computer.";
  show("connect", !paired && !waiting);
  $("connect").disabled = !signedIn || !bridged;
  show("cancel", waiting);
  show("disconnect", !!paired && !waiting);
  const connectError = actionError.connect || (c?.state === "failed" ? c.error : null);
  show("connect-error", !!connectError && !paired);
  $("connect-error").textContent = connectError || "";
  // The platform found this browser's connection stale; a new pairing clears it.
  show("connect-again", !!s.reconnect && !paired && !waiting && !connectError);
  $("connect-again").textContent = "Connect the Molt app again. Click Connect, then Allow in the app.";

  // This tab
  const t = s.tab || {};
  show("tab-section", !!paired);
  $("tab-dot").className = `dot ${t.controlled ? "busy" : t.stopped ? "bad" : ""}`;
  $("tab").textContent = t.controlled
    ? "An agent is using this tab"
    : t.stopped
      ? "Agents are stopped on this tab"
      : "Agents can use this tab";
  show("stop", !!t.controlled);
  show("allow", !!t.stopped);

  $("protect-foreground").checked = !!s.protectForeground;

  $("stop").onclick = async () => {
    await chrome.runtime.sendMessage({ molt: "stop", tabId: tab.id });
    render();
  };
  $("allow").onclick = async () => {
    await chrome.runtime.sendMessage({ molt: "allow", tabId: tab.id });
    render();
  };
}

$("sign-in").onclick = () => act("sign_in", "account");
$("sign-out").onclick = () => act("sign_out", "account");
for (const p of ["google", "apple", "dev"]) $(`auth-${p}`).onclick = () => act("auth_sign_in", "account", { provider: p });
$("auth-reopen").onclick = () => act("auth_reopen", "account");
$("auth-cancel").onclick = () => act("auth_cancel", "account");
$("connect").onclick = () => act("connect", "connect");
$("cancel").onclick = () => act("cancel_connect", "connect");
$("disconnect").onclick = () => act("disconnect", "connect");
$("update-button").onclick = () => act("update", "update");
$("protect-foreground").onchange = async (e) => {
  await chrome.storage.local.set({ protectForeground: e.target.checked });
  render();
};

render();
// The bridge connects and the Molt app answers while the popup is open.
setInterval(render, 1000);
