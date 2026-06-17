# FrameCap

A tiny macOS menubar app (Tauri + ffmpeg) for recording a region of your screen and
pulling **frames** out of the recording — built for showing Claude exactly where a UI
breaks during motion, where video can't be analyzed directly.

## What it does

1. **Hotkey `⌘⇧1`** (or the menubar icon → *Record area*) opens a dimmed overlay.
2. **Drag** to select a region → a toolbar appears → click **● Record**.
3. **3-second countdown**, then recording starts (ffmpeg, cropped to your region).
4. A small floating **Stop** pill shows the elapsed time. Click it to stop.
5. The **editor** opens with the clip:
   - Scrub / step frame-by-frame (`−1 frame` / `+1 frame`).
   - **Capture current frame** or **auto-extract** N evenly-spaced frames.
   - Per-frame **Copy** (→ clipboard as an image) and **Save** (PNG).
   - **Build collage** — lays selected frames out in a linear strip (or grid via
     *cols*), optionally numbered with timestamps, copies it to the clipboard and
     offers to save. This is the "motion over time in one image" view.

Recordings are saved to `~/Movies/FrameCap/`.

## Requirements

- **ffmpeg** (`brew install ffmpeg`) — used for the actual screen capture.
- **Screen Recording permission**: the first time you record, macOS will prompt
  (System Settings → Privacy & Security → Screen Recording). Enable it for the app
  (or for your terminal when running in dev), then record again.

## Run (dev)

```bash
npm install
npm run tauri dev
```

## Build a .app

```bash
npm run tauri build
# → src-tauri/target/release/bundle/macos/FrameCap.app
```

## Notes / limitations (v1)

- Single (primary) display. Region coordinates are scaled by the window's
  `devicePixelRatio` to map logical → physical pixels for the ffmpeg crop.
- Capture is 30fps, H.264 `ultrafast` for low overhead.
- The app runs as a menubar accessory (no dock icon).
