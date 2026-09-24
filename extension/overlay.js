// In-page agent cursor, glow border and Stop pill. Injected on demand by the
// service worker; safe to inject repeatedly. Everything lives in a closed
// shadow root with pointer-events off, so the page's hit testing (and the
// debugger's synthetic clicks) never land on it; only the Stop pill takes
// clicks.
(() => {
  if (window.__moltOverlay) return;

  const host = document.createElement("molt-agent-overlay");
  host.style.cssText = "all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;";
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      .glow {
        position: fixed; inset: 0; pointer-events: none; opacity: 0;
        box-shadow: inset 0 0 0 2px rgba(139, 92, 246, .9), inset 0 0 28px 6px rgba(139, 92, 246, .35);
        transition: opacity .25s ease;
      }
      .on .glow { opacity: 1; animation: breathe 2.4s ease-in-out infinite; }
      @keyframes breathe { 50% { box-shadow: inset 0 0 0 2px rgba(139,92,246,.7), inset 0 0 18px 3px rgba(139,92,246,.22); } }
      .pill {
        position: fixed; top: 10px; left: 50%; transform: translateX(-50%) translateY(-60px);
        display: flex; align-items: center; gap: 8px; padding: 6px 6px 6px 12px;
        font: 500 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        color: #f5f3ff; background: rgba(24, 16, 44, .92); border: 1px solid rgba(139, 92, 246, .6);
        border-radius: 999px; box-shadow: 0 6px 24px rgba(0, 0, 0, .3);
        transition: transform .3s cubic-bezier(.2, .9, .3, 1.2); pointer-events: auto;
      }
      .on .pill { transform: translateX(-50%) translateY(0); }
      .dot { width: 8px; height: 8px; border-radius: 50%; background: #a78bfa; animation: blink 1.2s infinite; }
      @keyframes blink { 50% { opacity: .35; } }
      .stop {
        all: unset; cursor: pointer; padding: 5px 10px; border-radius: 999px;
        background: #ef4444; color: white; font-weight: 600; font-size: 12px; line-height: 1; font-family: inherit;
      }
      .stop:hover { background: #dc2626; }
      .cursor {
        position: fixed; left: 0; top: 0; width: 22px; height: 22px; opacity: 0;
        transform: translate(var(--x, 50vw), var(--y, 50vh));
        transition: transform .45s cubic-bezier(.3, .8, .3, 1), opacity .2s;
        filter: drop-shadow(0 2px 4px rgba(0,0,0,.35));
      }
      .on .cursor.shown { opacity: 1; }
      .cursor svg { position: absolute; left: -3px; top: -2px; }
      .ring {
        position: absolute; left: -14px; top: -14px; width: 28px; height: 28px; border-radius: 50%;
        border: 2px solid #8b5cf6; opacity: 0; transform: scale(.4);
      }
      .ring.go { animation: pulse .55s ease-out; }
      @keyframes pulse { 0% { opacity: .9; transform: scale(.4); } 100% { opacity: 0; transform: scale(1.8); } }
      .label {
        position: absolute; left: 18px; top: 20px; max-width: 280px; white-space: nowrap; overflow: hidden;
        text-overflow: ellipsis; padding: 4px 8px; border-radius: 6px;
        font: 500 12px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        color: white; background: #7c3aed; opacity: 0; transition: opacity .2s;
      }
      .label.shown { opacity: 1; }
      .concealed .cursor, .concealed .pill, .concealed .glow { visibility: hidden; }
    </style>
    <div class="frame">
      <div class="glow"></div>
      <div class="pill"><span class="dot"></span><span>Molt agent is using this tab</span><button class="stop">Stop</button></div>
      <div class="cursor">
        <svg width="22" height="24" viewBox="0 0 22 24"><path d="M3 2 L3 19 L7.5 14.8 L10.6 21.6 L13.6 20.3 L10.6 13.6 L16.8 13.6 Z" fill="#8b5cf6" stroke="white" stroke-width="1.6" stroke-linejoin="round"/></svg>
        <div class="ring"></div>
        <div class="label"></div>
      </div>
    </div>`;

  const frame = root.querySelector(".frame");
  const cursor = root.querySelector(".cursor");
  const ring = root.querySelector(".ring");
  const label = root.querySelector(".label");
  let labelTimer;

  root.querySelector(".stop").addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    chrome.runtime.sendMessage({ molt: "stop" });
    frame.classList.remove("on");
  });

  const mount = () => {
    if (!host.isConnected) (document.body || document.documentElement).appendChild(host);
  };

  const place = (x, y) => {
    cursor.style.setProperty("--x", `${x}px`);
    cursor.style.setProperty("--y", `${y}px`);
  };

  const say = (text) => {
    clearTimeout(labelTimer);
    if (!text) return;
    label.textContent = text;
    label.classList.add("shown");
    labelTimer = setTimeout(() => label.classList.remove("shown"), 2200);
  };

  const ops = {
    show() {
      mount();
      frame.classList.add("on");
    },
    hide() {
      frame.classList.remove("on");
      cursor.classList.remove("shown");
    },
    conceal() {
      frame.classList.add("concealed");
      // Let the compositor drop the overlay before the capture.
      return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    },
    reveal() {
      frame.classList.remove("concealed");
    },
    async move({ x, y, label: text, from }) {
      mount();
      frame.classList.add("on");
      if (!cursor.classList.contains("shown")) {
        // New page or first action: start from where the cursor last was.
        cursor.style.transition = "none";
        place(from?.x ?? window.innerWidth / 2, from?.y ?? window.innerHeight / 2);
        cursor.getBoundingClientRect();
        cursor.style.transition = "";
        cursor.classList.add("shown");
      }
      say(text);
      place(x, y);
      await new Promise((r) => setTimeout(r, 480));
    },
    pulse() {
      ring.classList.remove("go");
      ring.getBoundingClientRect();
      ring.classList.add("go");
    },
    label({ label: text, at }) {
      mount();
      frame.classList.add("on");
      if (at && !cursor.classList.contains("shown")) {
        place(at.x, at.y);
        cursor.classList.add("shown");
      }
      say(text);
    },
  };

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.molt !== "overlay" || !ops[msg.op]) return;
    Promise.resolve(ops[msg.op](msg)).then(() => sendResponse({ ok: true }));
    return true;
  });

  window.__moltOverlay = true;
})();
