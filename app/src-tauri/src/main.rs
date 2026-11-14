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
// Decision 52 A (as amended by 54 B): the installer carries Node and the hub (runtime/ beside the exe, filled by
// app/scripts/stage.mjs), but not Claude Code, which the hub's first-run screen downloads. The app still only attaches.
//
// Settings (all optional) in ~/crux/hub.json, or $CRUX_HOME/hub.json:  { "app": { "port": 4747, "hubDir": "C:/.../hub" } }
// The hub folder is, in order: app.hubDir; the git clone the hub on that port was last started from (~/.crux-hub,
// or $CRUX_HUB_DATA, launch-<port>.json), so a clone such as Matt's keeps running with no setup and no hand edit; the
// hub that came with the app (runtime/hub); the clone this app was built from.
//
// Updates (tauri-plugin-updater): checked a minute after launch and once a day against latest.json on GitHub
// Releases, verified with the public key in tauri.conf.json. A ready update shows as "Install update x.y.z" at the top
// of the tray menu and installs only when clicked, because installing restarts the hub. The installer stops the
// app's own hub first (installer-hooks.nsh, runtime/stop-bundled-hub.mjs); the app starts it again after.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent, Wry};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::{Update, UpdaterExt};
use tauri_plugin_window_state::{AppHandleExt, StateFlags};
use tauri_winrt_notification::Toast;

const MAIN: &str = "main";
const TRAY: &str = "crux";
const DEFAULT_PORT: u16 = 4747;
// Given to the app when Windows starts it at sign-in: start in the tray, with no window.
const HIDDEN_ARG: &str = "--hidden";

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
    menu: Mutex<Option<Menu<Wry>>>,
    update_item: Mutex<Option<MenuItem<Wry>>>,
    update: Mutex<Option<Update>>, // a checked, ready update, installed only from the tray
    installing: AtomicBool,
}

// The folder beside the exe that holds the app's own Node and hub (Tauri resources; in dev builds too).
fn runtime_dir() -> Option<PathBuf> {
    let dir = std::env::current_exe().ok()?.parent()?.join("runtime");
    dir.is_dir().then_some(dir)
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
        let runtime = runtime_dir();
        let bundled_hub = runtime.as_ref().map(|r| r.join("hub"));
        // A hub last started from a git clone (its folder's parent holds .git, as in Matt's crux clone) stays in
        // charge with no setup: the app keeps using that clone, as 0.1.0 did. The app's own hub is used only when
        // there is no such clone, or hubDir names it.
        let from_clone = from_launch.clone().filter(|d| d.parent().map(|p| p.join(".git").exists()).unwrap_or(false));
        let candidates = [
            app.get("hubDir").and_then(|d| d.as_str()).map(PathBuf::from),
            from_clone,
            bundled_hub.clone(),
            from_launch,
            launch.get("cwd").and_then(|d| d.as_str()).map(PathBuf::from),
            Some(Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..").join("hub")),
        ];
        let dir = candidates.into_iter().flatten().find(|d| has_restart(d)).unwrap_or_default();
        // The app's own Node runs its own hub; a clone runs on the Node it was last started with, or the one on PATH.
        let own_node = runtime.map(|r| r.join("node").join("node.exe")).filter(|n| n.is_file());
        let node = match (&own_node, bundled_hub.as_deref() == Some(dir.as_path())) {
            (Some(n), true) => n.to_string_lossy().into_owned(),
            _ => launch
                .get("node")
                .and_then(|n| n.as_str())
                .filter(|n| Path::new(n).is_file())
                .map(str::to_string)
                .or_else(|| own_node.as_ref().map(|n| n.to_string_lossy().into_owned()))
                .unwrap_or_else(|| "node".to_string()),
        };
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
// CRUX_APP_NO_AUTOSTART=1 keeps a test install (into a temp folder) from adding the sign-in entry.
fn turn_on_autostart_once(app: &AppHandle) {
    if cfg!(debug_assertions) || std::env::var("CRUX_APP_NO_AUTOSTART").as_deref() == Ok("1") {
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

// ---------- PC notices (decision 58 A) ----------
// The hub decides what to tell and where: the PC while it is in use, the phone as backup. The app holds the hub's
// desktop stream open (this PC only), reports every 30 s how long since the last keyboard or mouse input and whether
// the PC is locked, and shows each card it is sent as a Windows notice. A click opens that card in the window.

// Windows' own idle and lock state, without another crate.
#[cfg(windows)]
mod pc_state {
    #[repr(C)]
    struct LastInputInfo {
        cb_size: u32,
        dw_time: u32,
    }
    #[link(name = "user32")]
    extern "system" {
        fn GetLastInputInfo(plii: *mut LastInputInfo) -> i32;
        fn OpenInputDesktop(flags: u32, inherit: i32, access: u32) -> isize;
        fn CloseDesktop(desktop: isize) -> i32;
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetTickCount() -> u32;
    }
    // Milliseconds since the last keyboard or mouse input on this PC.
    pub fn idle_ms() -> u64 {
        let mut info = LastInputInfo { cb_size: std::mem::size_of::<LastInputInfo>() as u32, dw_time: 0 };
        // SAFETY: a plain Win32 call with a correctly sized struct.
        unsafe {
            if GetLastInputInfo(&mut info) == 0 {
                return 0;
            }
            GetTickCount().wrapping_sub(info.dw_time) as u64
        }
    }
    #[link(name = "advapi32")]
    extern "system" {
        fn RegGetValueW(hkey: isize, sub_key: *const u16, value: *const u16, flags: u32, kind: *mut u32, data: *mut u8, size: *mut u32) -> i32;
    }
    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }
    // A DWORD under HKEY_CURRENT_USER, or None when it is not set.
    fn user_dword(sub_key: &str, value: &str) -> Option<u32> {
        const HKEY_CURRENT_USER: isize = 0x8000_0001_u32 as i32 as isize;
        const RRF_RT_REG_DWORD: u32 = 0x10;
        let (k, v) = (wide(sub_key), wide(value));
        let mut data: u32 = 0;
        let mut size = std::mem::size_of::<u32>() as u32;
        // SAFETY: NUL-terminated strings and a buffer of the size given.
        let rc = unsafe { RegGetValueW(HKEY_CURRENT_USER, k.as_ptr(), v.as_ptr(), RRF_RT_REG_DWORD, std::ptr::null_mut(), &mut data as *mut u32 as *mut u8, &mut size) };
        (rc == 0).then_some(data)
    }
    // Whether Windows lets this app show notices. Asks Windows itself (the app's notifier setting), which covers the
    // master switch, the app's own switch and a registry value not yet picked up. Should Windows not answer (an app
    // identity it doesn't know), falls back to reading the two switches from the registry.
    pub fn notices_on(app_id: &str) -> bool {
        use windows::core::HSTRING;
        use windows::UI::Notifications::{NotificationSetting, ToastNotificationManager};
        match ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(app_id)).and_then(|n| n.Setting()) {
            Ok(setting) => setting == NotificationSetting::Enabled,
            Err(_) => notices_on_registry(app_id),
        }
    }
    // The master switch (Settings, System, Notifications) and the app's own switch there. Unset means on.
    fn notices_on_registry(app_id: &str) -> bool {
        let master = user_dword("Software\\Microsoft\\Windows\\CurrentVersion\\PushNotifications", "ToastEnabled").unwrap_or(1);
        let own = user_dword(&format!("Software\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings\\{app_id}"), "Enabled").unwrap_or(1);
        master != 0 && own != 0
    }
    // Locked: the input desktop is the secure one, which this session cannot open.
    pub fn locked() -> bool {
        const DESKTOP_SWITCHDESKTOP: u32 = 0x0100;
        // SAFETY: the handle is closed straight away.
        unsafe {
            let h = OpenInputDesktop(0, 0, DESKTOP_SWITCHDESKTOP);
            if h == 0 {
                return true;
            }
            CloseDesktop(h);
            false
        }
    }
}
#[cfg(not(windows))]
mod pc_state {
    pub fn idle_ms() -> u64 {
        0
    }
    pub fn locked() -> bool {
        false
    }
    pub fn notices_on(_app_id: &str) -> bool {
        false
    }
}

// One short request to the hub on loopback, as this PC (Host crux.localhost, no Origin).
fn hub_post(port: u16, path: &str, body: &str) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut s) = TcpStream::connect_timeout(&addr, Duration::from_millis(800)) else { return false };
    let _ = s.set_read_timeout(Some(Duration::from_secs(3)));
    let req = format!(
        "POST {path} HTTP/1.0\r\nHost: crux.localhost:{port}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    );
    if s.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut out = String::new();
    let _ = s.take(16 * 1024).read_to_string(&mut out);
    out.starts_with("HTTP/1.1 200") || out.starts_with("HTTP/1.0 200")
}

// The identity notices are shown under. Installed builds use the app's own (its Start menu shortcut carries it), so
// the notice says Crux Hub; dev builds borrow PowerShell's, as Windows only shows notices for installed apps.
fn notice_app_id(app: &AppHandle) -> String {
    if cfg!(debug_assertions) {
        Toast::POWERSHELL_APP_ID.to_string()
    } else {
        app.config().identifier.clone()
    }
}

// notices: false when Windows notices are switched off, so the hub sends the card to the phone at once instead of to
// a PC that would not show it.
fn report_presence(port: u16, client: &str, app_id: &str) {
    let body = serde_json::json!({ "client": client, "idleMs": pc_state::idle_ms(), "locked": pc_state::locked(), "notices": pc_state::notices_on(app_id) }).to_string();
    hub_post(port, "/api/desktop/presence", &body);
}

// Show one card as a Windows notice.
fn show_notice(app: &AppHandle, card: &serde_json::Value) {
    let state = app.state::<Arc<State>>().inner().clone();
    let title = card.get("title").and_then(|t| t.as_str()).unwrap_or("Crux Hub").to_string();
    let body = card.get("body").and_then(|t| t.as_str()).unwrap_or("").to_string();
    let target = card.get("url").and_then(|u| u.as_str()).and_then(|u| state.hub.url.join(u).ok()).filter(|u| state.hub.owns(u)).unwrap_or_else(|| state.hub.url.clone());
    let app_id = notice_app_id(app);
    let handle = app.clone();
    // Shown from the main thread, which Windows has set up for these calls.
    let _ = app.run_on_main_thread(move || {
        let click = handle.clone();
        let _ = Toast::new(&app_id)
            .title(&title)
            .text1(&body)
            .on_activated(move |_| {
                let h = click.clone();
                let t = target.clone();
                let _ = click.run_on_main_thread(move || {
                    show_main(&h);
                    if let Some(w) = h.get_webview_window(MAIN) {
                        let _ = w.navigate(t);
                    }
                });
                Ok(())
            })
            .show();
    });
}

// Holds the hub's desktop stream open for as long as the app runs, reconnecting after a hub restart, and reports
// the PC's state every 30 s while connected.
fn start_pc_notices(app: &AppHandle) {
    let port = app.state::<Arc<State>>().hub.port;
    let client = format!("crux-app-{}", std::process::id());
    let app_id = notice_app_id(app);
    let (reporter, reporter_id) = (client.clone(), app_id.clone());
    thread::spawn(move || loop {
        report_presence(port, &reporter, &reporter_id);
        thread::sleep(Duration::from_secs(30));
    });
    let app = app.clone();
    thread::spawn(move || loop {
        let addr = SocketAddr::from(([127, 0, 0, 1], port));
        if let Ok(mut s) = TcpStream::connect_timeout(&addr, Duration::from_secs(2)) {
            // HTTP/1.0, so the hub sends the stream plainly (no chunks) and closes it when it stops.
            let req = format!("GET /api/desktop/stream?client={client} HTTP/1.0\r\nHost: crux.localhost:{port}\r\n\r\n");
            let _ = s.set_read_timeout(Some(Duration::from_secs(90)));   // the hub pings every 25 s
            if s.write_all(req.as_bytes()).is_ok() {
                let mut lines = BufReader::new(s).lines();
                let ok = matches!(lines.next(), Some(Ok(l)) if l.contains(" 200"));
                if ok {
                    for l in lines.by_ref() {
                        if matches!(l, Ok(ref h) if h.is_empty()) {
                            break;   // end of the headers
                        }
                    }
                    report_presence(port, &client, &app_id);   // at once, so a card right after a restart routes right
                    let mut event = String::new();
                    for line in lines {
                        let Ok(line) = line else { break };
                        if let Some(e) = line.strip_prefix("event: ") {
                            event = e.to_string();
                        } else if let Some(d) = line.strip_prefix("data: ") {
                            if event == "notify" {
                                if let Ok(card) = serde_json::from_str::<serde_json::Value>(d) {
                                    show_notice(&app, &card);
                                }
                            }
                            // "clear": a settled card. The notice library cannot take a shown notice down, so it
                            // stays in Action Center; clicking it opens the card, which shows it as settled.
                        } else if line.is_empty() {
                            event.clear();
                        }
                    }
                }
            }
        }
        thread::sleep(Duration::from_secs(3));
    });
}

// ---------- updates ----------
fn set_tooltip(app: &AppHandle, text: &str) {
    if let Some(t) = app.tray_by_id(TRAY) {
        let _ = t.set_tooltip(Some(text));
    }
}

// The updater, pointed at latest.json on GitHub Releases (tauri.conf.json). CRUX_APP_UPDATE_URL points it elsewhere
// for a rehearsal; the signature is checked against the same public key either way.
fn updater(app: &AppHandle) -> tauri_plugin_updater::Result<tauri_plugin_updater::Updater> {
    let mut b = app.updater_builder();
    if let Some(url) = std::env::var("CRUX_APP_UPDATE_URL").ok().and_then(|u| Url::parse(&u).ok()) {
        b = b.endpoints(vec![url])?;
    }
    b.build()
}

// Ask for an update; when one is ready, put "Install update x.y.z" at the top of the tray menu. Nothing installs here.
async fn check_update(app: AppHandle) {
    let state = app.state::<Arc<State>>().inner().clone();
    if state.installing.load(Ordering::SeqCst) {
        return;
    }
    let Ok(up) = updater(&app) else { return };
    let Ok(Some(update)) = up.check().await else { return };
    let label = format!("Install update {}", update.version);
    *state.update.lock().unwrap() = Some(update);
    let menu = state.menu.lock().unwrap().clone();
    let item = state.update_item.lock().unwrap().clone();
    if let (Some(menu), Some(item)) = (menu, item) {
        let _ = item.set_text(&label);
        if !menu.items().map(|v| v.iter().any(|i| i.id() == item.id())).unwrap_or(false) {
            let _ = menu.insert(&item, 0);
        }
    }
    set_tooltip(&app, &format!("Crux Hub: update {} ready (tray menu)", label.trim_start_matches("Install update ")));
}

// From the tray: download, check and run the installer. On Windows the updater then closes the app; the installer
// stops the app's own hub before replacing files, and starts the new app, which starts the hub again.
fn install_update(app: &AppHandle) {
    let state = app.state::<Arc<State>>().inner().clone();
    let Some(update) = state.update.lock().unwrap().take() else { return };
    if state.installing.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut got: u64 = 0;
        let progress = app.clone();
        let result = update
            .download_and_install(
                move |chunk, total| {
                    got += chunk as u64;
                    if let Some(t) = total.filter(|t| *t > 0) {
                        set_tooltip(&progress, &format!("Crux Hub: downloading the update, {}%", got * 100 / t));
                    }
                },
                || {},
            )
            .await;
        // Reached only when installing failed (on success the app has already closed).
        if let Err(e) = result {
            set_tooltip(&app, &format!("Crux Hub: the update did not install ({e})"));
            *app.state::<Arc<State>>().update.lock().unwrap() = Some(update);
            app.state::<Arc<State>>().installing.store(false, Ordering::SeqCst);
        }
    });
}

// A minute after launch, then once a day. Dev runs check only when CRUX_APP_UPDATE_URL is set.
fn schedule_update_checks(app: &AppHandle) {
    if cfg!(debug_assertions) && std::env::var("CRUX_APP_UPDATE_URL").is_err() {
        return;
    }
    let first = std::env::var("CRUX_APP_UPDATE_URL").map(|_| 5).unwrap_or(60);
    let app = app.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_secs(first));
        loop {
            tauri::async_runtime::block_on(check_update(app.clone()));
            thread::sleep(Duration::from_secs(24 * 60 * 60));
        }
    });
}

fn main() {
    let hidden = std::env::args().any(|a| a == HIDDEN_ARG);
    let state = Arc::new(State {
        hub: Hub::find(),
        busy: AtomicBool::new(false),
        menu: Mutex::new(None),
        update_item: Mutex::new(None),
        update: Mutex::new(None),
        installing: AtomicBool::new(false),
    });

    let app = tauri::Builder::default()
        // Registered first: a second launch brings the open window forward instead of starting another app.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if !args.iter().any(|a| a == HIDDEN_ARG) {
                show_main(app);
            }
        }))
        .plugin(tauri_plugin_window_state::Builder::default().with_state_flags(StateFlags::all() & !StateFlags::VISIBLE).build())
        // The sign-in entry is named after the product ("Crux Hub", as in 0.1.0); the uninstaller removes it by that
        // name (installer-hooks.nsh, PRODUCTNAME).
        .plugin(tauri_plugin_autostart::Builder::new().arg(HIDDEN_ARG).build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
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
                // Files dragged in from Explorer go to the page's own drop zones (attachments in threads). Tauri's
                // handler would otherwise take every drop first on Windows, and the page would never see it. A file
                // dropped where the page takes none would open as a file:// address, which on_navigation refuses.
                .disable_drag_drop_handler()
                // The window stays on the hub and the app's own pages; any other web address opens in the browser,
                // and anything else (a dropped file's file:// address included) stays out.
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
            // Added at the top of the menu only when an update is ready (check_update).
            let update_item = MenuItem::with_id(app, "update", "Install update", true, None::<&str>)?;
            *state.menu.lock().unwrap() = Some(menu.clone());
            *state.update_item.lock().unwrap() = Some(update_item);
            let mut tray = TrayIconBuilder::with_id(TRAY)
                .tooltip("Crux Hub")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open" => show_main(app),
                    "restart" => run_hub(app, true),
                    "update" => install_update(app),
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
            schedule_update_checks(&handle);
            start_pc_notices(&handle);
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
