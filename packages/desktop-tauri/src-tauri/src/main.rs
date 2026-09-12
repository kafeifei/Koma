#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    Emitter, Manager, RunEvent, WindowEvent,
};

struct Backend {
    profile: PathBuf,
    binary: PathBuf,
    renderer: PathBuf,
    state_directory: PathBuf,
    child: Mutex<Option<Child>>,
    starting: Mutex<()>,
    quitting: AtomicBool,
    exit_allowed: AtomicBool,
}

#[derive(Deserialize, Serialize)]
struct Connection {
    pid: u32,
    version: Option<String>,
    url: String,
    username: String,
    password: String,
    #[serde(default)]
    profile: String,
}

fn backend_command(backend: &Backend) -> Command {
    let mut command = Command::new(&backend.binary);
    command
        .env("KOMA_BACKEND_INSTANCE", "tauri")
        .env("KOMA_HOME", &backend.profile)
        .env("OPENCODE_HOME", &backend.profile)
        .env("KOMA_DESKTOP_RENDERER", &backend.renderer)
        .current_dir(&backend.profile);
    command
}

fn discover(backend: &Backend) -> Option<Connection> {
    let output = backend_command(backend)
        .args(["backend", "status", "--connection"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let status: serde_json::Value = serde_json::from_slice(&output.stdout).ok()?;
    if status.get("running")?.as_bool()? != true {
        return None;
    }
    let connection: Connection = serde_json::from_value(status).ok()?;
    if connection.profile != backend.profile.to_string_lossy() {
        return None;
    }
    Some(connection)
}

fn ensure_backend(backend: &Backend) -> Result<Connection, String> {
    let _lock = backend.starting.lock().map_err(|e| e.to_string())?;
    if let Some(connection) = discover(backend) {
        return Ok(connection);
    }
    // A live but unresponsive owner must not be replaced. The backend's own
    // instance lock is authoritative; Electron has a separate process record.
    let logs = &backend.state_directory;
    fs::create_dir_all(&logs).map_err(|e| e.to_string())?;
    let output = OpenOptions::new()
        .create(true)
        .append(true)
        .open(logs.join("service.log"))
        .map_err(|e| e.to_string())?;
    let error = output.try_clone().map_err(|e| e.to_string())?;
    let child = backend_command(backend)
        .args(["backend", "serve"])
        .stdin(Stdio::null())
        .stdout(output)
        .stderr(error)
        .spawn()
        .map_err(|e| e.to_string())?;
    *backend.child.lock().map_err(|e| e.to_string())? = Some(child);
    let deadline = Instant::now() + Duration::from_secs(45);
    while Instant::now() < deadline {
        if let Some(connection) = discover(backend) {
            return Ok(connection);
        }
        let mut guard = backend.child.lock().map_err(|e| e.to_string())?;
        if let Some(child) = guard.as_mut() {
            if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
                return Err(format!("Koma backend exited: {status}"));
            }
        }
        drop(guard);
        thread::sleep(Duration::from_millis(200));
    }
    Err("Koma backend did not become ready within 45 seconds; ownership was preserved".into())
}

#[tauri::command]
async fn initialize(app: tauri::AppHandle) -> Result<Connection, String> {
    tauri::async_runtime::spawn_blocking(move || ensure_backend(&app.state::<Backend>()))
        .await
        .map_err(|e| e.to_string())?
}

fn stop_owned_backend(backend: &Backend) -> Result<(), String> {
    let _lock = backend.starting.lock().map_err(|e| e.to_string())?;
    if discover(backend).is_none() && !backend.state_directory.join("backend.json").exists() {
        return Ok(());
    }
    let output = backend_command(backend)
        .args(["backend", "stop"])
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).into_owned());
    }
    if let Some(mut child) = backend.child.lock().map_err(|e| e.to_string())?.take() {
        let _ = child.wait();
    }
    Ok(())
}

fn request_quit(app: &tauri::AppHandle) {
    if app.state::<Backend>().quitting.swap(true, Ordering::SeqCst) {
        return;
    }
    if focused_window(app)
        .or_else(|| app.get_webview_window("main"))
        .map(|window| app.emit_to(window.label(), "desktop-quit", ()))
        .transpose()
        .is_err()
    {
        app.state::<Backend>()
            .quitting
            .store(false, Ordering::SeqCst);
    }
}

#[tauri::command]
async fn stop_backend(app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || stop_owned_backend(&app.state::<Backend>()))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn cancel_quit(app: tauri::AppHandle) {
    app.state::<Backend>()
        .quitting
        .store(false, Ordering::SeqCst);
}

#[tauri::command]
fn exit_app(app: tauri::AppHandle) {
    app.state::<Backend>()
        .exit_allowed
        .store(true, Ordering::SeqCst);
    app.exit(0);
}

#[tauri::command]
fn restart_app(app: tauri::AppHandle) {
    app.state::<Backend>()
        .exit_allowed
        .store(true, Ordering::SeqCst);
    app.restart();
}

#[derive(Deserialize)]
struct ShutdownDialog {
    message: String,
    detail: String,
    buttons: Vec<String>,
}

#[tauri::command]
async fn show_shutdown_dialog(
    app: tauri::AppHandle,
    options: ShutdownDialog,
) -> Result<i32, String> {
    if options.buttons.len() != 2 {
        return Err("Expected cancel and quit buttons".into());
    }
    let (send, receive) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        use objc2::MainThreadMarker;
        use objc2_app_kit::{
            NSAlert, NSAlertStyle, NSApplication, NSButtonCell, NSEvent, NSEventMask,
        };
        use objc2_foundation::NSString;
        let main = MainThreadMarker::new().expect("AppKit main thread");
        let alert = NSAlert::new(main);
        alert.setAlertStyle(NSAlertStyle::Warning);
        alert.setMessageText(&NSString::from_str(&options.message));
        alert.setInformativeText(&NSString::from_str(&options.detail));
        let cancel = alert.addButtonWithTitle(&NSString::from_str(&options.buttons[0]));
        let stop = alert.addButtonWithTitle(&NSString::from_str(&options.buttons[1]));
        // Electron's contract makes both Return and Escape cancel. rfd's
        // OkCancel helper cannot express that contract with custom labels.
        stop.setKeyEquivalent(&NSString::from_str(""));
        if let Some(cell) = cancel
            .cell()
            .and_then(|cell| cell.downcast::<NSButtonCell>().ok())
        {
            alert.window().setDefaultButtonCell(Some(&cell));
        }
        cancel.setKeyEquivalent(&NSString::from_str("\r"));
        let dialog_window = alert.window();
        let escape = block2::RcBlock::new(move |event: std::ptr::NonNull<NSEvent>| {
            let application = NSApplication::sharedApplication(
                MainThreadMarker::new().expect("AppKit main thread"),
            );
            let in_dialog = application
                .modalWindow()
                .as_deref()
                .is_some_and(|window| std::ptr::eq(window, &*dialog_window));
            if in_dialog && unsafe { event.as_ref() }.keyCode() == 53 {
                application.stopModalWithCode(1000);
                return std::ptr::null_mut();
            }
            event.as_ptr()
        });
        let monitor = unsafe {
            NSEvent::addLocalMonitorForEventsMatchingMask_handler(NSEventMask::KeyDown, &escape)
        };
        let result = alert.runModal();
        if let Some(monitor) = monitor {
            unsafe {
                NSEvent::removeMonitor(&monitor);
            }
        }
        let _ = send.send(if result == 1001 { 1 } else { 0 });
    })
    .map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || receive.recv().map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())?
}

#[derive(Deserialize)]
struct DesktopMenu {
    id: String,
    label: String,
    items: Option<Vec<DesktopMenuEntry>>,
}
#[derive(Deserialize)]
struct DesktopMenuEntry {
    #[serde(rename = "type")]
    kind: String,
    label: Option<String>,
    role: Option<String>,
    accelerator: Option<String>,
    enabled: Option<String>,
}

#[tauri::command]
fn set_desktop_menu(app: tauri::AppHandle, menus: Vec<DesktopMenu>) -> Result<(), String> {
    let menu = Menu::new(&app).map_err(|e| e.to_string())?;
    for group in menus {
        let submenu =
            Submenu::with_id(&app, &group.id, &group.label, true).map_err(|e| e.to_string())?;
        for (index, item) in group.items.unwrap_or_default().into_iter().enumerate() {
            let label = item.label.as_deref();
            let native = if item.kind == "separator" {
                Some(PredefinedMenuItem::separator(&app))
            } else {
                match item.role.as_deref() {
                    Some("close") => Some(PredefinedMenuItem::close_window(&app, label)),
                    Some("about") => Some(PredefinedMenuItem::about(&app, label, None)),
                    Some("hide") => Some(PredefinedMenuItem::hide(&app, label)),
                    Some("hideOthers") => Some(PredefinedMenuItem::hide_others(&app, label)),
                    Some("unhide") => Some(PredefinedMenuItem::show_all(&app, label)),
                    Some("undo") => Some(PredefinedMenuItem::undo(&app, label)),
                    Some("redo") => Some(PredefinedMenuItem::redo(&app, label)),
                    Some("cut") => Some(PredefinedMenuItem::cut(&app, label)),
                    Some("copy") => Some(PredefinedMenuItem::copy(&app, label)),
                    Some("paste") => Some(PredefinedMenuItem::paste(&app, label)),
                    Some("selectAll") => Some(PredefinedMenuItem::select_all(&app, label)),
                    _ => None,
                }
            };
            if let Some(native) = native {
                submenu
                    .append(&native.map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())?;
                continue;
            }
            let quit = item.role.as_deref() == Some("quit");
            let id = if quit {
                "quit-test".to_owned()
            } else {
                format!("{}:{}", group.id, index)
            };
            let text = label.unwrap_or(if quit { "Quit Koma" } else { "" });
            let accelerator = item
                .accelerator
                .as_deref()
                .or_else(|| match item.role.as_deref() {
                    Some("quit") => Some("Cmd+Q"),
                    Some("reload") => Some("Cmd+R"),
                    Some("toggleDevTools") => Some("Cmd+Alt+I"),
                    Some("resetZoom") => Some("Cmd+0"),
                    Some("zoomIn") => Some("Cmd+Plus"),
                    Some("zoomOut") => Some("Cmd+-"),
                    Some("togglefullscreen") => Some("Ctrl+Cmd+F"),
                    _ => None,
                });
            submenu
                .append(
                    &MenuItem::with_id(&app, id, text, item.enabled.is_none(), accelerator)
                        .map_err(|e| e.to_string())?,
                )
                .map_err(|e| e.to_string())?;
        }
        if group.id == "window" {
            submenu
                .set_as_windows_menu_for_nsapp()
                .map_err(|e| e.to_string())?;
        }
        if group.id == "help" {
            submenu
                .set_as_help_menu_for_nsapp()
                .map_err(|e| e.to_string())?;
        }
        menu.append(&submenu).map_err(|e| e.to_string())?;
    }
    app.set_menu(menu).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn native_window_action(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    action: String,
) -> Result<(), String> {
    let result = match action.as_str() {
        "window.new" => {
            let label = format!(
                "window-{}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            );
            return create_window(&app, label);
        }
        "window.close" => window.close(),
        "window.minimize" => window.minimize(),
        "window.toggleMaximize" => {
            if window.is_maximized().unwrap_or(false) {
                window.unmaximize()
            } else {
                window.maximize()
            }
        }
        "view.toggleFullscreen" => window.set_fullscreen(!window.is_fullscreen().unwrap_or(false)),
        "view.toggleDevTools" => {
            if window.is_devtools_open() {
                window.close_devtools();
            } else {
                window.open_devtools();
            }
            Ok(())
        }
        _ => return Err("Unsupported native window action".into()),
    };
    result.map_err(|e| e.to_string())
}

#[tauri::command]
fn set_zoom(window: tauri::WebviewWindow, factor: f64) -> Result<(), String> {
    window
        .set_zoom(factor.clamp(0.2, 10.0))
        .map_err(|e| e.to_string())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WindowGeometry {
    width: f64,
    height: f64,
    traffic_lights: Point,
}
#[derive(Deserialize)]
struct Point {
    x: f64,
    y: f64,
}
fn geometry() -> WindowGeometry {
    serde_json::from_str(include_str!("../../../app/src/desktop/window.json"))
        .expect("shared desktop window geometry")
}
fn create_window(app: &tauri::AppHandle, label: String) -> Result<(), String> {
    let mut config = app.config().app.windows[0].clone();
    let shared = geometry();
    config.label = label;
    config.width = shared.width;
    config.height = shared.height;
    tauri::WebviewWindowBuilder::from_config(app, &config)
        .map_err(|e| e.to_string())?
        .traffic_light_position(window_control_position(&shared)?)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

// Electron measures from the window's top edge. Wry measures from AppKit's
// button baseline. Read that native metric once, then let Wry preserve the
// inset through redraw, resize and fullscreen transitions.
fn window_control_position(shared: &WindowGeometry) -> Result<tauri::LogicalPosition<f64>, String> {
    use objc2::MainThreadOnly;
    use objc2_app_kit::{NSBackingStoreType, NSWindow, NSWindowButton, NSWindowStyleMask};
    use objc2_foundation::{MainThreadMarker, NSPoint, NSRect, NSSize};
    let mtm = MainThreadMarker::new().ok_or("Window creation must run on the main thread")?;
    // This window is never ordered on screen and owns no webview or backend.
    let probe = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            NSWindow::alloc(mtm),
            NSRect::new(
                NSPoint::new(0.0, 0.0),
                NSSize::new(shared.width, shared.height),
            ),
            NSWindowStyleMask::Titled
                | NSWindowStyleMask::Closable
                | NSWindowStyleMask::Miniaturizable
                | NSWindowStyleMask::Resizable
                | NSWindowStyleMask::FullSizeContentView,
            NSBackingStoreType::Buffered,
            false,
        )
    };
    let close = probe
        .standardWindowButton(NSWindowButton::CloseButton)
        .ok_or("Native close button is unavailable")?;
    let parent = unsafe { close.superview().and_then(|view| view.superview()) }
        .ok_or("Native titlebar is unavailable")?;
    let baseline = close
        .convertRect_toView(close.bounds(), Some(&parent))
        .origin
        .y;
    Ok(tauri::LogicalPosition::new(
        shared.traffic_lights.x,
        shared.traffic_lights.y + baseline,
    ))
}

// Electron dispatches native menu accelerators before renderer key handlers.
// WebKit can otherwise let a terminal consume Cmd+Q/Cmd+W. Route matching
// Command shortcuts through the same native menu, independent of page focus.
fn install_menu_shortcuts() -> Option<objc2::rc::Retained<objc2::runtime::AnyObject>> {
    use objc2_app_kit::{NSApplication, NSEvent, NSEventMask, NSEventModifierFlags};
    use objc2_foundation::MainThreadMarker;
    let handler = block2::RcBlock::new(move |event: std::ptr::NonNull<NSEvent>| {
        let event_ref = unsafe { event.as_ref() };
        let application =
            NSApplication::sharedApplication(MainThreadMarker::new().expect("AppKit main thread"));
        if application.modalWindow().is_none()
            && event_ref
                .modifierFlags()
                .contains(NSEventModifierFlags::Command)
            && application
                .mainMenu()
                .is_some_and(|menu| menu.performKeyEquivalent(event_ref))
        {
            return std::ptr::null_mut();
        }
        event.as_ptr()
    });
    unsafe { NSEvent::addLocalMonitorForEventsMatchingMask_handler(NSEventMask::KeyDown, &handler) }
}

#[tauri::command]
fn notify_user(window: tauri::WebviewWindow, title: String, body: String, id: String) {
    tauri::async_runtime::spawn_blocking(move || {
        use mac_notification_sys::{Notification, NotificationResponse};
        let response = Notification::new()
            .title(&title)
            .message(&body)
            .wait_for_click(true)
            .send();
        let clicked = matches!(
            response,
            Ok(NotificationResponse::Click) | Ok(NotificationResponse::ActionButton(_))
        );
        if clicked {
            let _ = window.show();
            let _ = window.set_focus();
        }
        let _ = window.emit(
            "notification-response",
            serde_json::json!({ "id": id, "clicked": clicked }),
        );
    });
}

#[tauri::command]
fn check_app_exists(app: tauri::AppHandle, app_name: String) -> bool {
    if app_name.is_empty() || app_name.contains('/') || app_name.contains('\0') {
        return false;
    }
    let mut locations = vec![
        PathBuf::from("/Applications"),
        PathBuf::from("/System/Applications"),
    ];
    if let Ok(home) = app.path().home_dir() {
        locations.push(home.join("Applications"));
    }
    locations
        .iter()
        .any(|directory| directory.join(format!("{app_name}.app")).is_dir())
        || Command::new("/usr/bin/which")
            .arg(app_name)
            .output()
            .map(|result| result.status.success())
            .unwrap_or(false)
}

#[tauri::command]
async fn export_debug_logs(app: tauri::AppHandle) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let backend = app.state::<Backend>();
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|e| e.to_string())?.as_millis();
        let temporary = std::env::temp_dir().join(format!("koma-tauri-logs-{stamp}"));
        fs::create_dir_all(&temporary).map_err(|e| e.to_string())?;
        let output = app.path().download_dir().map_err(|e| e.to_string())?.join(format!("koma-debug-{stamp}.zip"));
        let result = (|| {
            let manifest = serde_json::json!({ "host": "tauri", "profile": backend.profile, "runtime": backend.binary });
            fs::write(temporary.join("manifest.json"), serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
            let log = backend.state_directory.join("service.log");
            if log.is_file() {
                use std::io::{Read, Seek, SeekFrom};
                let mut file = fs::File::open(log).map_err(|e| e.to_string())?;
                let size = file.metadata().map_err(|e| e.to_string())?.len();
                file.seek(SeekFrom::Start(size.saturating_sub(50 * 1024 * 1024))).map_err(|e| e.to_string())?;
                let mut data = Vec::new(); file.read_to_end(&mut data).map_err(|e| e.to_string())?;
                fs::write(temporary.join("service.log"), data).map_err(|e| e.to_string())?;
            }
            let zipped = Command::new("/usr/bin/ditto").args(["-c", "-k", "--keepParent"]).arg(&temporary).arg(&output).output().map_err(|e| e.to_string())?;
            if !zipped.status.success() { return Err("Diagnostic archive failed".to_string()); }
            Ok(output.to_string_lossy().into_owned())
        })();
        let _ = fs::remove_dir_all(temporary);
        result
    }).await.map_err(|e| e.to_string())?
}

fn focused_window(app: &tauri::AppHandle) -> Option<tauri::WebviewWindow> {
    app.webview_windows()
        .into_values()
        .find(|window| window.is_focused().unwrap_or(false))
}

fn copy_tree(source: &std::path::Path, target: &std::path::Path) -> std::io::Result<()> {
    fs::create_dir_all(target)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let destination = target.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_tree(&entry.path(), &destination)?;
        } else {
            fs::copy(entry.path(), destination)?;
        }
    }
    Ok(())
}

// Keep a running backend's executable and web assets immutable during an app update.
fn freeze_runtime(
    binary: PathBuf,
    renderer: PathBuf,
    info: PathBuf,
    state: &std::path::Path,
) -> Result<(PathBuf, PathBuf), Box<dyn std::error::Error>> {
    let info: serde_json::Value = serde_json::from_slice(&fs::read(info)?)?;
    let build: String = info["builtAt"]
        .as_str()
        .ok_or("Missing runtime build identity")?
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .collect();
    let target = state.join("runtime").join(build);
    if !target.is_dir() {
        fs::create_dir_all(target.parent().ok_or("No runtime directory")?)?;
        let temporary = target.with_extension(format!("{}.tmp", std::process::id()));
        fs::create_dir_all(&temporary)?;
        fs::copy(binary, temporary.join("koma"))?;
        let resources = renderer.parent().ok_or("Missing desktop host resources")?;
        for name in ["node", "host.cjs", "node-LICENSE"] {
            fs::copy(resources.join(name), temporary.join(name))?;
        }
        copy_tree(&renderer, &temporary.join("web"))?;
        if let Err(error) = fs::rename(&temporary, &target) {
            if !target.is_dir() {
                return Err(error.into());
            }
            fs::remove_dir_all(temporary)?;
        }
    }
    Ok((target.join("koma"), target.join("web")))
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .menu(|app| {
            let menu = Menu::default(app)?;
            // macOS's predefined Quit calls NSApplication.terminate directly.
            // A custom item goes through our backend shutdown confirmation.
            if let Some(first) = menu.items()?.first() {
                if let Some(submenu) = first.as_submenu() {
                    let count = submenu.items()?.len();
                    if count > 0 {
                        submenu.remove_at(count - 1)?;
                    }
                    submenu.append(&MenuItem::with_id(
                        app,
                        "quit-test",
                        "Quit Koma Tauri Debug",
                        true,
                        Some("CmdOrCtrl+Q"),
                    )?)?;
                }
            }
            Ok(menu)
        })
        .on_menu_event(|app, event| {
            if event.id().as_ref() == "quit-test" {
                request_quit(app);
            } else if let Some(window) = focused_window(app) {
                let _ = app.emit_to(window.label(), "desktop-menu", event.id().as_ref());
            }
        })
        .setup(|app| {
            let _ = mac_notification_sys::set_application(&app.config().identifier);
            create_window(app.handle(), "main".into())?;
            let binary = if cfg!(debug_assertions) {
                PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries/koma-aarch64-apple-darwin")
            } else {
                std::env::current_exe()?
                    .parent()
                    .ok_or("No executable directory")?
                    .join("koma")
            };
            if !binary.is_file() {
                return Err(format!("Missing Koma backend: {}", binary.display()).into());
            }
            // Let the Koma CLI resolve profile aliases and defaults just as Electron does.
            let output = Command::new(&binary)
                .env("KOMA_BACKEND_INSTANCE", "tauri")
                .args(["backend", "paths"])
                .output()?;
            if !output.status.success() {
                return Err(String::from_utf8_lossy(&output.stderr).into_owned().into());
            }
            let paths: serde_json::Value = serde_json::from_slice(&output.stdout)?;
            let profile = PathBuf::from(paths["profile"].as_str().ok_or("Missing Koma profile")?);
            let state_directory = PathBuf::from(
                paths["state"]
                    .as_str()
                    .ok_or("Missing Koma instance directory")?,
            );
            fs::create_dir_all(&profile)?;
            let resources = if cfg!(debug_assertions) {
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            } else {
                app.path().resource_dir()?
            };
            let renderer = if cfg!(debug_assertions) {
                resources.join("binaries/web")
            } else {
                resources.join("web")
            };
            let info = if cfg!(debug_assertions) {
                resources.join("binaries/build-info.json")
            } else {
                resources.join("build-info.json")
            };
            let (binary, renderer) = freeze_runtime(binary, renderer, info, &state_directory)?;
            app.manage(Backend {
                profile,
                binary,
                renderer,
                state_directory,
                child: Mutex::new(None),
                starting: Mutex::new(()),
                quitting: AtomicBool::new(false),
                exit_allowed: AtomicBool::new(false),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            initialize,
            stop_backend,
            cancel_quit,
            exit_app,
            restart_app,
            show_shutdown_dialog,
            set_desktop_menu,
            native_window_action,
            check_app_exists,
            notify_user,
            export_debug_logs,
            set_zoom
        ])
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("Failed to build the Tauri validation app");
    let _menu_shortcuts = install_menu_shortcuts();
    app.run(|app, event| match event {
        RunEvent::ExitRequested { api, .. } => {
            if app.state::<Backend>().exit_allowed.load(Ordering::SeqCst) {
                return;
            }
            api.prevent_exit();
            request_quit(app);
        }
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_backend_command_pins_both_profile_variables() {
        let profile = PathBuf::from("/isolated/desktop-tests/tauri/profile");
        let backend = Backend {
            profile: profile.clone(),
            binary: PathBuf::from("/test-backend"),
            renderer: PathBuf::from("/test-renderer"),
            state_directory: profile.join("bin/.koma-instances/tauri"),
            child: Mutex::new(None),
            starting: Mutex::new(()),
            quitting: AtomicBool::new(false),
            exit_allowed: AtomicBool::new(false),
        };
        let command = backend_command(&backend);
        for key in ["KOMA_HOME", "OPENCODE_HOME"] {
            let value = command.get_envs().find(|(name, _)| *name == key).unwrap().1;
            assert_eq!(value, Some(profile.as_os_str()));
        }
        assert_eq!(command.get_current_dir(), Some(profile.as_path()));
        assert_eq!(
            command
                .get_envs()
                .find(|(name, _)| *name == "KOMA_BACKEND_INSTANCE")
                .unwrap()
                .1
                .unwrap(),
            "tauri"
        );
    }
}
