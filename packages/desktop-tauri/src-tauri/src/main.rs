#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    path::{Path, PathBuf},
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
    child: Mutex<Option<Child>>,
    starting: Mutex<()>,
    quitting: AtomicBool,
    exit_allowed: AtomicBool,
}

#[derive(Deserialize, Serialize)]
struct Connection {
    url: String,
    username: String,
    password: String,
    #[serde(default)]
    profile: String,
}

fn backend_command(backend: &Backend) -> Command {
    let mut command = Command::new(&backend.binary);
    command
        .env("KOMA_HOME", &backend.profile)
        .env("OPENCODE_HOME", &backend.profile)
        .current_dir(&backend.profile);
    command
}

// Match KomaBackend.stateDirectory: retain existing locks for a legacy profile,
// use the current directory for a new profile, and reject ambiguous ownership.
fn backend_state_directory(profile: &Path) -> Result<PathBuf, String> {
    let current = profile.join("bin/.koma-backend");
    let legacy = profile.join("bin/.lab-backend");
    if current.exists() && legacy.exists() {
        return Err("Conflicting Koma backend state directories".into());
    }
    Ok(if legacy.exists() { legacy } else { current })
}

fn discover(backend: &Backend) -> Option<Connection> {
    let output = backend_command(backend)
        .args(["backend", "status"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let status: serde_json::Value = serde_json::from_slice(&output.stdout).ok()?;
    if status.get("running")?.as_bool()? != true {
        return None;
    }
    let data = fs::read(
        backend_state_directory(&backend.profile)
            .ok()?
            .join("backend.json"),
    )
    .ok()?;
    let mut connection: Connection = serde_json::from_slice(&data).ok()?;
    if status.get("url")?.as_str()? != connection.url {
        return None;
    }
    connection.profile = backend.profile.to_string_lossy().into_owned();
    Some(connection)
}

fn ensure_backend(backend: &Backend) -> Result<Connection, String> {
    let _lock = backend.starting.lock().map_err(|e| e.to_string())?;
    if let Some(connection) = discover(backend) {
        return Ok(connection);
    }
    // A live but unresponsive owner must not be replaced. The backend's own
    // ownership lock is authoritative and refuses another claim for this profile.
    let logs = backend_state_directory(&backend.profile)?;
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
                return Err(format!("Test backend exited: {status}"));
            }
        }
        drop(guard);
        thread::sleep(Duration::from_millis(200));
    }
    Err("Test backend did not become ready within 45 seconds; ownership was preserved".into())
}

#[tauri::command]
async fn initialize(app: tauri::AppHandle) -> Result<Connection, String> {
    tauri::async_runtime::spawn_blocking(move || ensure_backend(&app.state::<Backend>()))
        .await
        .map_err(|e| e.to_string())?
}

fn stop_backend(backend: &Backend) -> Result<(), String> {
    let _lock = backend.starting.lock().map_err(|e| e.to_string())?;
    if discover(backend).is_none()
        && !backend_state_directory(&backend.profile)?
            .join("backend.json")
            .exists()
    {
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
        .message("退出将停止 Tauri 测试后端及其测试任务。关闭窗口可保留任务运行。")
        .title("退出 Tauri 测试版？")
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
                        .title("测试后端停止失败")
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
                        "Quit OpenCode Lab Tauri Test",
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
            // This locally built validation app is tied to its source worktree.
            // Do not honor a caller's OPENCODE_HOME or use the production profile.
            let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../..")
                .canonicalize()?;
            let profile = repo.join(".local/desktop-tests/tauri/profile");
            fs::create_dir_all(&profile)?;
            if profile.canonicalize()? != profile {
                return Err("Test profile must not use a symlink".into());
            }
            let binary = if cfg!(debug_assertions) {
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("binaries/opencode-lab-aarch64-apple-darwin")
            } else {
                std::env::current_exe()?
                    .parent()
                    .ok_or("No executable directory")?
                    .join("opencode-lab")
            };
            if !binary.is_file() {
                return Err(format!("Missing test backend: {}", binary.display()).into());
            }
            app.manage(Backend {
                profile,
                binary,
                child: Mutex::new(None),
                starting: Mutex::new(()),
                quitting: AtomicBool::new(false),
                exit_allowed: AtomicBool::new(false),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![initialize])
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
    fn backend_paths_preserve_legacy_ownership_and_reject_conflicts() {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("tauri-owner-{}-{nonce}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        assert_eq!(
            backend_state_directory(&root).unwrap(),
            root.join("bin/.koma-backend")
        );
        fs::create_dir_all(root.join("bin/.lab-backend")).unwrap();
        assert_eq!(
            backend_state_directory(&root).unwrap(),
            root.join("bin/.lab-backend")
        );
        fs::create_dir_all(root.join("bin/.koma-backend")).unwrap();
        assert!(backend_state_directory(&root).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn every_backend_command_pins_both_profile_variables() {
        let profile = PathBuf::from("/isolated/desktop-tests/tauri/profile");
        let backend = Backend {
            profile: profile.clone(),
            binary: PathBuf::from("/test-backend"),
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
    }
}
