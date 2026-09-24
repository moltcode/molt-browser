// Functions injected into the page with chrome.scripting.executeScript. Each
// one is serialized on its own, so none may reference anything outside its
// body. They run in the extension's isolated world: page scripts can't see
// or tamper with the ref table.
//
// Refs follow Cua's scoping: every snapshot bumps the page's generation, and
// a ref (g<generation>:e<index>) only resolves against the snapshot that
// produced it. Navigation drops the table, so old refs fail as stale instead
// of hitting a different element.

export function snapshotPage({ limit, offset, all }) {
  const state = (window.__moltRefs ??= { gen: 0, refs: new Map() });
  state.gen += 1;
  state.refs = new Map();

  const SELECTOR = [
    "a[href]", "button", "input:not([type=hidden])", "select", "textarea", "summary", "label[for]",
    "[role=button]", "[role=link]", "[role=checkbox]", "[role=radio]", "[role=tab]", "[role=menuitem]",
    "[role=menuitemcheckbox]", "[role=menuitemradio]", "[role=option]", "[role=switch]", "[role=combobox]",
    "[role=textbox]", "[role=searchbox]", "[role=slider]", "[role=treeitem]",
    "[contenteditable='']", "[contenteditable=true]", "[onclick]", "[tabindex]:not([tabindex='-1'])",
  ].join(",");

  const found = new Set();
  const collect = (root) => {
    root.querySelectorAll(SELECTOR).forEach((el) => found.add(el));
    root.querySelectorAll("*").forEach((el) => el.shadowRoot && collect(el.shadowRoot));
  };
  collect(document);

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const clean = (s, n = 80) => {
    s = (s || "").replace(/\s+/g, " ").trim();
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
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
      if (["checkbox", "radio", "range", "file", "color", "date"].includes(type)) return type === "range" ? "slider" : type;
      return type === "search" ? "searchbox" : "textbox";
    }
    if (el.isContentEditable) return "textbox";
    return "clickable";
  };

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
    const text = el.innerText;
    if (text && text.trim()) return clean(text);
    return clean(el.getAttribute("placeholder") || el.getAttribute("title") || el.querySelector?.("img[alt]")?.alt || el.getAttribute("alt") || "");
  };

  const valueOf = (el) => {
    const tag = el.tagName.toLowerCase();
    if (tag === "select") return clean(el.selectedOptions?.[0]?.text || "");
    if (tag === "textarea" || (tag === "input" && !["button", "submit", "reset", "checkbox", "radio"].includes(el.type))) {
      if (el.type === "password") return el.value ? "••••" : "";
      return clean(el.value || "");
    }
    return "";
  };

  const rows = [];
  let offscreen = 0;
  for (const el of found) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) continue;
    const inViewport = r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw;
    if (!inViewport) {
      offscreen += 1;
      if (!all) continue;
    }
    rows.push({ el, r, inViewport });
  }
  rows.sort((a, b) => a.r.top + window.scrollY - (b.r.top + window.scrollY) || a.r.left - b.r.left);

  const page = rows.slice(offset, offset + limit);
  const elements = page.map(({ el, r, inViewport }, i) => {
    const ref = `g${state.gen}:e${offset + i + 1}`;
    state.refs.set(ref, el);
    const row = {
      ref,
      role: roleOf(el),
      name: nameOf(el),
      x: Math.round(r.left),
      y: Math.round(r.top),
      w: Math.round(r.width),
      h: Math.round(r.height),
      in_viewport: inViewport,
    };
    const value = valueOf(el);
    if (value) row.value = value;
    if (el.tagName === "A" && el.href) row.href = clean(el.href, 120);
    if (el.disabled || el.getAttribute("aria-disabled") === "true") row.disabled = true;
    if (el.type === "checkbox" || el.type === "radio") row.checked = el.checked;
    else if (el.hasAttribute("aria-checked")) row.checked = el.getAttribute("aria-checked") === "true";
    return row;
  });

  return {
    url: location.href,
    title: document.title,
    generation: state.gen,
    total: rows.length,
    offscreen: all ? 0 : offscreen,
    next_offset: offset + limit < rows.length ? offset + limit : null,
    viewport: {
      w: vw,
      h: vh,
      scroll_y: Math.round(window.scrollY),
      page_h: Math.round(document.documentElement.scrollHeight),
    },
    elements,
  };
}

export function resolveTarget(ref, selector) {
  let el;
  if (selector) {
    try {
      el = document.querySelector(selector);
    } catch (e) {
      return { error: "bad_selector", message: e.message };
    }
    if (!el) return { error: "not_found", message: `no element matches ${selector}` };
  } else {
    const match = /^g(\d+):e(\d+)$/.exec(ref || "");
    if (!match) return { error: "bad_ref", message: `${ref} is not a ref; refs look like g3:e12 (from molt-browser snapshot)` };
    const state = window.__moltRefs;
    if (!state || Number(match[1]) !== state.gen) {
      return {
        error: "stale_ref",
        message: state
          ? `${ref} is from an older snapshot (current generation is ${state.gen}). Take a new snapshot.`
          : `${ref} is from before the page changed or navigated. Take a new snapshot.`,
      };
    }
    el = state.refs.get(ref);
    if (!el) return { error: "not_found", message: `${ref} is not in snapshot generation ${state.gen}` };
    if (!el.isConnected) return { error: "stale_ref", message: `${ref} was removed from the page. Take a new snapshot.` };
  }

  let r = el.getBoundingClientRect();
  const fullyVisible = r.top >= 0 && r.left >= 0 && r.bottom <= window.innerHeight && r.right <= window.innerWidth;
  if (!fullyVisible) {
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    r = el.getBoundingClientRect();
  }
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;

  const hit = document.elementFromPoint(x, y);
  let obscuredBy = null;
  if (hit && hit !== el && !el.contains(hit) && !hit.contains(el)) {
    const cls = typeof hit.className === "string" && hit.className.trim() ? "." + hit.className.trim().split(/\s+/)[0] : "";
    obscuredBy = `${hit.tagName.toLowerCase()}${hit.id ? "#" + hit.id : cls}`;
  }

  const text = (el.getAttribute("aria-label") || el.innerText || el.value || el.getAttribute("placeholder") || "").replace(/\s+/g, " ").trim();
  return {
    x,
    y,
    tag: el.tagName.toLowerCase(),
    role: el.getAttribute("role") || el.tagName.toLowerCase(),
    name: text.length > 60 ? text.slice(0, 59) + "…" : text,
    obscured_by: obscuredBy,
  };
}

// Selects the focused field's contents so the next insertText replaces them.
export function prepareTyping() {
  const el = document.activeElement;
  if (!el) return { error: "no_focus", message: "nothing is focused; pass a ref to type into" };
  if (typeof el.select === "function" && "value" in el) {
    el.select();
  } else if (el.isContentEditable) {
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }
  return { ok: true };
}

export function pageText(max) {
  const text = (document.body?.innerText || "").replace(/\n{3,}/g, "\n\n");
  return { url: location.href, title: document.title, text: text.slice(0, max), truncated: text.length > max };
}

export function viewportInfo() {
  return {
    w: window.innerWidth,
    h: window.innerHeight,
    dpr: window.devicePixelRatio || 1,
    scroll_x: Math.round(window.scrollX),
    scroll_y: Math.round(window.scrollY),
    page_h: Math.round(document.documentElement.scrollHeight),
    url: location.href,
    hidden: document.visibilityState !== "visible",
  };
}

// Scrolls the scroll container under the viewport centre, or the page. Used
// for background tabs, where Chrome holds synthetic wheel events until the
// tab paints and would replay them later.
export function scrollPage(dy) {
  let el = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
  while (el && el !== document.body && el !== document.documentElement) {
    const style = getComputedStyle(el);
    if (/(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight) break;
    el = el.parentElement;
  }
  if (!el || el === document.body || el === document.documentElement) el = document.scrollingElement;
  el.scrollBy({ top: dy, behavior: "instant" });
  return { ok: true };
}
