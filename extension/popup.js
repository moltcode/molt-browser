const $ = (id) => document.getElementById(id);
const show = (id, on) => ($(id).hidden = !on);

// Popup actions run in the service worker; errors come back as text.
const actionError = { account: null, connect: null };

async function act(molt, slot) {
  actionError[slot] = null;
  const r = await chrome.runtime.sendMessage({ molt });
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

  // 1. Bridge
  const bridged = s.bridge.connected;
  $("step-bridge").className = bridged ? "done" : "current";
  $("bridge-detail").innerHTML = bridged
    ? "Running."
    : "Install the <b>Browser</b> plugin in the Molt app, then run <code>molt-browser setup</code> once.";

  // 2. Account
  const signedIn = !!s.account;
  $("step-account").className = signedIn ? "done" : "current";
  if (signedIn) detail("account-detail", "Signed in as ", s.account.email || s.account.name || "your Molt account");
  else detail("account-detail", "Use the same account as the Molt app.");
  show("sign-in", !signedIn);
  show("sign-out", signedIn);
  show("account-error", !!actionError.account);
  $("account-error").textContent = actionError.account || "";

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
$("connect").onclick = () => act("connect", "connect");
$("cancel").onclick = () => act("cancel_connect", "connect");
$("disconnect").onclick = () => act("disconnect", "connect");

render();
// The bridge connects and the Molt app answers while the popup is open.
setInterval(render, 1000);
