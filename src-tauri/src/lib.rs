use std::io::Write;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

// macOS Screen Recording permission (CoreGraphics). Preflight = check without prompting,
// Request = show the system prompt the first time and register the app in the list.
#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
}
#[cfg(target_os = "macos")]
fn screen_perm_granted() -> bool {
    unsafe { CGPreflightScreenCaptureAccess() }
}
#[cfg(target_os = "macos")]
fn screen_perm_request() -> bool {
    unsafe { CGRequestScreenCaptureAccess() }
}
#[cfg(not(target_os = "macos"))]
fn screen_perm_granted() -> bool {
    true
}
#[cfg(not(target_os = "macos"))]
fn screen_perm_request() -> bool {
    true
}

struct Rec {
    child: Child,
    out: String,
    log: String,
}

#[derive(Default)]
struct AppState {
    rec: Mutex<Option<Rec>>,
    pending_src: Mutex<Option<String>>,
    pending_error: Mutex<Option<String>>,
}

fn find_ffmpeg() -> String {
    for p in [
        "/opt/homebrew/bin/ffmpeg",
        "/usr/local/bin/ffmpeg",
        "/usr/bin/ffmpeg",
    ] {
        if std::path::Path::new(p).exists() {
            return p.to_string();
        }
    }
    "ffmpeg".to_string()
}

/// Parse `ffmpeg -list_devices` output to find the avfoundation index of "Capture screen 0".
fn screen_device_index(ffmpeg: &str) -> String {
    let out = Command::new(ffmpeg)
        .args(["-f", "avfoundation", "-list_devices", "true", "-i", ""])
        .output();
    if let Ok(o) = out {
        let txt = String::from_utf8_lossy(&o.stderr);
        for line in txt.lines() {
            if line.contains("Capture screen 0") {
                if let (Some(a), Some(b)) = (line.rfind('['), line.rfind(']')) {
                    if a < b {
                        return line[a + 1..b].to_string();
                    }
                }
            }
        }
    }
    "1".to_string()
}

fn even(v: i64) -> i64 {
    let v = v.max(2);
    v - (v % 2)
}

fn open_overlay(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("overlay") {
        let _ = w.set_focus();
        return;
    }
    let (w, h) = match app.primary_monitor() {
        Ok(Some(mon)) => {
            let sf = mon.scale_factor();
            let s = mon.size().to_logical::<f64>(sf);
            (s.width, s.height)
        }
        _ => (1440.0, 900.0),
    };
    let win = WebviewWindowBuilder::new(app, "overlay", WebviewUrl::App("overlay.html".into()))
        .title("Select area")
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(false)
        .inner_size(w, h)
        .position(0.0, 0.0)
        .visible(true)
        .focused(true)
        .build();
    if let Ok(win) = win {
        // bring the (accessory) app to the front so the overlay becomes the key window
        // and the CSS crosshair cursor applies without needing a click first
        activate_app();
        let _ = win.set_focus();
    }
}

#[cfg(target_os = "macos")]
fn activate_app() {
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    unsafe {
        let app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
        if !app.is_null() {
            let _: () = msg_send![app, activateIgnoringOtherApps: true];
        }
    }
}
#[cfg(not(target_os = "macos"))]
fn activate_app() {}

/// True if Screen Recording is granted. Requests (prompts) if not yet decided.
#[tauri::command]
fn ensure_screen_permission() -> bool {
    if screen_perm_granted() {
        true
    } else {
        screen_perm_request();
        screen_perm_granted()
    }
}

#[tauri::command]
fn start_selection(app: AppHandle) {
    if !ensure_screen_permission() {
        return;
    }
    open_overlay(&app);
}

#[tauri::command]
fn cancel_selection(app: AppHandle) {
    if let Some(w) = app.get_webview_window("overlay") {
        let _ = w.close();
    }
}

#[tauri::command]
fn start_recording(
    app: AppHandle,
    state: tauri::State<AppState>,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    scale: f64,
) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("overlay") {
        let _ = win.close();
    }

    // never spawn a doomed ffmpeg (it would hang forever waiting for frames)
    if !screen_perm_granted() {
        screen_perm_request();
        let msg = "Screen Recording permission is required. Enable FrameCap in System Settings → Privacy & Security → Screen Recording, then relaunch FrameCap.";
        *state.pending_error.lock().unwrap() = Some(msg.to_string());
        open_editor(&app);
        let _ = app.emit("recording-failed", msg);
        return Ok(());
    }

    let cx = (x * scale).round() as i64;
    let cy = (y * scale).round() as i64;
    let cw = even((w * scale).round() as i64);
    let ch = even((h * scale).round() as i64);

    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let dir = PathBuf::from(&home).join("Movies").join("FrameCap");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let out = dir.join(format!("rec-{ts}.mp4"));
    let out_str = out.to_string_lossy().to_string();

    let ffmpeg = find_ffmpeg();
    let idx = screen_device_index(&ffmpeg);

    // log ffmpeg stderr so capture failures (e.g. denied Screen Recording perms) are visible
    let log_path = dir.join(format!("ffmpeg-{ts}.log"));
    let err_stdio = match std::fs::File::create(&log_path) {
        Ok(f) => Stdio::from(f),
        Err(_) => Stdio::null(),
    };

    let crop = format!("crop={cw}:{ch}:{cx}:{cy}");
    let child = Command::new(&ffmpeg)
        .args([
            "-f", "avfoundation",
            "-capture_cursor", "1",
            "-framerate", "30",
            "-i", &format!("{idx}:none"),
            "-vf", &crop,
            "-c:v", "libx264",
            "-preset", "ultrafast",
            "-pix_fmt", "yuv420p",
            "-movflags", "+faststart",
            "-y", &out_str,
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(err_stdio)
        .spawn()
        .map_err(|e| format!("Failed to launch ffmpeg: {e}"))?;

    *state.rec.lock().unwrap() = Some(Rec {
        child,
        out: out_str,
        log: log_path.to_string_lossy().to_string(),
    });

    // floating stop pill, bottom-center
    let (mw, mh) = match app.primary_monitor() {
        Ok(Some(mon)) => {
            let sf = mon.scale_factor();
            let s = mon.size().to_logical::<f64>(sf);
            (s.width, s.height)
        }
        _ => (1440.0, 900.0),
    };
    let pw = 320.0;
    let ph = 44.0;
    let _ = WebviewWindowBuilder::new(&app, "recorder", WebviewUrl::App("recorder.html".into()))
        .title("Recording")
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(false)
        .resizable(false)
        .inner_size(pw, ph)
        .position((mw - pw) / 2.0, mh - ph - 48.0)
        .visible(true)
        .build();

    Ok(())
}

#[tauri::command]
fn stop_recording(app: AppHandle, state: tauri::State<AppState>) -> Result<(), String> {
    let mut r = state
        .rec
        .lock()
        .unwrap()
        .take()
        .ok_or("No active recording")?;

    // close the pill and open the editor immediately so the window is up while we finalize
    if let Some(w) = app.get_webview_window("recorder") {
        let _ = w.close();
    }
    open_editor(&app);

    // finalize ffmpeg off the main thread so the webview never blocks
    let app = app.clone();
    std::thread::spawn(move || {
        // graceful stop so the mp4 moov atom is written
        if let Some(stdin) = r.child.stdin.as_mut() {
            let _ = stdin.write_all(b"q\n");
            let _ = stdin.flush();
        }
        // wait up to ~8s for a clean exit, then force-kill as a fallback
        let mut waited = 0;
        loop {
            match r.child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) => {
                    if waited >= 80 {
                        let _ = r.child.kill();
                        let _ = r.child.wait();
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(100));
                    waited += 1;
                }
                Err(_) => break,
            }
        }

        // a valid clip is more than a few KB; otherwise capture failed (usually perms)
        let ok = std::fs::metadata(&r.out).map(|m| m.len() > 4096).unwrap_or(false);
        let out = r.out.clone();
        let log = r.log.clone();
        let app2 = app.clone();
        let _ = app.run_on_main_thread(move || {
            open_editor(&app2);
            if ok {
                *app2.state::<AppState>().pending_src.lock().unwrap() = Some(out.clone());
                let _ = app2.emit("recording-ready", out);
            } else {
                let tail = std::fs::read_to_string(&log)
                    .map(|s| s.lines().rev().take(8).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n"))
                    .unwrap_or_default();
                let _ = app2.emit("recording-failed", tail);
            }
        });
    });

    Ok(())
}

// kill the running ffmpeg and delete its (partial) output file
fn discard_recording(state: &tauri::State<AppState>) {
    if let Some(mut r) = state.rec.lock().unwrap().take() {
        let _ = r.child.kill();
        let _ = r.child.wait();
        let _ = std::fs::remove_file(&r.out);
        let _ = std::fs::remove_file(&r.log);
    }
}

// suspend/resume the capture process (best-effort) via SIGSTOP / SIGCONT
fn signal_recording(state: &tauri::State<AppState>, sig: &str) -> bool {
    if let Some(r) = state.rec.lock().unwrap().as_ref() {
        let pid = r.child.id().to_string();
        return Command::new("kill").args([sig, &pid]).status().map(|s| s.success()).unwrap_or(false);
    }
    false
}

#[tauri::command]
fn pause_recording(state: tauri::State<AppState>) -> bool {
    signal_recording(&state, "-STOP")
}

#[tauri::command]
fn resume_recording(state: tauri::State<AppState>) -> bool {
    signal_recording(&state, "-CONT")
}

#[tauri::command]
fn delete_recording(app: AppHandle, state: tauri::State<AppState>) {
    discard_recording(&state);
    if let Some(w) = app.get_webview_window("recorder") {
        let _ = w.close();
    }
    #[cfg(target_os = "macos")]
    app.set_activation_policy(tauri::ActivationPolicy::Accessory).ok();
}

#[tauri::command]
fn restart_recording(app: AppHandle, state: tauri::State<AppState>) {
    discard_recording(&state);
    if let Some(w) = app.get_webview_window("recorder") {
        let _ = w.close();
    }
    open_overlay(&app);
}

fn open_editor(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("editor") {
        let _ = w.set_focus();
        let _ = w.eval("window.location.reload()");
        return;
    }
    let mut builder = WebviewWindowBuilder::new(app, "editor", WebviewUrl::App("index.html".into()))
        .title("FrameCap Editor")
        .inner_size(1120.0, 740.0)
        .min_inner_size(800.0, 560.0)
        .visible(true)
        .focused(true);
    #[cfg(target_os = "macos")]
    {
        builder = builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true);
    }
    let _ = builder.build();
}

#[tauri::command]
fn open_editor_window(app: AppHandle) {
    open_editor(&app);
}

#[tauri::command]
fn take_pending_src(state: tauri::State<AppState>) -> Option<String> {
    state.pending_src.lock().unwrap().take()
}

#[tauri::command]
fn take_pending_error(state: tauri::State<AppState>) -> Option<String> {
    state.pending_error.lock().unwrap().take()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_shortcut("CmdOrCtrl+Shift+1")
                .expect("invalid shortcut")
                .with_handler(|app, _shortcut, event| {
                    if event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        if screen_perm_granted() {
                            open_overlay(app);
                        } else {
                            screen_perm_request();
                        }
                    }
                })
                .build(),
        )
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            start_selection,
            cancel_selection,
            start_recording,
            stop_recording,
            pause_recording,
            resume_recording,
            delete_recording,
            restart_recording,
            take_pending_src,
            take_pending_error,
            ensure_screen_permission,
            open_editor_window
        ])
        .setup(|app| {
            let handle = app.handle();
            let record = MenuItem::with_id(handle, "record", "Record area  (⌘⇧1)", true, None::<&str>)?;
            let editor = MenuItem::with_id(handle, "editor", "Open editor", true, None::<&str>)?;
            let quit = MenuItem::with_id(handle, "quit", "Quit FrameCap", true, None::<&str>)?;
            let menu = Menu::with_items(handle, &[&record, &editor, &quit])?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .tooltip("FrameCap")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "record" => {
                        if screen_perm_granted() {
                            open_overlay(app);
                        } else {
                            screen_perm_request();
                        }
                    }
                    "editor" => open_editor(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(handle)?;

            // menubar app: no dock icon
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            // ask for Screen Recording up front so the prompt appears before the first record
            #[cfg(target_os = "macos")]
            if !screen_perm_granted() {
                screen_perm_request();
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building FrameCap")
        .run(|_app, event| {
            // menubar app: keep running even when no windows are open
            // (closing the recorder pill must not quit the app before the editor opens)
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                if code.is_none() {
                    api.prevent_exit();
                }
            }
        });
}
