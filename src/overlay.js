import { invoke } from "@tauri-apps/api/core";

const selEl = document.getElementById("sel");
const chV = document.getElementById("chV");
const chH = document.getElementById("chH");
const recBtn = document.getElementById("rec");
const reselectBtn = document.getElementById("reselect");
const cancelBtn = document.getElementById("cancel");
const countdownEl = document.getElementById("countdown");
const control = document.getElementById("control");
const inW = document.getElementById("inW");
const inH = document.getElementById("inH");
const inX = document.getElementById("inX");
const inY = document.getElementById("inY");

const MIN = 8;
let rect = null;        // {x,y,w,h} CSS px
let phase = "idle";     // idle | creating | ready
let action = null;      // {type, handle, sx, sy, orig}
let countingDown = false;
let countdownTimer = null;

function setPhase(p) { phase = p; document.body.className = p; }
function cancel() { invoke("cancel_selection"); }

const vw = () => window.innerWidth;
const vh = () => window.innerHeight;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function renderSel() {
  if (!rect) return;
  selEl.style.left = rect.x + "px";
  selEl.style.top = rect.y + "px";
  selEl.style.width = rect.w + "px";
  selEl.style.height = rect.h + "px";
}
function updateInputs() {
  if (!rect) return;
  inW.value = Math.round(rect.w);
  inH.value = Math.round(rect.h);
  inX.value = Math.round(rect.x);
  inY.value = Math.round(rect.y);
}

// ---- crosshair ----
function moveCross(x, y) {
  chV.style.left = x + "px"; chV.style.top = (y - 10) + "px";
  chH.style.top = y + "px"; chH.style.left = (x - 10) + "px";
}

// ---- pointer interactions ----
window.addEventListener("mousedown", (e) => {
  if (countingDown) { abortCountdown(); return; }
  if (control.contains(e.target)) return; // let panel inputs/buttons work

  if (phase === "idle") {
    action = { type: "create", sx: e.clientX, sy: e.clientY };
    rect = { x: e.clientX, y: e.clientY, w: 0, h: 0 };
    setPhase("creating");
    renderSel();
    return;
  }

  if (phase === "ready") {
    const handle = e.target.dataset && e.target.dataset.h;
    if (handle) {
      action = { type: "resize", handle, sx: e.clientX, sy: e.clientY, orig: { ...rect } };
    } else if (e.target === selEl || selEl.contains(e.target)) {
      action = { type: "move", sx: e.clientX, sy: e.clientY, orig: { ...rect } };
    }
    // clicking outside the selection does nothing (only Esc exits)
  }
});

window.addEventListener("mousemove", (e) => {
  if (phase === "idle" || phase === "creating") moveCross(e.clientX, e.clientY);
  if (!action) return;
  const dx = e.clientX - action.sx, dy = e.clientY - action.sy;

  if (action.type === "create") {
    const x = Math.min(action.sx, e.clientX), y = Math.min(action.sy, e.clientY);
    rect = { x, y, w: Math.abs(e.clientX - action.sx), h: Math.abs(e.clientY - action.sy) };
    renderSel();
  } else if (action.type === "move") {
    const o = action.orig;
    rect.x = clamp(o.x + dx, 0, vw() - o.w);
    rect.y = clamp(o.y + dy, 0, vh() - o.h);
    renderSel(); updateInputs();
  } else if (action.type === "resize") {
    const o = action.orig, hdl = action.handle;
    let L = o.x, T = o.y, R = o.x + o.w, B = o.y + o.h;
    if (hdl.includes("w")) L = clamp(o.x + dx, 0, R - MIN);
    if (hdl.includes("e")) R = clamp(o.x + o.w + dx, L + MIN, vw());
    if (hdl.includes("n")) T = clamp(o.y + dy, 0, B - MIN);
    if (hdl.includes("s")) B = clamp(o.y + o.h + dy, T + MIN, vh());
    rect = { x: L, y: T, w: R - L, h: B - T };
    renderSel(); updateInputs();
  }
});

window.addEventListener("mouseup", () => {
  if (!action) return;
  if (action.type === "create") {
    if (rect && rect.w >= MIN && rect.h >= MIN) {
      setPhase("ready"); renderSel(); updateInputs();
    } else {
      rect = null; setPhase("idle");
    }
  }
  action = null;
});

// ---- size/position inputs ----
function applyInputs() {
  if (!rect) return;
  let w = clamp(Math.round(+inW.value) || MIN, MIN, vw());
  let h = clamp(Math.round(+inH.value) || MIN, MIN, vh());
  let x = clamp(Math.round(+inX.value) || 0, 0, vw() - w);
  let y = clamp(Math.round(+inY.value) || 0, 0, vh() - h);
  rect = { x, y, w, h };
  renderSel(); updateInputs();
}
[inW, inH, inX, inY].forEach((el) => el.addEventListener("change", applyInputs));

// ---- keyboard ----
window.addEventListener("keydown", (e) => {
  const typing = ["INPUT"].includes(e.target.tagName);
  if (e.key === "Escape") {
    if (countingDown) abortCountdown(); else cancel();
  } else if (e.key === "Enter" && e.shiftKey) {
    if (rect && phase === "ready" && !countingDown) { e.preventDefault(); recBtn.click(); }
  } else if (e.key === "Enter" && typing) {
    applyInputs(); e.target.blur();
  }
});

// ---- buttons ----
cancelBtn.addEventListener("click", cancel);
reselectBtn.addEventListener("click", () => {
  rect = null; action = null; setPhase("idle");
});

function abortCountdown() {
  countingDown = false;
  clearTimeout(countdownTimer); countdownTimer = null;
  countdownEl.style.display = "none";
  setPhase("ready"); renderSel(); updateInputs();
}

recBtn.addEventListener("click", () => {
  if (!rect) return;
  setPhase("hidden");
  document.body.className = ""; // hide all chrome during countdown
  countingDown = true;
  let n = 3;
  countdownEl.style.display = "block";
  countdownEl.textContent = String(n);
  const tick = () => {
    if (!countingDown) return;
    n -= 1;
    if (n >= 1) {
      countdownEl.textContent = String(n);
      countdownTimer = setTimeout(tick, 1000);
    } else {
      countingDown = false;
      countdownEl.style.display = "none";
      const dpr = window.devicePixelRatio || 1;
      invoke("start_recording", {
        x: Math.round(rect.x), y: Math.round(rect.y),
        w: Math.round(rect.w), h: Math.round(rect.h), scale: dpr,
      });
    }
  };
  countdownTimer = setTimeout(tick, 1000);
});
