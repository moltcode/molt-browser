// The platform's redirect login lands here with ?state=…&token=…. The token
// leaves the address bar and history at once; the service worker checks the
// state and trades the token for this browser's own.
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const token = params.get("token");
const state = params.get("state");
history.replaceState(null, "", location.pathname);

chrome.runtime.sendMessage({ molt: "signed_in", token, state }).then((r) => {
  $("working").hidden = true;
  if (r?.ok) {
    $("done").hidden = false;
    $("who").textContent = r.email ? `Signed in as ${r.email}` : "Signed in";
  } else {
    $("error").hidden = false;
    $("error").textContent = r?.error || "Sign-in failed.";
  }
});
