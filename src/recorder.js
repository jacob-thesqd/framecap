import { invoke } from "@tauri-apps/api/core";

const timeEl = document.getElementById("time");
const dot = document.getElementById("dot");
const stopBtn = document.getElementById("stop");
const pauseBtn = document.getElementById("pause");
const restartBtn = document.getElementById("restart");
const delBtn = document.getElementById("del");

const PAUSE_SVG = `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>`;
const PLAY_SVG = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4v16l13-8z"/></svg>`;
pauseBtn.innerHTML = PAUSE_SVG;

let seconds = 0;
let paused = false;
let tick = setInterval(onTick, 1000);

function onTick() {
  if (paused) return;
  seconds++;
  const m = Math.floor(seconds / 60);
  const s = String(seconds % 60).padStart(2, "0");
  timeEl.textContent = `${m}:${s}`;
}

stopBtn.addEventListener("click", async () => {
  clearInterval(tick);
  stopBtn.disabled = true;
  stopBtn.textContent = "…";
  await invoke("stop_recording");
});

pauseBtn.addEventListener("click", async () => {
  if (!paused) {
    const ok = await invoke("pause_recording");
    if (ok) { paused = true; pauseBtn.innerHTML = PLAY_SVG; pauseBtn.title = "Resume"; dot.classList.add("paused"); }
  } else {
    const ok = await invoke("resume_recording");
    if (ok) { paused = false; pauseBtn.innerHTML = PAUSE_SVG; pauseBtn.title = "Pause"; dot.classList.remove("paused"); }
  }
});

restartBtn.addEventListener("click", async () => {
  clearInterval(tick);
  await invoke("restart_recording");
});

delBtn.addEventListener("click", async () => {
  clearInterval(tick);
  await invoke("delete_recording");
});
