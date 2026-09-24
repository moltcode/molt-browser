const $ = (id) => document.getElementById(id);

async function render() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const state = await chrome.runtime.sendMessage({ molt: "state", tabId: tab?.id });

  const connected = state.bridge.connected;
  $("bridge-dot").className = `dot ${connected ? "ok" : "bad"}`;
  $("bridge").textContent = connected ? "Connected to Molt Code" : "Molt Code is not connected";
  $("bridge-hint").hidden = connected;

  const t = state.tab || {};
  $("tab-dot").className = `dot ${t.controlled ? "busy" : t.stopped ? "bad" : ""}`;
  $("tab").textContent = t.controlled
    ? "An agent is using this tab"
    : t.stopped
      ? "Agents are stopped on this tab"
      : "Agents can use this tab";
  $("stop").hidden = !t.controlled;
  $("allow").hidden = !t.stopped;
  $("version").textContent = `v${state.version}${state.bridge.hostVersion ? ` · bridge ${state.bridge.hostVersion}` : ""}`;

  $("stop").onclick = async () => {
    await chrome.runtime.sendMessage({ molt: "stop", tabId: tab.id });
    render();
  };
  $("allow").onclick = async () => {
    await chrome.runtime.sendMessage({ molt: "allow", tabId: tab.id });
    render();
  };
}

render();
// The bridge may connect a moment after the popup opens.
setTimeout(render, 800);
