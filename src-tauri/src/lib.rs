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
    record_shortcut: Mutex<String>,
}

const DEFAULT_SHORTCUT: &str = "CmdOrCtrl+Shift+1";

fn settings_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("settings.json"))
}
fn load_shortcut(app: &AppHandle) -> String {
    if let Some(p) = settings_path(app) {
        if let Ok(txt) = std::fs::read_to_string(&p) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&txt) {
                if let Some(s) = v.get("shortcut").and_then(|s| s.as_str()) {
                    return s.to_string();
                }
            }
        }
    }
    DEFAULT_SHORTCUT.to_string()
}
fn save_shortcut(app: &AppHandle, accelerator: &str) {
    if let Some(p) = settings_path(app) {
        if let Some(dir) = p.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(&p, serde_json::json!({ "shortcut": accelerator }).to_string());
    }
}

#[derive(serde::Serialize)]
struct Settings {
    version: String,
    shortcut: String,
}

#[tauri::command]
fn get_settings(app: AppHandle, state: tauri::State<AppState>) -> Settings {
    Settings {
        version: app.package_info().version.to_string(),
        shortcut: state.record_shortcut.lock().unwrap().clone(),
    }
}

#[tauri::command]
fn set_shortcut(app: AppHandle, state: tauri::State<AppState>, accelerator: String) -> Result<(), String> {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};
    let new: Shortcut = accelerator.parse().map_err(|_| "Invalid shortcut".to_string())?;
    let gs = app.global_shortcut();
    let old = state.record_shortcut.lock().unwrap().clone();
    if let Ok(o) = old.parse::<Shortcut>() {
        let _ = gs.unregister(o);
    }
    gs.register(new).map_err(|e| e.to_string())?;
    *state.record_shortcut.lock().unwrap() = accelerator.clone();
    save_shortcut(&app, &accelerator);
    Ok(())
}

#[tauri::command]
async fn check_updates_now(app: AppHandle) -> Result<String, String> {
    use tauri_plugin_updater::UpdaterExt;
    let updater = app.updater().map_err(|e| e.to_string())?;
    match updater.check().await.map_err(|e| e.to_string())? {
        Some(update) => {
            update
                .download_and_install(|_, _| {}, || {})
                .await
                .map_err(|e| e.to_string())?;
            app.restart();
        }
        None => Ok("You're on the latest version.".to_string()),
    }
}

fn open_settings(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.set_focus();
        activate_app();
        return;
    }
    let _ = WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("settings.html".into()))
        .title("FrameCap Settings")
        .inner_size(440.0, 360.0)
        .resizable(false)
        .visible(true)
        .focused(true)
        .build();
    activate_app();
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

/// Delete recordings (and their ffmpeg logs) older than 24 hours.
fn cleanup_old_recordings() {
    let home = match std::env::var("HOME") {
        Ok(h) => h,
        Err(_) => return,
    };
    let dir = PathBuf::from(home).join("Movies").join("FrameCap");
    let cutoff = match SystemTime::now().checked_sub(std::time::Duration::from_secs(24 * 3600)) {
        Some(c) => c,
        None => return,
    };
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for e in entries.flatten() {
            let p = e.path();
            let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if !(name.starts_with("rec-") || name.starts_with("ffmpeg-")) {
                continue;
            }
            if let Ok(modified) = e.metadata().and_then(|m| m.modified()) {
                if modified < cutoff {
                    let _ = std::fs::remove_file(&p);
                }
            }
        }
    }
}

// Shift+Return is only a global shortcut while a recording is active (to stop it),
// so it doesn't steal Shift+Return system-wide the rest of the time.
fn set_stop_shortcut(app: &AppHandle, on: bool) {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};
    if let Ok(sc) = "Shift+Enter".parse::<Shortcut>() {
        let gs = app.global_shortcut();
        if on {
            let _ = gs.register(sc);
        } else {
            let _ = gs.unregister(sc);
        }
    }
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

    // Request permission if it looks undetermined, but DON'T block recording on the
    // preflight result — CGPreflightScreenCaptureAccess can report a false negative even
    // when access is actually granted. If capture truly fails, the empty-output check in
    // stop_recording surfaces the permission error instead.
    if !screen_perm_granted() {
        screen_perm_request();
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

    set_stop_shortcut(&app, true);
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

    set_stop_shortcut(&app, false);

    // close the pill and open the editor immediately so the window is up while we finalize
    if let Some(w) = app.get_webview_window("recorder") {
        let _ = w.close();
    }
    open_editor(&app);

    // finalize ffmpeg off the main thread so the webview never blocks
    let app = app.clone();
    std::thread::spawn(move || {
        let pid = r.child.id().to_string();
        // resume first in case the recording was paused (SIGSTOP) — a suspended
        // process can't process the quit request and would be force-killed (no moov atom)
        let _ = Command::new("kill").args(["-CONT", &pid]).status();
        // graceful stop so the mp4 moov atom is written: 'q' on stdin + SIGINT (clean Ctrl-C)
        if let Some(stdin) = r.child.stdin.as_mut() {
            let _ = stdin.write_all(b"q\n");
            let _ = stdin.flush();
        }
        let _ = Command::new("kill").args(["-INT", &pid]).status();
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
    set_stop_shortcut(&app, false);
    discard_recording(&state);
    if let Some(w) = app.get_webview_window("recorder") {
        let _ = w.close();
    }
    #[cfg(target_os = "macos")]
    app.set_activation_policy(tauri::ActivationPolicy::Accessory).ok();
}

#[tauri::command]
fn restart_recording(app: AppHandle, state: tauri::State<AppState>) {
    set_stop_shortcut(&app, false);
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

async fn check_for_update(app: AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    use tauri_plugin_updater::UpdaterExt;
    if let Some(update) = app.updater()?.check().await? {
        // download + install silently, then restart into the new version
        update.download_and_install(|_, _| {}, || {}).await?;
        app.restart();
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    use tauri_plugin_global_shortcut::{Code, Modifiers, ShortcutState};
                    if event.state != ShortcutState::Pressed {
                        return;
                    }
                    // Shift+Return stops an active recording (registered only while recording)
                    if shortcut.matches(Modifiers::SHIFT, Code::Enter) {
                        if let Some(w) = app.get_webview_window("recorder") {
                            let _ = w.eval("document.getElementById('stop')?.click()");
                        }
                        return;
                    }
                    open_overlay(app);
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
            get_settings,
            set_shortcut,
            check_updates_now,
            open_editor_window
        ])
        .setup(|app| {
            let handle = app.handle();
            let record = MenuItem::with_id(handle, "record", "Record area", true, None::<&str>)?;
            let editor = MenuItem::with_id(handle, "editor", "Open editor", true, None::<&str>)?;
            let settings = MenuItem::with_id(handle, "settings", "Settings…", true, None::<&str>)?;
            let quit = MenuItem::with_id(handle, "quit", "Quit FrameCap", true, None::<&str>)?;
            let menu = Menu::with_items(handle, &[&record, &editor, &settings, &quit])?;

            // white, template menubar icon (adapts to light/dark menubar)
            let tray_icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?;
            let _tray = TrayIconBuilder::new()
                .icon(tray_icon)
                .icon_as_template(true)
                .menu(&menu)
                .tooltip("FrameCap")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "record" => open_overlay(app),
                    "editor" => open_editor(app),
                    "settings" => open_settings(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(handle)?;

            // register the record shortcut (saved custom one, or the default)
            {
                use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};
                let sc = load_shortcut(handle);
                *app.state::<AppState>().record_shortcut.lock().unwrap() = sc.clone();
                if let Ok(parsed) = sc.parse::<Shortcut>() {
                    let _ = app.global_shortcut().register(parsed);
                }
            }

            // menubar app: no dock icon
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            // ask for Screen Recording up front so the prompt appears before the first record
            #[cfg(target_os = "macos")]
            if !screen_perm_granted() {
                screen_perm_request();
            }

            // kill any orphaned ffmpeg from a previous session that was force-quit —
            // a stray capture process holds the screen device and blocks new recordings
            #[cfg(target_os = "macos")]
            {
                let _ = Command::new("pkill")
                    .args(["-f", "Movies/FrameCap/rec-"])
                    .status();
            }

            // purge recordings older than 24h now, then hourly while running
            cleanup_old_recordings();
            std::thread::spawn(|| loop {
                std::thread::sleep(std::time::Duration::from_secs(3600));
                cleanup_old_recordings();
            });

            // check for updates in the background and self-install if one is available
            let update_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = check_for_update(update_handle).await {
                    eprintln!("update check failed: {e}");
                }
            });

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
