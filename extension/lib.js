// Page-side helpers, injected into the extension's isolated world (page
// scripts can't see or tamper with them) and called by name from the
// service worker: window.__molt.<fn>(...args). Safe to inject repeatedly;
// the ref table survives re-injection.
//
// Targets: a ref from a snapshot ("g3:e12"), "css=<selector>", or anything
// else as the visible name of an element ("Save draft", "Email"). Names match
// exactly first (case-insensitive), then by substring; more than one match is
// an error that lists the candidates with refs.
//
// Refs follow Cua's scoping: every snapshot bumps the page's generation, and a
// ref only resolves against the snapshot that produced it. Navigation drops
// the table, so old refs fail as stale instead of hitting another element.
(() => {
  if (window.__molt) return;

  const INTERACTIVE = [
    "a[href]", "button", "input:not([type=hidden])", "select", "textarea", "summary", "label[for]",
    "[role=button]", "[role=link]", "[role=checkbox]", "[role=radio]", "[role=tab]", "[role=menuitem]",
    "[role=menuitemcheckbox]", "[role=menuitemradio]", "[role=option]", "[role=switch]", "[role=combobox]",
    "[role=textbox]", "[role=searchbox]", "[role=slider]", "[role=treeitem]", "[role=listbox]",
    "[contenteditable='']", "[contenteditable=true]", "[onclick]", "[tabindex]:not([tabindex='-1'])",
  ].join(",");

  const state = { gen: 0, refs: new Map() };

  const clean = (s, n = 80) => {
    s = (s || "").replace(/\s+/g, " ").trim();
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
  };

  const all = () => {
    const found = new Set();
    const collect = (root) => {
      root.querySelectorAll(INTERACTIVE).forEach((el) => found.add(el));
      root.querySelectorAll("*").forEach((el) => el.shadowRoot && collect(el.shadowRoot));
    };
    collect(document);
    return [...found];
  };

  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const style = getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) !== 0;
  };

  const roleOf = (el) => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button" || tag === "summary") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "label") return "label";
    if (tag === "input") {
      const type = (el.type || "text").toLowerCase();
      if (["button", "submit", "reset", "image"].includes(type)) return "button";
      if (type === "range") return "slider";
      if (["checkbox", "radio", "file", "color", "date"].includes(type)) return type;
      return type === "search" ? "searchbox" : "textbox";
    }
    if (el.isContentEditable) return "textbox";
    return "clickable";
  };

  // Accessible-ish name: aria-label, labelledby, <label>, text, placeholder.
  const nameOf = (el) => {
    const aria = el.getAttribute("aria-label");
    if (aria) return clean(aria);
    const labelledby = el.getAttribute("aria-labelledby");
    if (labelledby) {
      const text = labelledby.split(/\s+/).map((id) => document.getElementById(id)?.innerText || "").join(" ");
      if (text.trim()) return clean(text);
    }
    if (el.labels?.length) return clean(el.labels[0].innerText);
    const tag = el.tagName.toLowerCase();
    if (tag === "input" && ["button", "submit", "reset"].includes(el.type)) return clean(el.value);
    if (tag !== "select" && tag !== "textarea" && tag !== "input") {
      const text = el.innerText;
      if (text && text.trim()) return clean(text);
    }
    // Material-style fields keep their label in a sibling or wrapper.
    const wrapperLabel = el.closest("label")?.innerText || el.parentElement?.querySelector("label")?.innerText;
    return clean(
      el.getAttribute("placeholder") || el.getAttribute("title") || wrapperLabel ||
        el.querySelector?.("img[alt]")?.alt || el.getAttribute("alt") || ""
    );
  };

  const valueOf = (el) => {
    const tag = el.tagName.toLowerCase();
    if (tag === "select") return clean(el.selectedOptions?.[0]?.text || "");
    if (tag === "textarea" || (tag === "input" && !["button", "submit", "reset", "checkbox", "radio", "file"].includes(el.type))) {
      if (el.type === "password") return el.value ? "••••" : "";
      return clean(el.value || "");
    }
    if (el.isContentEditable) return clean(el.innerText || "");
    const role = el.getAttribute("role");
    if (role === "combobox") return clean(el.innerText || el.getAttribute("aria-valuetext") || "");
    return "";
  };

  const fail = (error, message) => ({ error, message });

  function resolve(spec) {
    if (!spec) return fail("bad_target", "no target given");
    const refMatch = /^g(\d+):e(\d+)$/.exec(spec);
    if (refMatch) {
      if (Number(refMatch[1]) !== state.gen) {
        return fail(
          "stale_ref",
          state.gen
            ? `${spec} is from an older snapshot (current generation is ${state.gen}). Use a ref from the latest output or a visible name.`
            : `${spec} is from before the page changed or navigated. Use a visible name or take a new snapshot.`
        );
      }
      const el = state.refs.get(spec);
      if (!el) return fail("not_found", `${spec} is not in snapshot generation ${state.gen}`);
      if (!el.isConnected) return fail("stale_ref", `${spec} was removed from the page`);
      return { el };
    }
    if (spec.startsWith("css=")) {
      let el;
      try {
        el = document.querySelector(spec.slice(4));
      } catch (e) {
        return fail("bad_selector", e.message);
      }
      return el ? { el } : fail("not_found", `no element matches ${spec.slice(4)}`);
    }
    const want = spec.replace(/^text=/, "").trim().toLowerCase();
    const candidates = all().filter(visible);
    const named = candidates.map((el) => ({ el, name: nameOf(el).toLowerCase() }));
    let hits = named.filter((c) => c.name === want);
    if (!hits.length) hits = named.filter((c) => c.name.includes(want));
    // A <label for> and its control share a name; keep the control.
    hits = hits.filter((c) => !(c.el.tagName === "LABEL" && c.el.control && hits.some((o) => o.el === c.el.control)));
    if (hits.length === 1) return { el: hits[0].el };
    if (!hits.length) return fail("not_found", `nothing visible is named "${spec}". Take a snapshot to see what's there.`);
    const list = hits.slice(0, 8).map((c) => `${register(c.el)} ${roleOf(c.el)} "${nameOf(c.el)}"`);
    return fail("ambiguous", `"${spec}" matches ${hits.length} elements; use a ref:\n  ${list.join("\n  ")}`);
  }

  // Gives an element a ref in the current generation (used for listing
  // candidates without a full snapshot).
  function register(el) {
    for (const [ref, e] of state.refs) if (e === el) return ref;
    if (!state.gen) state.gen = 1;
    const ref = `g${state.gen}:e${state.refs.size + 1}`;
    state.refs.set(ref, el);
    return ref;
  }

  function point(el) {
    let r = el.getBoundingClientRect();
    const fully = r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth;
    if (!fully) {
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      r = el.getBoundingClientRect();
    }
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    let obscured_by = null;
    if (hit && hit !== el && !el.contains(hit) && !hit.contains(el)) {
      const cls = typeof hit.className === "string" && hit.className.trim() ? "." + hit.className.trim().split(/\s+/)[0] : "";
      obscured_by = `${hit.tagName.toLowerCase()}${hit.id ? "#" + hit.id : cls}`;
    }
    return { x, y, obscured_by };
  }

  function describe(el) {
    return { tag: el.tagName.toLowerCase(), role: roleOf(el), name: clean(nameOf(el), 60) };
  }

  const api = {
    snapshot({ limit = 150, offset = 0, all: everything = false } = {}) {
      state.gen += 1;
      state.refs = new Map();
      const vw = innerWidth;
      const vh = innerHeight;
      const rows = [];
      let offscreen = 0;
      for (const el of all()) {
        if (!visible(el)) continue;
        // Labels for controls already listed add nothing.
        if (el.tagName === "LABEL" && el.control) continue;
        const r = el.getBoundingClientRect();
        const inViewport = r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw;
        if (!inViewport) {
          offscreen += 1;
          if (!everything) continue;
        }
        rows.push({ el, r, inViewport });
      }
      rows.sort((a, b) => a.r.top - b.r.top || a.r.left - b.r.left);
      const page = rows.slice(offset, offset + limit);
      const elements = page.map(({ el, r, inViewport }, i) => {
        const ref = `g${state.gen}:e${offset + i + 1}`;
        state.refs.set(ref, el);
        const row = { ref, role: roleOf(el), name: nameOf(el), x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), in_viewport: inViewport };
        const value = valueOf(el);
        if (value) row.value = value;
        if (el.tagName === "A" && el.href) row.href = clean(el.href, 120);
        if (el.disabled || el.getAttribute("aria-disabled") === "true") row.disabled = true;
        if (el.type === "checkbox" || el.type === "radio") row.checked = el.checked;
        else if (el.hasAttribute("aria-checked")) row.checked = el.getAttribute("aria-checked") === "true";
        if (el.tagName === "SELECT") row.options = [...el.options].slice(0, 12).map((o) => clean(o.text, 40));
        return row;
      });
      return {
        url: location.href,
        title: document.title,
        generation: state.gen,
        total: rows.length,
        offscreen: everything ? 0 : offscreen,
        next_offset: offset + limit < rows.length ? offset + limit : null,
        viewport: { w: vw, h: vh, scroll_y: Math.round(scrollY), page_h: Math.round(document.documentElement.scrollHeight) },
        elements,
      };
    },

    // Where to click a target, scrolling it into view first.
    target(spec) {
      const r = resolve(spec);
      if (r.error) return r;
      return { ...point(r.el), ...describe(r.el) };
    },

    // What a target is, so fill knows how to set it.
    field(spec) {
      const r = resolve(spec);
      if (r.error) return r;
      const el = r.el;
      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute("role");
      let kind = "click";
      if (tag === "select") kind = "select";
      else if (tag === "input" && el.type === "file") kind = "file";
      else if (tag === "input" && (el.type === "checkbox" || el.type === "radio")) kind = "check";
      else if (role === "checkbox" || role === "switch" || role === "radio") kind = "check";
      else if (role === "combobox" || role === "listbox" || el.getAttribute("aria-haspopup") === "listbox") kind = "choose";
      else if (tag === "textarea" || el.isContentEditable || (tag === "input" && !["button", "submit", "reset", "image"].includes(el.type)) || role === "textbox" || role === "searchbox") kind = "text";
      const checked = el.type === "checkbox" || el.type === "radio" ? el.checked : el.getAttribute("aria-checked") === "true";
      return { kind, checked, ...point(el), ...describe(el) };
    },

    // Native <select>: pick by option text or value, fire input/change.
    selectOption(spec, option) {
      const r = resolve(spec);
      if (r.error) return r;
      const el = r.el;
      const want = String(option).trim().toLowerCase();
      const opts = [...el.options];
      const hit =
        opts.find((o) => o.text.trim().toLowerCase() === want || o.value.toLowerCase() === want) ||
        opts.find((o) => o.text.trim().toLowerCase().includes(want));
      if (!hit) return fail("no_option", `no option "${option}" in ${nameOf(el) || "the select"}; options: ${opts.slice(0, 15).map((o) => o.text.trim()).join(", ")}`);
      el.value = hit.value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true, chosen: hit.text.trim() };
    },

    // A visible option in an open custom dropdown (role=option / menuitem /
    // listbox children), for the click-to-choose flow.
    findOption(option) {
      const want = String(option).trim().toLowerCase();
      const opts = [...document.querySelectorAll("[role=option],[role=menuitem],[role=menuitemradio],[role=treeitem],li[data-value],mat-option")].filter(visible);
      const named = opts.map((el) => ({ el, name: clean(el.innerText || el.getAttribute("aria-label") || "", 200).toLowerCase() }));
      const hit = named.find((o) => o.name === want) || named.find((o) => o.name.includes(want));
      if (!hit) {
        return opts.length
          ? fail("no_option", `no option "${option}"; visible options: ${named.slice(0, 15).map((o) => o.name).join(", ")}`)
          : fail("no_options", "no dropdown options are visible");
      }
      return { ...point(hit.el), name: clean(hit.el.innerText, 60) };
    },

    // Selects a focused field's contents so the next insertText replaces them.
    selectContents() {
      const el = document.activeElement;
      if (!el) return fail("no_focus", "nothing is focused");
      if (typeof el.select === "function" && "value" in el) el.select();
      else if (el.isContentEditable) {
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }
      return { ok: true };
    },

    // Tags the file input for a target (the input itself, one inside it, or
    // one its label points at) so the service worker can hand it files.
    markFileInput(spec, mark) {
      const r = spec ? resolve(spec) : { el: null };
      if (r.error) return r;
      let el = r.el;
      if (el && !(el instanceof HTMLInputElement && el.type === "file")) {
        el =
          el.querySelector?.("input[type=file]") ||
          (el.tagName === "LABEL" && el.control?.type === "file" ? el.control : null) ||
          el.closest?.("label")?.querySelector("input[type=file]") ||
          null;
      }
      if (!el && !spec) {
        const inputs = document.querySelectorAll("input[type=file]");
        if (inputs.length === 1) el = inputs[0];
      }
      if (!el) return { ok: false };
      el.setAttribute("data-molt-upload", mark);
      return { ok: true };
    },

    text(max = 20000) {
      const text = (document.body?.innerText || "").replace(/\n{3,}/g, "\n\n");
      return { url: location.href, title: document.title, text: text.slice(0, max), truncated: text.length > max };
    },

    viewport() {
      return {
        w: innerWidth,
        h: innerHeight,
        dpr: devicePixelRatio || 1,
        scroll_x: Math.round(scrollX),
        scroll_y: Math.round(scrollY),
        page_h: Math.round(document.documentElement.scrollHeight),
        url: location.href,
        hidden: document.visibilityState !== "visible",
      };
    },

    // Scrolls the container under the viewport centre, or the page. Used for
    // background tabs, where Chrome holds synthetic wheel events until the
    // tab paints and would replay them later.
    scrollBy(dy) {
      let el = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
      while (el && el !== document.body && el !== document.documentElement) {
        if (/(auto|scroll)/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight) break;
        el = el.parentElement;
      }
      if (!el || el === document.body || el === document.documentElement) el = document.scrollingElement;
      el.scrollBy({ top: dy, behavior: "instant" });
      return { ok: true };
    },
  };

  Object.defineProperty(window, "__molt", { value: api });
})();
