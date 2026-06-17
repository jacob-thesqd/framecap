import { invoke } from "@tauri-apps/api/core";

const selEl = document.getElementById("sel");
const dimsEl = document.getElementById("dims");
const hintEl = document.getElementById("hint");
const toolbar = document.getElementById("toolbar");
const recBtn = document.getElementById("rec");
const reselectBtn = document.getElementById("reselect");
const cancelBtn = document.getElementById("cancel");
const countdownEl = document.getElementById("countdown");
const chV = document.getElementById("chV");
const chH = document.getElementById("chH");

// synthetic crosshair: follows the mouse, independent of the OS cursor / key-window state
function showCross(on) { document.body.classList.toggle("cross", on); }
function moveCross(x, y) {
  chV.style.left = x + "px"; chV.style.top = (y - 10) + "px";
  chH.style.top = y + "px"; chH.style.left = (x - 10) + "px";
}
showCross(true);
window.addEventListener("mousemove", (e) => moveCross(e.clientX, e.clientY));
// hide our crosshair over the toolbar so its buttons read as clickable
document.addEventListener("mouseover", (e) => {
  showCross(!(toolbar.contains(e.target)) && !countingDown);
});

let startX = 0, startY = 0, dragging = false;
let rect = null;            // {x,y,w,h} in CSS px
let countingDown = false;
let countdownTimer = null;

function cancel() { invoke("cancel_selection"); }

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (countingDown) abortCountdown();
    else cancel();
  } else if (e.key === "Enter" && e.shiftKey) {
    if (rect && !countingDown) { e.preventDefault(); recBtn.click(); }
  }
});

window.addEventListener("mousedown", (e) => {
  // a click anywhere during the countdown aborts it but keeps the selection
  if (countingDown) { abortCountdown(); return; }
  if (toolbar.contains(e.target)) return;
  dragging = true;
  startX = e.clientX; startY = e.clientY;
  hintEl.style.display = "none";
  toolbar.style.display = "none";
  selEl.style.display = "block";
  dimsEl.style.display = "block";
  updateRect(e.clientX, e.clientY);
});

window.addEventListener("mousemove", (e) => {
  if (!dragging) return;
  updateRect(e.clientX, e.clientY);
});

window.addEventListener("mouseup", () => {
  if (!dragging) return;
  dragging = false;
  if (!rect || rect.w < 8 || rect.h < 8) {
    selEl.style.display = "none";
    hintEl.style.display = "block";
    rect = null;
    return;
  }
  showToolbar();
});

function updateRect(curX, curY) {
  const x = Math.min(startX, curX), y = Math.min(startY, curY);
  const w = Math.abs(curX - startX), h = Math.abs(curY - startY);
  rect = { x, y, w, h };
  selEl.style.left = x + "px";
  selEl.style.top = y + "px";
  selEl.style.width = w + "px";
  selEl.style.height = h + "px";
  dimsEl.textContent = `${Math.round(w)} × ${Math.round(h)}`;
}

function showToolbar() { toolbar.style.display = "flex"; }

function reselect() {
  // keep the overlay; clear the current selection and let the user drag again
  rect = null;
  selEl.style.display = "none";
  toolbar.style.display = "none";
  hintEl.style.display = "block";
}

cancelBtn.addEventListener("click", cancel);
reselectBtn.addEventListener("click", reselect);

function abortCountdown() {
  countingDown = false;
  clearTimeout(countdownTimer);
  countdownTimer = null;
  countdownEl.style.display = "none";
  // restore the selection + toolbar exactly as before
  selEl.style.display = "block";
  dimsEl.style.display = "block";
  showCross(true);
  showToolbar();
}

recBtn.addEventListener("click", () => {
  toolbar.style.display = "none";
  dimsEl.style.display = "none";
  countingDown = true;
  showCross(false);
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
