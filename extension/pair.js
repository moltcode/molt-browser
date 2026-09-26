const $ = (id) => document.getElementById(id);

async function render() {
  const { offer, replaces } = await chrome.runtime.sendMessage({ molt: "pair_state" });
  $("offer").hidden = !offer;
  $("none").hidden = !!offer;
  if (!offer) return;

  $("who").textContent = offer.email || "A Molt account";
  $("machine").textContent = offer.machine_name || "this computer";
  $("code").textContent = `${offer.code.slice(0, 3)} ${offer.code.slice(3)}`;
  if (replaces) {
    $("replaces").hidden = false;
    $("replaces").textContent = `This replaces the current pairing with ${replaces.email || "another account"}${replaces.machine_name ? ` on ${replaces.machine_name}` : ""}. Its agents lose access.`;
  }

  const decide = async (allow) => {
    $("allow").disabled = $("deny").disabled = true;
    const r = await chrome.runtime.sendMessage({ molt: "pair_decision", pair_id: offer.pair_id, allow });
    if (!r?.ok) render();
  };
  $("allow").onclick = () => decide(true);
  $("deny").onclick = () => decide(false);
}

render();
