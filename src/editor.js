import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { writeImage } from "@tauri-apps/plugin-clipboard-manager";
import { Image } from "@tauri-apps/api/image";
import { save, open } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";

const video = document.getElementById("video");
const vstage = document.getElementById("vstage");
const preview = document.getElementById("preview");
const pctx = preview.getContext("2d");
const work = document.getElementById("work");
const wctx = work.getContext("2d");
const filmstrip = document.getElementById("filmstrip");
const emptyMsg = document.getElementById("emptyMsg");
const frameCountEl = document.getElementById("frameCount");
const timeEl = document.getElementById("time");
const errbar = document.getElementById("errbar");

const FPS = 30; // recordings are 30fps
let frames = []; // {id, t, dataUrl, selected}
let nextId = 1;

// crop + annotation state (all in natural video px)
let cropRect = null;        // {x,y,w,h} or null
let globalAnnos = [];       // shapes drawn on the video, baked into every captured frame
let mode = "view";          // "view" | "crop" | "anno"

function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.remove("show"), 1600);
}

// ================= LOAD SOURCE =================
// Read bytes through the backend and play as a Blob — avoids asset-protocol
// scope/timing issues that left the player black with 0:00 duration.
let currentBlobUrl = null;
async function loadSrc(path) {
  errbar.classList.remove("show");
  try {
    const buf = await invoke("read_recording", { path });
    const bytes = buf instanceof ArrayBuffer ? buf : new Uint8Array(buf);
    const blob = new Blob([bytes], { type: "video/mp4" });
    if (currentBlobUrl) URL.revokeObjectURL(currentBlobUrl);
    currentBlobUrl = URL.createObjectURL(blob);
    video.src = currentBlobUrl;
    video.load();
  } catch (e) {
    showError("Couldn't load recording — " + e);
  }
}
let loadedPath = null;
function loadRecording(path) {
  if (!path || path === loadedPath) return;
  loadedPath = path;
  frames = []; render();
  cropRect = null; globalAnnos = []; updateCropInfo();
  loadSrc(path);
}
function showError(msg) { errbar.textContent = "⚠ " + msg; errbar.classList.add("show"); }

function playerEmpty() { return !video.duration || isNaN(video.duration); }

// self-heal: load the newest recording on disk if the player is blank
async function loadLatestIfEmpty() {
  if (!playerEmpty()) return;
  const p = await invoke("latest_recording");
  if (p) loadRecording(p);
}

video.addEventListener("error", () => {
  // a blob decode error shouldn't happen, but fall back to re-reading the newest file
  loadLatestIfEmpty();
});

// poll for the pending recording path — the finalize can beat the event listener
// registration (esp. for short clips), so a one-shot read can miss it
let pollTries = 0;
function pollPending() {
  invoke("take_pending_src").then((p) => {
    if (p) { loadRecording(p); return; }
    invoke("take_pending_error").then((m) => {
      if (m) { showError(m); return; }
      pollTries++;
      // after ~1.5s with nothing handed off, fall back to the newest recording
      if (pollTries === 6) loadLatestIfEmpty();
      if (pollTries < 40) setTimeout(pollPending, 250);
    });
  });
}
pollPending();
// whenever the editor regains focus and is blank, load the newest recording
getCurrentWindow().onFocusChanged(({ payload: focused }) => {
  if (focused) loadLatestIfEmpty();
});
listen("recording-ready", (e) => { if (e.payload) loadRecording(e.payload); });
listen("recording-failed", (e) => {
  const p = typeof e.payload === "string" ? e.payload : "";
  showError(p && p.includes("permission") ? p : "Capture failed — grant FrameCap “Screen Recording” in System Settings → Privacy & Security, then re-record.");
  if (p) console.error("ffmpeg:\n" + p);
});

// ================= PREVIEW CANVAS =================
// Region of the source video shown in the preview (full while cropping, else the crop).
function srcRegion() {
  if (mode === "crop" || !cropRect) return { x: 0, y: 0, w: video.videoWidth, h: video.videoHeight };
  return cropRect;
}

function fitPreview() {
  if (!video.videoWidth) return;
  const s = srcRegion();
  const box = vstage.getBoundingClientRect();
  const avW = Math.max(40, box.width - 4), avH = Math.max(40, box.height - 4);
  const scale = Math.min(avW / s.w, avH / s.h);
  preview.width = Math.round(s.w * scale);
  preview.height = Math.round(s.h * scale);
  preview.style.width = preview.width + "px";
  preview.style.height = preview.height + "px";
  preview._scale = scale;
  preview._src = s;
}

let cropPx = null; // selection rect in preview pixels (crop mode)

function drawPreview() {
  if (!video.videoWidth) return;
  if (!preview._src) fitPreview();
  const s = preview._src, scale = preview._scale;
  pctx.setTransform(1, 0, 0, 1, 0, 0);
  pctx.clearRect(0, 0, preview.width, preview.height);
  pctx.drawImage(video, s.x, s.y, s.w, s.h, 0, 0, preview.width, preview.height);

  // video-level annotations (natural coords → preview)
  pctx.save();
  pctx.setTransform(scale, 0, 0, scale, -s.x * scale, -s.y * scale);
  globalAnnos.forEach((sh) => drawShape(pctx, sh, 1));
  if (annoCur) drawShape(pctx, annoCur, 1);
  pctx.restore();

  // crop selection overlay
  if (mode === "crop" && cropPx) {
    const { x, y, w, h } = cropPx, W = preview.width, H = preview.height;
    pctx.fillStyle = "rgba(0,0,0,0.5)";
    pctx.fillRect(0, 0, W, y);
    pctx.fillRect(0, y + h, W, H - (y + h));
    pctx.fillRect(0, y, x, h);
    pctx.fillRect(x + w, y, W - (x + w), h);
    pctx.strokeStyle = "#513DE5"; pctx.lineWidth = 1.5;
    pctx.strokeRect(x, y, w, h);
  }
}

let rafActive = false;
function loop() {
  drawPreview();
  if (!video.paused && !video.ended) requestAnimationFrame(loop);
  else rafActive = false;
}
function startLoop() { if (!rafActive) { rafActive = true; requestAnimationFrame(loop); } }

window.addEventListener("resize", () => { fitPreview(); drawPreview(); });

// ================= TRANSPORT =================
const playBtn = document.getElementById("playBtn");
const seek = document.getElementById("seek");

playBtn.addEventListener("click", () => { video.paused ? video.play() : video.pause(); });
video.addEventListener("play", () => { playBtn.textContent = "❚❚"; startLoop(); });
video.addEventListener("pause", () => { playBtn.textContent = "►"; drawPreview(); });
video.addEventListener("ended", () => { playBtn.textContent = "►"; });

seek.addEventListener("input", () => {
  if (!video.duration) return;
  video.currentTime = (seek.value / 1000) * video.duration;
});
video.addEventListener("timeupdate", () => {
  timeEl.textContent = `${video.currentTime.toFixed(2)} / ${(video.duration || 0).toFixed(2)}s`;
  if (video.duration) seek.value = String((video.currentTime / video.duration) * 1000);
});
video.addEventListener("seeked", drawPreview);
video.addEventListener("loadedmetadata", () => {
  timeEl.textContent = `0.00 / ${(video.duration || 0).toFixed(2)}s`;
  fitPreview();
  // the genuine first frame can be black; jump just past it so the preview shows content
  try { video.currentTime = Math.min(0.05, (video.duration || 1) / 2); } catch { /* ignore */ }
});
video.addEventListener("loadeddata", () => {
  fitPreview();
  // draw as soon as a real frame is available
  if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(() => drawPreview());
  else drawPreview();
});

function stepFrame(dir) {
  video.pause();
  const dt = 1 / FPS;
  video.currentTime = Math.max(0, Math.min(video.duration || 0, video.currentTime + dir * dt));
}
document.getElementById("stepBack").addEventListener("click", () => stepFrame(-1));
document.getElementById("stepFwd").addEventListener("click", () => stepFrame(1));

// ================= FRAME GRABBING (crop + video annotations baked in) =================
function grabCurrentFrame() {
  if (!video.videoWidth) return null;
  const s = cropRect || { x: 0, y: 0, w: video.videoWidth, h: video.videoHeight };
  work.width = s.w; work.height = s.h;
  wctx.setTransform(1, 0, 0, 1, 0, 0);
  wctx.drawImage(video, s.x, s.y, s.w, s.h, 0, 0, s.w, s.h);
  wctx.save();
  wctx.setTransform(1, 0, 0, 1, -s.x, -s.y); // natural → frame coords
  globalAnnos.forEach((sh) => drawShape(wctx, sh, 1));
  wctx.restore();
  return work.toDataURL("image/png");
}

function addFrame(t, dataUrl) { frames.push({ id: nextId++, t, dataUrl, selected: true }); render(); }

document.getElementById("capBtn").addEventListener("click", () => {
  const d = grabCurrentFrame();
  if (d) { addFrame(video.currentTime, d); toast("Frame captured"); }
});

// keyboard: ← / → step one frame, Return captures the current frame
window.addEventListener("keydown", (e) => {
  if (annoModal.classList.contains("open")) return;           // modal handles its own
  if (e.key === "Enter" && e.shiftKey) {                      // Shift+Return → copy collage
    e.preventDefault();
    document.getElementById("collageCopy").click();
    return;
  }
  const tag = (e.target && e.target.tagName) || "";
  if (tag === "INPUT" || tag === "TEXTAREA") return;          // don't hijack typing
  if (e.key === "ArrowLeft") { e.preventDefault(); stepFrame(-1); }
  else if (e.key === "ArrowRight") { e.preventDefault(); stepFrame(1); }
  else if (e.key === "ArrowUp") {
    e.preventDefault();
    const d = grabCurrentFrame();
    if (d) { addFrame(video.currentTime, d); toast("Frame captured"); }
  }
});

// ================= SHAPE DRAWING (shared) =================
const TOOLS = [
  { id: "rect", label: "▭" }, { id: "ellipse", label: "◯" }, { id: "arrow", label: "↗" },
  { id: "line", label: "／" }, { id: "pen", label: "✎" }, { id: "text", label: "T" },
];
const COLORS = ["#ef4444", "#f59e0b", "#22c55e", "#3b82f6", "#a855f7", "#ffffff", "#111111"];
let annoTool = "rect", annoColor = "#ef4444", annoWidth = 4;

function drawShape(ctx, sh, k = 1) {
  ctx.strokeStyle = sh.color; ctx.fillStyle = sh.color;
  ctx.lineWidth = Math.max(1, sh.width * k); ctx.lineCap = "round"; ctx.lineJoin = "round";
  const x = sh.x * k, y = sh.y * k, w = sh.w * k, h = sh.h * k;
  if (sh.type === "rect") ctx.strokeRect(x, y, w, h);
  else if (sh.type === "ellipse") { ctx.beginPath(); ctx.ellipse(x + w / 2, y + h / 2, Math.abs(w / 2), Math.abs(h / 2), 0, 0, Math.PI * 2); ctx.stroke(); }
  else if (sh.type === "line" || sh.type === "arrow") {
    const x2 = x + w, y2 = y + h;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x2, y2); ctx.stroke();
    if (sh.type === "arrow") {
      const ang = Math.atan2(y2 - y, x2 - x), len = 10 * k + sh.width * k * 1.5;
      ctx.beginPath(); ctx.moveTo(x2, y2);
      ctx.lineTo(x2 - len * Math.cos(ang - 0.4), y2 - len * Math.sin(ang - 0.4));
      ctx.moveTo(x2, y2);
      ctx.lineTo(x2 - len * Math.cos(ang + 0.4), y2 - len * Math.sin(ang + 0.4));
      ctx.stroke();
    }
  } else if (sh.type === "pen") {
    ctx.beginPath();
    sh.pts.forEach((p, i) => { const px = p.x * k, py = p.y * k; i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
    ctx.stroke();
  } else if (sh.type === "text") {
    const fs = sh.width * k * 6 + 8;
    ctx.font = `700 ${fs}px Inter, sans-serif`; ctx.textBaseline = "top";
    ctx.fillText(sh.text, x, y);
  }
}

// build a tool palette into a container; onChange redraws the target
function buildPalette(container, { onUndo, onClear }) {
  container.innerHTML = "";
  const tools = document.createElement("div"); tools.className = "annogroup";
  TOOLS.forEach((t) => {
    const b = document.createElement("button");
    b.className = "annotool" + (t.id === annoTool ? " active" : "");
    b.textContent = t.label; b.title = t.id; b.dataset.tool = t.id;
    b.addEventListener("click", () => { annoTool = t.id; container.querySelectorAll(".annotool").forEach((x) => x.classList.toggle("active", x.dataset.tool === t.id)); });
    tools.appendChild(b);
  });
  const colors = document.createElement("div"); colors.className = "annogroup";
  COLORS.forEach((c) => {
    const s = document.createElement("div");
    s.className = "annoswatch" + (c === annoColor ? " active" : "");
    s.style.background = c; s.dataset.color = c;
    s.addEventListener("click", () => { annoColor = c; container.querySelectorAll(".annoswatch").forEach((x) => x.classList.toggle("active", x.dataset.color === c)); });
    colors.appendChild(s);
  });
  const wg = document.createElement("div"); wg.className = "annogroup";
  wg.innerHTML = `<label class="annolbl">Width</label>`;
  const wi = document.createElement("input"); wi.type = "range"; wi.min = "1"; wi.max = "24"; wi.value = String(annoWidth);
  wi.addEventListener("input", (e) => { annoWidth = parseInt(e.target.value); });
  wg.appendChild(wi);
  const undo = document.createElement("button"); undo.className = "annobtn ghost"; undo.textContent = "Undo"; undo.addEventListener("click", onUndo);
  const clear = document.createElement("button"); clear.className = "annobtn ghost"; clear.textContent = "Clear"; clear.addEventListener("click", onClear);
  container.append(tools, colors, wg, undo, clear);
}

// ================= CROP =================
const cropBtn = document.getElementById("cropBtn");
const cropInfo = document.getElementById("cropInfo");
const cropTools = document.getElementById("cropTools");

function updateCropInfo() { cropInfo.textContent = cropRect ? `crop ${cropRect.w}×${cropRect.h}  ✕` : ""; }
cropInfo.addEventListener("click", () => {
  if (cropRect) { cropRect = null; updateCropInfo(); fitPreview(); drawPreview(); toast("Crop cleared"); }
});

function setMode(m) {
  mode = m;
  cropBtn.classList.toggle("active", m === "crop");
  document.getElementById("annoBtn").classList.toggle("active", m === "anno");
  document.getElementById("annoInline").classList.toggle("open", m === "anno");
  cropTools.style.display = "none";
  cropPx = null;
  preview.classList.toggle("interactive", m !== "view");
  if (m === "crop") video.pause();
  if (m === "anno") video.pause();
  fitPreview(); drawPreview();
}

cropBtn.addEventListener("click", () => {
  if (mode === "crop") { setMode("view"); return; }
  if (!video.videoWidth) { toast("Video not ready"); return; }
  setMode("crop");
});
document.getElementById("cropCancel").addEventListener("click", () => setMode("view"));
document.getElementById("cropApply").addEventListener("click", () => {
  if (!cropPx) { setMode("view"); return; }
  const scale = preview._scale;
  cropRect = {
    x: Math.round(cropPx.x / scale), y: Math.round(cropPx.y / scale),
    w: Math.round(cropPx.w / scale), h: Math.round(cropPx.h / scale),
  };
  updateCropInfo();
  setMode("view");
  toast(`Crop ${cropRect.w}×${cropRect.h}`);
});

// ================= POINTER ON PREVIEW (crop draw + video annotate) =================
let dragging = false, p0 = null, annoCur = null;

function previewPos(e) {
  const r = preview.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}
// preview px → natural coords (using current src region)
function toNatural(p) {
  const s = preview._src, scale = preview._scale;
  return { x: s.x + p.x / scale, y: s.y + p.y / scale };
}

preview.addEventListener("mousedown", (e) => {
  if (mode === "view") return;
  const p = previewPos(e);
  if (mode === "crop") { dragging = true; p0 = p; cropPx = { x: p.x, y: p.y, w: 0, h: 0 }; cropTools.style.display = "none"; return; }
  // annotate
  if (annoTool === "text") {
    const text = window.prompt("Annotation text:");
    if (text) { const n = toNatural(p); globalAnnos.push({ type: "text", x: n.x, y: n.y, w: 0, h: 0, color: annoColor, width: annoWidth, text }); drawPreview(); }
    return;
  }
  dragging = true; p0 = toNatural(p);
  if (annoTool === "pen") annoCur = { type: "pen", pts: [p0], color: annoColor, width: annoWidth };
  else annoCur = { type: annoTool, x: p0.x, y: p0.y, w: 0, h: 0, color: annoColor, width: annoWidth };
});
window.addEventListener("mousemove", (e) => {
  if (!dragging) return;
  const p = previewPos(e);
  if (mode === "crop") {
    const cx = Math.max(0, Math.min(preview.width, p.x)), cy = Math.max(0, Math.min(preview.height, p.y));
    cropPx = { x: Math.min(p0.x, cx), y: Math.min(p0.y, cy), w: Math.abs(cx - p0.x), h: Math.abs(cy - p0.y) };
    drawPreview();
  } else if (mode === "anno") {
    const n = toNatural(p);
    if (annoTool === "pen") annoCur.pts.push(n);
    else { annoCur.w = n.x - p0.x; annoCur.h = n.y - p0.y; }
    drawPreview();
  }
});
window.addEventListener("mouseup", () => {
  if (!dragging) return;
  dragging = false;
  if (mode === "crop") {
    if (cropPx && cropPx.w > 6 && cropPx.h > 6) cropTools.style.display = "flex";
  } else if (mode === "anno" && annoCur) {
    globalAnnos.push(annoCur); annoCur = null; drawPreview();
  }
});

// annotate-video toggle
document.getElementById("annoBtn").addEventListener("click", () => {
  if (mode === "anno") { setMode("view"); return; }
  if (!video.videoWidth) { toast("Video not ready"); return; }
  buildPalette(document.getElementById("annoInline"), {
    onUndo: () => { globalAnnos.pop(); drawPreview(); },
    onClear: () => { globalAnnos = []; drawPreview(); },
  });
  setMode("anno");
});

// ================= FILMSTRIP =================
function render() {
  emptyMsg.style.display = frames.length ? "none" : "block";
  frameCountEl.textContent = frames.length ? `(${frames.filter((f) => f.selected).length}/${frames.length} selected)` : "";
  [...filmstrip.querySelectorAll(".frame")].forEach((n) => n.remove());
  frames.forEach((f, idx) => {
    const el = document.createElement("div");
    el.className = "frame" + (f.selected ? " sel" : "");
    el.innerHTML = `
      <img src="${f.dataUrl}" />
      <span class="meta">${f.t.toFixed(2)}s</span>
      <span class="pick">${f.selected ? idx + 1 : ""}</span>
      <div class="acts">
        <button data-act="anno">Edit</button>
        <button data-act="copy">Copy</button>
        <button data-act="save">Save</button>
        <button data-act="del">✕</button>
      </div>`;
    el.addEventListener("click", (e) => { if (e.target.closest("button")) return; f.selected = !f.selected; render(); });
    el.querySelector('[data-act="anno"]').addEventListener("click", (e) => { e.stopPropagation(); openAnnotator(f); });
    el.querySelector('[data-act="copy"]').addEventListener("click", (e) => { e.stopPropagation(); copyDataUrl(f.dataUrl); });
    el.querySelector('[data-act="save"]').addEventListener("click", (e) => { e.stopPropagation(); saveDataUrl(f.dataUrl, `frame-${f.t.toFixed(2)}s.png`); });
    el.querySelector('[data-act="del"]').addEventListener("click", (e) => { e.stopPropagation(); frames = frames.filter((x) => x.id !== f.id); render(); });
    filmstrip.appendChild(el);
  });
}

// ================= CLIPBOARD / SAVE =================
async function dataUrlToBytes(dataUrl) { return new Uint8Array(await (await fetch(dataUrl)).arrayBuffer()); }
async function copyDataUrl(dataUrl) {
  try { await writeImage(await Image.fromBytes(await dataUrlToBytes(dataUrl))); toast("Copied to clipboard"); }
  catch (e) { console.error(e); toast("Copy failed: " + e); }
}
async function saveDataUrl(dataUrl, suggested) {
  const path = await save({ defaultPath: suggested, filters: [{ name: "PNG", extensions: ["png"] }] });
  if (!path) return;
  await writeFile(path, await dataUrlToBytes(dataUrl));
  toast("Saved");
}

// ================= PER-FRAME ANNOTATION MODAL =================
const annoModal = document.getElementById("annoModal");
const annoCanvas = document.getElementById("annoCanvas");
const actx = annoCanvas.getContext("2d");
let mShapes = [], mBase = null, mFrame = null, mView = 1, mDrawing = false, mP0 = null, mCur = null;

function openAnnotator(frame) {
  mFrame = frame; mShapes = [];
  mBase = new window.Image();
  mBase.onload = () => {
    const maxW = window.innerWidth - 80, maxH = window.innerHeight - 130;
    mView = Math.min(1, maxW / mBase.width, maxH / mBase.height);
    annoCanvas.width = Math.round(mBase.width * mView);
    annoCanvas.height = Math.round(mBase.height * mView);
    redrawModal();
    annoModal.classList.add("open");
  };
  mBase.src = frame.dataUrl;
}
function mPos(e) { const r = annoCanvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
function redrawModal() {
  actx.setTransform(1, 0, 0, 1, 0, 0);
  actx.clearRect(0, 0, annoCanvas.width, annoCanvas.height);
  actx.drawImage(mBase, 0, 0, annoCanvas.width, annoCanvas.height);
  mShapes.forEach((sh) => drawShape(actx, sh, 1));
  if (mCur) drawShape(actx, mCur, 1);
}
annoCanvas.addEventListener("mousedown", (e) => {
  const p = mPos(e);
  if (annoTool === "text") {
    const text = window.prompt("Annotation text:");
    if (text) { mShapes.push({ type: "text", x: p.x, y: p.y, w: 0, h: 0, color: annoColor, width: annoWidth, text }); redrawModal(); }
    return;
  }
  mDrawing = true; mP0 = p;
  if (annoTool === "pen") mCur = { type: "pen", pts: [p], color: annoColor, width: annoWidth };
  else mCur = { type: annoTool, x: p.x, y: p.y, w: 0, h: 0, color: annoColor, width: annoWidth };
});
annoCanvas.addEventListener("mousemove", (e) => {
  if (!mDrawing) return;
  const p = mPos(e);
  if (annoTool === "pen") mCur.pts.push(p);
  else { mCur.w = p.x - mP0.x; mCur.h = p.y - mP0.y; }
  redrawModal();
});
window.addEventListener("mouseup", () => { if (!mDrawing) return; mDrawing = false; if (mCur) mShapes.push(mCur); mCur = null; redrawModal(); });

// modal toolbar (shared palette)
buildPalette(document.getElementById("annoTools"), {
  onUndo: () => { mShapes.pop(); redrawModal(); },
  onClear: () => { mShapes = []; redrawModal(); },
});

document.getElementById("annoCancelBtn").addEventListener("click", () => annoModal.classList.remove("open"));
document.getElementById("annoSave").addEventListener("click", () => {
  work.width = mBase.width; work.height = mBase.height;
  wctx.setTransform(1, 0, 0, 1, 0, 0);
  wctx.drawImage(mBase, 0, 0);
  const k = 1 / mView;
  mShapes.forEach((sh) => drawShape(wctx, sh, k));
  mFrame.dataUrl = work.toDataURL("image/png");
  annoModal.classList.remove("open");
  render();
  toast("Annotation saved");
});

// ================= COLLAGE =================
async function buildCollage() {
  const sel = frames.filter((f) => f.selected);
  if (sel.length < 1) { toast("Select at least one frame"); return null; }
  const gap = 8, pad = 8, bg = "#0e0e11";
  const numbered = document.getElementById("numbered").checked;
  let cols = parseInt(document.getElementById("cols").value) || 0;
  if (cols <= 0) cols = sel.length;
  const rows = Math.ceil(sel.length / cols);
  const imgs = await Promise.all(sel.map((f) => loadImg(f.dataUrl)));
  const cw = imgs[0].width, ch = imgs[0].height;
  const W = pad * 2 + cols * cw + (cols - 1) * gap;
  const H = pad * 2 + rows * ch + (rows - 1) * gap;
  work.width = W; work.height = H;
  wctx.setTransform(1, 0, 0, 1, 0, 0);
  wctx.fillStyle = bg; wctx.fillRect(0, 0, W, H);
  imgs.forEach((img, i) => {
    const c = i % cols, r = Math.floor(i / cols);
    const x = pad + c * (cw + gap), y = pad + r * (ch + gap);
    wctx.drawImage(img, x, y, cw, ch);
    if (numbered) {
      const label = `${i + 1}  ${sel[i].t.toFixed(2)}s`;
      wctx.font = `700 ${Math.max(13, Math.round(cw * 0.035))}px Inter, sans-serif`;
      const tw = wctx.measureText(label).width;
      wctx.fillStyle = "rgba(0,0,0,.65)"; wctx.fillRect(x + 8, y + 8, tw + 14, 26);
      wctx.fillStyle = "#fff"; wctx.textBaseline = "middle"; wctx.fillText(label, x + 15, y + 22);
    }
  });
  return { dataUrl: work.toDataURL("image/png"), count: sel.length };
}

document.getElementById("collageCopy").addEventListener("click", async () => {
  const c = await buildCollage();
  if (c) await copyDataUrl(c.dataUrl); // toasts "Copied to clipboard"
});
document.getElementById("collageSave").addEventListener("click", async () => {
  const c = await buildCollage();
  if (c) await saveDataUrl(c.dataUrl, `collage-${c.count}frames.png`);
});
function loadImg(src) { return new Promise((res) => { const i = new window.Image(); i.onload = () => res(i); i.src = src; }); }

// ================= HEADER =================
document.getElementById("clearAll").addEventListener("click", () => {
  if (!frames.length) return;
  frames = []; render(); toast("All frames cleared");
});
document.getElementById("newBtn").addEventListener("click", () => invoke("start_selection"));
document.getElementById("loadBtn").addEventListener("click", async () => {
  const path = await open({ filters: [{ name: "Video", extensions: ["mp4", "mov", "m4v"] }] });
  if (path) { frames = []; cropRect = null; globalAnnos = []; updateCropInfo(); render(); loadSrc(path); }
});
