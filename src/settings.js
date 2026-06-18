import { invoke } from "@tauri-apps/api/core";

const verEl = document.getElementById("ver");
const scKbd = document.getElementById("scKbd");
const scBtn = document.getElementById("scBtn");
const scSub = document.getElementById("scSub");
const checkBtn = document.getElementById("checkBtn");
const statusEl = document.getElementById("status");

let currentShortcut = "";

function pretty(accel) {
  return accel
    .replace(/CmdOrCtrl|Cmd|Super|Meta/gi, "⌘")
    .replace(/Ctrl|Control/gi, "⌃")
    .replace(/Alt|Option/gi, "⌥")
    .replace(/Shift/gi, "⇧")
    .replace(/\+/g, "");
}

async function loadSettings() {
  const s = await invoke("get_settings");
  verEl.textContent = "version " + s.version;
  currentShortcut = s.shortcut;
  scKbd.textContent = pretty(s.shortcut);
}
loadSettings();

// ---- update check ----
checkBtn.addEventListener("click", async () => {
  statusEl.textContent = "Checking…";
  checkBtn.disabled = true;
  try {
    const msg = await invoke("check_updates_now");
    statusEl.textContent = msg; // if an update installs, the app restarts before this
  } catch (e) {
    statusEl.textContent = "Update check failed: " + e;
  } finally {
    checkBtn.disabled = false;
  }
});

// ---- shortcut rebinding ----
let recording = false;

function keyName(e) {
  const c = e.code;
  if (c.startsWith("Key")) return c.slice(3);            // KeyA -> A
  if (c.startsWith("Digit")) return c.slice(5);          // Digit1 -> 1
  if (c.startsWith("Numpad")) return c.slice(6);
  if (c.startsWith("Arrow")) return c.slice(5);          // ArrowUp -> Up
  if (/^F\d{1,2}$/.test(c)) return c;                    // F1..F12
  const named = { Space: "Space", Enter: "Enter", Tab: "Tab", Backquote: "`", Minus: "-", Equal: "=", Comma: ",", Period: ".", Slash: "/" };
  return named[c] || null;
}

scBtn.addEventListener("click", () => {
  if (recording) return;
  recording = true;
  scKbd.classList.add("recording");
  scKbd.textContent = "Press keys…";
  scSub.textContent = "Press a combination with at least one modifier (Esc to cancel)";
});

window.addEventListener("keydown", async (e) => {
  if (!recording) return;
  e.preventDefault();
  if (e.key === "Escape") {
    recording = false;
    scKbd.classList.remove("recording");
    scKbd.textContent = pretty(currentShortcut);
    scSub.textContent = "Click, then press the new combination";
    return;
  }
  const mods = [];
  if (e.metaKey) mods.push("Cmd");
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  const key = keyName(e);
  if (!key) return;                 // wait for a non-modifier key
  if (mods.length === 0) {
    scSub.textContent = "Needs at least one modifier (⌘ ⌃ ⌥)";
    return;
  }
  const accel = [...mods, key].join("+");
  recording = false;
  scKbd.classList.remove("recording");
  try {
    await invoke("set_shortcut", { accelerator: accel });
    currentShortcut = accel;
    scKbd.textContent = pretty(accel);
    scSub.textContent = "Saved";
    statusEl.textContent = `Record shortcut set to ${pretty(accel)}`;
  } catch (err) {
    scKbd.textContent = pretty(currentShortcut);
    scSub.textContent = "That combination isn't allowed — try another";
    statusEl.textContent = "Error: " + err;
  }
});
