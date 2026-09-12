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
    menu::{Menu, MenuItem},
    Manager, RunEvent, WindowEvent,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

struct Backend {
    profile: PathBuf,
    binary: PathBuf,
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

#[tauri::command]
fn desktop_preferences(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let backend = app.state::<Backend>();
    let mut result = serde_json::Map::new();
    for (name, keys) in [
        (
            "opencode.global.dat",
            &[
                "server",
                "language",
                "model",
                "composer-preferences",
                "new-session.branch",
                "new-session.worktree",
                "settings-v2.models.providers",
            ][..],
        ),
        ("default.dat", &["settings.v3", "app-version.v1"][..]),
    ] {
        let file = backend.profile.join("desktop").join(name);
        if !file.exists() {
            continue;
        }
        let raw = fs::read(file).map_err(|e| e.to_string())?;
        let source: serde_json::Value = serde_json::from_slice(&raw).map_err(|e| e.to_string())?;
        let mut selected = serde_json::Map::new();
        for key in keys {
            if let Some(value) = source.get(*key).and_then(|x| x.as_str()) {
                let text = if *key == "server" {
                    let mut state: serde_json::Value =
                        serde_json::from_str(value).map_err(|e| e.to_string())?;
                    state["list"] = serde_json::json!([]);
                    for field in ["projects", "lastProject", "recentlyClosed"] {
                        let local = state[field].get("local").cloned();
                        state[field] = serde_json::json!({});
                        if let Some(local) = local {
                            state[field]["local"] = local;
                        }
                    }
                    state.to_string()
                } else {
                    value.to_owned()
                };
                selected.insert((*key).into(), serde_json::Value::String(text));
            }
        }
        result.insert(name.into(), serde_json::Value::Object(selected));
    }
    Ok(serde_json::Value::Object(result))
}

fn stop_backend(backend: &Backend) -> Result<(), String> {
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
    let handle = app.clone();
    let window = app.get_webview_window("main").expect("Main window exists");
    let _ = window.show();
    let _ = window.set_focus();
    app.dialog()
        .message("退出将停止本窗口的 Koma 后端及其任务。Electron 的后端继续运行。关闭窗口可保留任务运行。")
        .title("退出 Koma Tauri？")
        .parent(&window)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "停止并退出".into(),
            "取消".into(),
        ))
        .show(move |confirmed| {
            if !confirmed {
                handle
                    .state::<Backend>()
                    .quitting
                    .store(false, Ordering::SeqCst);
                return;
            }
            thread::spawn(move || match stop_backend(&handle.state::<Backend>()) {
                Ok(()) => {
                    handle
                        .state::<Backend>()
                        .exit_allowed
                        .store(true, Ordering::SeqCst);
                    handle.exit(0);
                }
                Err(error) => {
                    handle
                        .state::<Backend>()
                        .quitting
                        .store(false, Ordering::SeqCst);
                    handle
                        .dialog()
                        .message(error)
                        .title("Koma 后端停止失败")
                        .show(|_| {});
                }
            });
        });
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
            }
        })
        .setup(|app| {
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
            app.manage(Backend {
                profile,
                binary,
                state_directory,
                child: Mutex::new(None),
                starting: Mutex::new(()),
                quitting: AtomicBool::new(false),
                exit_allowed: AtomicBool::new(false),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![initialize, desktop_preferences])
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("Failed to build the Tauri validation app");
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
