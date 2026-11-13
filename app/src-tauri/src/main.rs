// Crux Hub desktop app (decision 49 A, plan in board memo M028).
//
// A window and a tray icon on top of the hub. The app does not own the hub: at launch it asks the hub whether it is
// up and, if not, starts it the usual way (hub/restart.mjs, which starts it detached, the way it was last started).
// Quitting the app leaves the hub running, so the phone keeps working. Restarts (restart_hub, the hub menu, the tray)
// all go through the hub's own restart path, and the page reconnects by itself.
//
// The window shows the hub at http://crux.localhost:<port>, an outside address as far as Tauri is concerned. No
// capability names it, so neither the hub page nor anything an agent wrote can reach native features (CVE-2026-42184).
// The page reaches the hub straight from loopback, so the hub takes it as this PC (decision 48) with no change.
//
// Settings (all optional) in ~/crux/hub.json, or $CRUX_HOME/hub.json:  { "app": { "port": 4747, "hubDir": "C:/.../hub" } }
// The hub folder is, in order: app.hubDir; the folder of the hub as last started on that port (~/.crux-hub, or
// $CRUX_HUB_DATA, launch-<port>.json); the clone this app was built from.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

const MAIN: &str = "main";
const TRAY: &str = "crux";
const DEFAULT_PORT: u16 = 4747;
// Given to the app when Windows starts it at sign-in: start in the tray, with no window.
const HIDDEN_ARG: &str = "--hidden";
// The value name of the start-at-sign-in entry (HKCU\...\CurrentVersion\Run); installer-hooks.nsh uses it too.
const AUTOSTART_NAME: &str = "Crux Hub";

// What the app needs to know about the hub it sits on.
struct Hub {
    port: u16,
    dir: PathBuf,
    node: String,
    url: Url,
}

struct State {
    hub: Hub,
    busy: AtomicBool, // a start or restart is running
}

fn home() -> PathBuf {
    std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(PathBuf::from).unwrap_or_default()
}
fn env_dir(name: &str, default: impl FnOnce() -> PathBuf) -> PathBuf {
    std::env::var_os(name).filter(|v| !v.is_empty()).map(PathBuf::from).unwrap_or_else(default)
}
fn read_json(path: &Path) -> Option<serde_json::Value> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(text.trim_start_matches('\u{feff}')).ok() // a file saved by Notepad or PowerShell may start with a BOM
}
fn has_restart(dir: &Path) -> bool {
    dir.join("restart.mjs").is_file() && dir.join("server.mjs").is_file()
}

impl Hub {
    fn find() -> Hub {
        let crux_home = env_dir("CRUX_HOME", || home().join("crux"));
        let data = env_dir("CRUX_HUB_DATA", || home().join(".crux-hub"));
        let app = read_json(&crux_home.join("hub.json")).and_then(|v| v.get("app").cloned()).unwrap_or_default();
        let port = app
            .get("port")
            .and_then(|p| p.as_u64())
            .filter(|p| (1..=65535).contains(p))
            .map(|p| p as u16)
            .unwrap_or(DEFAULT_PORT);

        // How the hub on this port was last started (written by the hub itself, lib/relaunch.mjs).
        let launch = read_json(&data.join(format!("launch-{port}.json"))).unwrap_or_default();
        let from_launch = launch
            .get("args")
            .and_then(|a| a.as_array())
            .and_then(|a| a.iter().filter_map(|s| s.as_str()).find(|s| s.ends_with("server.mjs")))
            .and_then(|s| Path::new(s).parent().map(Path::to_path_buf));
        let candidates = [
            app.get("hubDir").and_then(|d| d.as_str()).map(PathBuf::from),
            from_launch,
            launch.get("cwd").and_then(|d| d.as_str()).map(PathBuf::from),
            Some(Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..").join("hub")),
        ];
        let dir = candidates.into_iter().flatten().find(|d| has_restart(d)).unwrap_or_default();
        let node = launch
            .get("node")
            .and_then(|n| n.as_str())
            .filter(|n| Path::new(n).is_file())
            .unwrap_or("node")
            .to_string();
        let url = Url::parse(&format!("http://crux.localhost:{port}/")).expect("hub address");
        Hub { port, dir, node, url }
    }

    // Is the hub up? A plain GET of /api/ping on loopback (always open, decision 47), with short timeouts.
    fn ping(&self) -> bool {
        let addr = SocketAddr::from(([127, 0, 0, 1], self.port));
        let Ok(mut s) = TcpStream::connect_timeout(&addr, Duration::from_millis(800)) else { return false };
        let _ = s.set_read_timeout(Some(Duration::from_millis(2000)));
        let _ = s.set_write_timeout(Some(Duration::from_millis(1000)));
        let req = format!("GET /api/ping HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n\r\n", self.port);
        if s.write_all(req.as_bytes()).is_err() {
            return false;
        }
        let mut out = String::new();
        let _ = s.take(64 * 1024).read_to_string(&mut out);
        out.starts_with("HTTP/1.1 200") && out.contains("\"hub\":true")
    }

    // Start or restart the hub the usual way: node restart.mjs --no-open, in the hub folder, with no window.
    // restart.mjs stops whatever listens on the port, starts the hub detached as it was last started, and waits
    // (up to 45 s) for it to answer. The hub it starts is not this app's child in any way that matters: it keeps
    // running when the app quits.
    fn restart(&self) -> bool {
        if !has_restart(&self.dir) {
            return false;
        }
        let mut cmd = Command::new(&self.node);
        cmd.arg("restart.mjs").arg("--no-open").arg("--port").arg(self.port.to_string()).current_dir(&self.dir);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let ok = cmd.status().map(|s| s.success()).unwrap_or(false);
        ok || self.wait_up(Duration::from_secs(5))
    }

    fn wait_up(&self, limit: Duration) -> bool {
        let end = Instant::now() + limit;
        while Instant::now() < end {
            if self.ping() {
                return true;
            }
            thread::sleep(Duration::from_millis(400));
        }
        false
    }

    // The hub's own pages: same scheme, host and port as the hub address.
    fn owns(&self, url: &Url) -> bool {
        url.scheme() == self.url.scheme() && url.host_str() == self.url.host_str() && url.port_or_known_default() == self.url.port_or_known_default()
    }
}

// The app's two static pages (starting, did not start) are served by Tauri itself.
fn local_page(url: &Url) -> bool {
    matches!(url.scheme(), "tauri") || (url.scheme() == "http" && url.host_str() == Some("tauri.localhost"))
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(MAIN) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn open_in_browser(app: &AppHandle, url: &Url) {
    if matches!(url.scheme(), "http" | "https") {
        let _ = app.opener().open_url(url.as_str(), None::<&str>);
    }
}

// Point the window at the hub once it answers, or at the "did not start" page.
fn show_result(app: &AppHandle, up: bool) {
    let Some(w) = app.get_webview_window(MAIN) else { return };
    let state = app.state::<Arc<State>>();
    if up {
        let on_hub = w.url().map(|u| state.hub.owns(&u)).unwrap_or(false);
        if !on_hub {
            let _ = w.navigate(state.hub.url.clone());
        }
    } else {
        let failed = w.url().ok().and_then(|u| u.join("/failed.html").ok());
        if let Some(f) = failed.filter(local_page).or_else(|| Url::parse("http://tauri.localhost/failed.html").ok()) {
            let _ = w.navigate(f);
        }
        show_main(app);
    }
}

// Start the hub (at launch, when it is down) or restart it (tray). One at a time.
fn run_hub(app: &AppHandle, restart_running: bool) {
    let state = app.state::<Arc<State>>().inner().clone();
    if state.busy.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    thread::spawn(move || {
        let tray = app.tray_by_id(TRAY);
        if let Some(t) = &tray {
            let _ = t.set_tooltip(Some(if restart_running { "Crux Hub: restarting the hub" } else { "Crux Hub: starting the hub" }));
        }
        let up = if !restart_running && state.hub.ping() { true } else { state.hub.restart() };
        if let Some(t) = &tray {
            let _ = t.set_tooltip(Some(if up { "Crux Hub" } else { "Crux Hub: the hub did not start" }));
        }
        state.busy.store(false, Ordering::SeqCst);
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || show_result(&handle, up));
    });
}

// Windows' start at sign-in is turned on once, and only in the installed app (the NSIS installer puts
// uninstall.exe beside it). Dev runs and the bare exe in target/ never touch it.
fn turn_on_autostart_once(app: &AppHandle) {
    if cfg!(debug_assertions) {
        return;
    }
    let installed = std::env::current_exe().ok().and_then(|e| e.parent().map(|d| d.join("uninstall.exe").is_file())).unwrap_or(false);
    if !installed {
        return;
    }
    let Ok(dir) = app.path().app_config_dir() else { return };
    let marker = dir.join("autostart-set");
    if marker.exists() {
        return;
    }
    if app.autolaunch().enable().is_ok() {
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::fs::write(&marker, "Start with Windows was turned on once at first run. Turn it off in Task Manager, Startup apps.\n");
    }
}

fn main() {
    let hidden = std::env::args().any(|a| a == HIDDEN_ARG);
    let state = Arc::new(State { hub: Hub::find(), busy: AtomicBool::new(false) });

    let app = tauri::Builder::default()
        // Registered first: a second launch brings the open window forward instead of starting another app.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if !args.iter().any(|a| a == HIDDEN_ARG) {
                show_main(app);
            }
        }))
        .plugin(tauri_plugin_window_state::Builder::default().with_state_flags(StateFlags::all() & !StateFlags::VISIBLE).build())
        // The sign-in entry's name is fixed: the uninstaller removes it by this name (installer-hooks.nsh).
        .plugin(tauri_plugin_autostart::Builder::new().app_name(AUTOSTART_NAME).arg(HIDDEN_ARG).build())
        .plugin(tauri_plugin_opener::init())
        .manage(state.clone())
        .setup(move |app| {
            let handle = app.handle().clone();
            let up = state.hub.ping();

            // The window starts hidden (no flash while its size and place are restored) and is shown unless Windows
            // started the app at sign-in. It opens on the hub, or on the "starting" page while the hub starts.
            let start = if up { WebviewUrl::External(state.hub.url.clone()) } else { WebviewUrl::App("index.html".into()) };
            let nav_state = state.clone();
            let nav_app = handle.clone();
            let popup_app = handle.clone();
            let window = WebviewWindowBuilder::new(app, MAIN, start)
                .title("Crux Hub")
                .inner_size(1280.0, 860.0)
                .min_inner_size(380.0, 520.0)
                .visible(false)
                // The window stays on the hub and the app's own pages; any other address opens in the browser.
                .on_navigation(move |url| {
                    if nav_state.hub.owns(url) || local_page(url) || url.scheme() == "about" {
                        return true;
                    }
                    open_in_browser(&nav_app, url);
                    false
                })
                // Links that open a new tab or window open in the default browser.
                .on_new_window(move |url, _features| {
                    open_in_browser(&popup_app, &url);
                    NewWindowResponse::Deny
                })
                .build()?;
            if !hidden {
                let _ = window.show();
                let _ = window.set_focus();
            }

            // Tray: Open, Restart hub, Quit (the app only). A left-click opens the window.
            let open = MenuItem::with_id(app, "open", "Open Crux Hub", true, None::<&str>)?;
            let restart = MenuItem::with_id(app, "restart", "Restart hub", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit (the hub keeps running)", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &restart, &PredefinedMenuItem::separator(app)?, &quit])?;
            let mut tray = TrayIconBuilder::with_id(TRAY)
                .tooltip("Crux Hub")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open" => show_main(app),
                    "restart" => run_hub(app, true),
                    "quit" => {
                        let _ = app.save_window_state(StateFlags::all() & !StateFlags::VISIBLE);
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                        show_main(tray.app_handle());
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;

            turn_on_autostart_once(&handle);
            if !up {
                run_hub(&handle, false);
            }
            Ok(())
        })
        // The close button hides the window to the tray; Quit in the tray menu closes the app.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == MAIN {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("could not start the Crux Hub app");

    app.run(|_app, event| {
        // Only Quit (an explicit exit code) ends the app; a last window going away does not.
        if let RunEvent::ExitRequested { api, code: None, .. } = event {
            api.prevent_exit();
        }
    });
}
