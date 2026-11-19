// The platform's redirect login lands here with ?state=…&token=…. The token
// leaves the address bar and history at once; the service worker checks the
// state and trades the token for this browser's own. An account the platform
// sends to Molt Auth (a workspace of its is sealed) signs in there next, from
// this page.
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const token = params.get("token");
const state = params.get("state");
history.replaceState(null, "", location.pathname);

function showError(text) {
  $("error").hidden = false;
  $("error").textContent = text;
}

function offerAuth(r) {
  $("auth").hidden = false;
  if (!r.reachable) {
    $("auth-detail").textContent = "This account signs in through Molt Auth, which this version of the extension cannot reach yet.";
    return;
  }
  $("auth-detail").textContent = "This account signs in through Molt Auth. Continue with the account you use in the Molt app.";
  for (const p of r.providers || []) {
    const b = $(`auth-${p}`);
    if (!b) continue;
    b.hidden = false;
    b.onclick = () =>
      chrome.runtime.sendMessage({ molt: "auth_sign_in", provider: p }).then((a) => {
        if (!a?.ok) showError(a?.error || "Could not start the sign-in.");
      });
  }
}

chrome.runtime.sendMessage({ molt: "signed_in", token, state }).then((r) => {
  $("working").hidden = true;
  if (r?.ok && r.authRequired) offerAuth(r);
  else if (r?.ok) {
    $("done").hidden = false;
    $("who").textContent = r.email ? `Signed in as ${r.email}` : "Signed in";
  } else showError(r?.error || "Sign-in failed.");
});
