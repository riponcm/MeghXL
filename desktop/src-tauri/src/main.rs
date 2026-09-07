// MeghXL desktop shell.
//
// The app is a thin native wrapper: it starts the MeghXL server as a bundled
// sidecar binary, waits for it to listen, and points the window at the
// dashboard it serves. A tray icon keeps it reachable once the window is
// closed. All of the product lives in the server + dashboard; nothing here
// duplicates it.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream, UdpSocket};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::menu::{CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::webview::{DownloadEvent, WebviewWindow, WebviewWindowBuilder};
use tauri::WebviewUrl;
use tauri::{Manager, RunEvent, WindowEvent};
use tauri_plugin_autostart::ManagerExt as AutostartExt;
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

/// Preferred port. MeghXL's links, QR codes and bookmarks all assume it, so we
/// only move off it if something else has already taken it.
const DEFAULT_PORT: u16 = 3000;
const STARTUP_TIMEOUT: Duration = Duration::from_secs(25);

/// The sidecar we spawned, if any. Stays `None` when we attach to a server that
/// was already running (e.g. one started by the autostart LaunchAgent) — that
/// process isn't ours to kill.
struct Server {
    child: Mutex<Option<CommandChild>>,
}

/// The destination we assigned to the download currently in flight. macOS
/// never reports the saved path back on `Finished`, so we keep our own copy.
struct Downloads(Mutex<Option<PathBuf>>);

// ---------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------

fn download_dir_file(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("download-dir.txt"))
}

/// Where finished downloads are written: the folder the user picked, else the
/// OS Downloads folder.
fn download_dir(app: &tauri::AppHandle) -> PathBuf {
    if let Some(saved) = download_dir_file(app)
        .and_then(|f| fs::read_to_string(f).ok())
        .map(|s| PathBuf::from(s.trim()))
    {
        if saved.is_dir() {
            return saved;
        }
    }
    app.path().download_dir().unwrap_or_else(|_| PathBuf::from("."))
}

fn set_download_dir(app: &tauri::AppHandle, dir: &Path) {
    if let Some(f) = download_dir_file(app) {
        if let Some(parent) = f.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let _ = fs::write(f, dir.to_string_lossy().as_bytes());
    }
}

/// Never silently overwrite: "notes.md" becomes "notes (1).md".
fn unique_path(dir: &Path, name: &str) -> PathBuf {
    let as_path = Path::new(name);
    let stem = as_path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "download".into());
    let ext = as_path
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    let mut candidate = dir.join(name);
    let mut n = 1;
    while candidate.exists() {
        candidate = dir.join(format!("{stem} ({n}){ext}"));
        n += 1;
    }
    candidate
}

/// The dashboard window. Files are always written to disk — this window never
/// renders a transferred file, whatever its type.
fn create_main_window(app: &tauri::AppHandle, port: u16) -> tauri::Result<WebviewWindow> {
    let dl = app.clone();
    let nav = app.clone();
    WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("MeghXL")
        .inner_size(1180.0, 800.0)
        .min_inner_size(420.0, 520.0)
        .resizable(true)
        .center()
        // Let the dashboard's own HTML5 dropzone receive Finder/Explorer drops.
        .disable_drag_drop_handler()
        .on_download(move |_webview, event| {
            match event {
                DownloadEvent::Requested { destination, .. } => {
                    let name = destination
                        .file_name()
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_else(|| "download".into());
                    let dir = download_dir(&dl);
                    let _ = fs::create_dir_all(&dir);
                    let target = unique_path(&dir, &name);
                    if let Some(state) = dl.try_state::<Downloads>() {
                        *state.0.lock().unwrap() = Some(target.clone());
                    }
                    *destination = target;
                }
                DownloadEvent::Finished { success, .. } => {
                    let saved = dl
                        .try_state::<Downloads>()
                        .and_then(|s| s.0.lock().unwrap().take());
                    let body = match (&saved, success) {
                        (Some(p), true) => format!("Saved to {}", p.display()),
                        (None, true) => "Saved".to_string(),
                        _ => "Download failed".to_string(),
                    };
                    let _ = dl.notification().builder().title("MeghXL").body(body).show();
                }
                _ => {}
            }
            true
        })
        // Keep this window on the dashboard; send anything else to the browser.
        .on_navigation(move |url| {
            let allowed = matches!(url.scheme(), "tauri" | "asset")
                || (matches!(url.host_str(), Some("127.0.0.1") | Some("localhost"))
                    && url.port() == Some(port));
            if !allowed {
                let _ = nav.opener().open_url(url.to_string(), None::<&str>);
            }
            allowed
        })
        .build()
}

// ---------------------------------------------------------------------------
// Port / network helpers
// ---------------------------------------------------------------------------

fn local(port: u16) -> SocketAddr {
    SocketAddr::from((Ipv4Addr::LOCALHOST, port))
}

fn port_listening(port: u16) -> bool {
    TcpStream::connect_timeout(&local(port), Duration::from_millis(400)).is_ok()
}

/// True when whatever is on `port` answers MeghXL's health check — i.e. it is
/// already a MeghXL server and we should attach instead of starting a second.
fn is_meghxl(port: u16) -> bool {
    let Ok(mut sock) = TcpStream::connect_timeout(&local(port), Duration::from_millis(600)) else {
        return false;
    };
    let _ = sock.set_read_timeout(Some(Duration::from_millis(2000)));
    let req = b"GET /api/health HTTP/1.0\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n";
    if sock.write_all(req).is_err() {
        return false;
    }
    let mut buf = Vec::new();
    let _ = sock.read_to_end(&mut buf);
    String::from_utf8_lossy(&buf).contains("\"ok\":true")
}

fn first_free_port(start: u16) -> u16 {
    (start..start.saturating_add(50))
        .find(|p| TcpListener::bind(local(*p)).is_ok())
        .unwrap_or(start)
}

/// This machine's LAN address, for the "copy network link" tray action.
/// Connecting a UDP socket sends no packets — it just asks the routing table
/// which interface would be used.
fn lan_ip() -> Option<String> {
    let sock = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).ok()?;
    sock.connect(("8.8.8.8", 80)).ok()?;
    Some(sock.local_addr().ok()?.ip().to_string())
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/// The dashboard's static files, staged next to the binary by
/// `scripts/build-server.sh`. Falls back to the repo copy under `tauri dev`.
fn public_dir(app: &tauri::AppHandle) -> PathBuf {
    if let Ok(p) = app.path().resolve("resources/public", tauri::path::BaseDirectory::Resource) {
        if p.join("index.html").is_file() {
            return p;
        }
    }
    PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../../public"))
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

/// Start the bundled server, or attach to one that is already running.
/// Returns the port it is (or will be) reachable on.
fn start_server(app: &tauri::AppHandle) -> Result<(u16, Option<CommandChild>), String> {
    if port_listening(DEFAULT_PORT) {
        if is_meghxl(DEFAULT_PORT) {
            // Already served by MeghXL (autostart agent, terminal, or a second
            // launch of this app). Use it rather than fighting over the port.
            return Ok((DEFAULT_PORT, None));
        }
    }
    let port = first_free_port(DEFAULT_PORT);

    // Transferred files and the metadata store live outside the .app bundle so
    // they survive upgrades and stay writable.
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data directory: {e}"))?;
    let uploads = data_dir.join("uploads");
    std::fs::create_dir_all(&uploads).map_err(|e| format!("cannot create {uploads:?}: {e}"))?;

    let mut env: HashMap<String, String> = HashMap::new();
    // Tie the server's life to ours — see the matching block in server.js.
    env.insert("MEGHXL_EXIT_WITH_PARENT".into(), "1".into());
    env.insert("PORT".into(), port.to_string());
    env.insert("PUBLIC_DIR".into(), public_dir(app).to_string_lossy().into_owned());
    env.insert("UPLOAD_DIR".into(), uploads.to_string_lossy().into_owned());
    env.insert(
        "DATA_FILE".into(),
        data_dir.join("metadata.json").to_string_lossy().into_owned(),
    );

    let (mut rx, child) = app
        .shell()
        .sidecar("meghxl-server")
        .map_err(|e| format!("sidecar not found: {e}"))?
        .envs(env)
        .spawn()
        .map_err(|e| format!("could not start the server: {e}"))?;

    // Drain the sidecar's output so its pipes never fill up, and mirror it to
    // our own stdout for `tauri dev` / Console.app debugging.
    tauri::async_runtime::spawn(async move {
        use tauri_plugin_shell::process::CommandEvent;
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => print!("{}", String::from_utf8_lossy(&line)),
                CommandEvent::Stderr(line) => eprint!("{}", String::from_utf8_lossy(&line)),
                CommandEvent::Terminated(payload) => {
                    eprintln!("[meghxl] server exited: {payload:?}");
                }
                _ => {}
            }
        }
    });

    Ok((port, Some(child)))
}

/// Poll until the server answers, then swap the splash screen for the dashboard.
fn show_dashboard_when_ready(app: tauri::AppHandle, port: u16) {
    std::thread::spawn(move || {
        let deadline = Instant::now() + STARTUP_TIMEOUT;
        while Instant::now() < deadline {
            if is_meghxl(port) {
                let url = format!("http://127.0.0.1:{port}/");
                if let Some(win) = app.get_webview_window("main") {
                    if let Ok(parsed) = url.parse() {
                        let _ = win.navigate(parsed);
                    }
                }
                return;
            }
            std::thread::sleep(Duration::from_millis(250));
        }
        if let Some(win) = app.get_webview_window("main") {
            let _ = win.eval(
                "window.__meghxlFailed && window.__meghxlFailed('The MeghXL server did not \
                 start within 25 seconds. Check Console.app for details.')",
            );
        }
    });
}

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------

fn build_tray(app: &tauri::AppHandle, port: u16) -> tauri::Result<()> {
    let open = MenuItemBuilder::with_id("open", "Open MeghXL").build(app)?;
    let console = MenuItemBuilder::with_id("console", "Host console").build(app)?;
    let copy = MenuItemBuilder::with_id("copy", "Copy network link").build(app)?;
    let downloads = MenuItemBuilder::with_id("downloads", "Open downloads folder").build(app)?;
    let downloads_set =
        MenuItemBuilder::with_id("downloads-set", "Change downloads folder…").build(app)?;
    let autostart = CheckMenuItemBuilder::with_id("autostart", "Start at login")
        .checked(app.autolaunch().is_enabled().unwrap_or(false))
        .build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "Quit MeghXL").build(app)?;

    let menu = MenuBuilder::new(app)
        .items(&[
            &open,
            &console,
            &copy,
            &PredefinedMenuItem::separator(app)?,
            &downloads,
            &downloads_set,
            &PredefinedMenuItem::separator(app)?,
            &autostart,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ])
        .build()?;

    let show = move |app: &tauri::AppHandle, path: &str| {
        if let Some(win) = app.get_webview_window("main") {
            if let Ok(url) = format!("http://127.0.0.1:{port}{path}").parse() {
                let _ = win.navigate(url);
            }
            let _ = win.show();
            let _ = win.unminimize();
            let _ = win.set_focus();
        }
    };

    TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().unwrap().clone())
        .tooltip("MeghXL — local network file transfer")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "open" => show(app, "/"),
            "console" => show(app, "/admin"),
            "copy" => {
                let host = lan_ip().unwrap_or_else(|| "127.0.0.1".into());
                let _ = app.clipboard().write_text(format!("http://{host}:{port}/"));
            }
            "downloads" => {
                let dir = download_dir(app);
                let _ = fs::create_dir_all(&dir);
                let _ = app.opener().open_path(dir.to_string_lossy().to_string(), None::<&str>);
            }
            "downloads-set" => {
                let app = app.clone();
                app.clone()
                    .dialog()
                    .file()
                    .set_title("Choose where MeghXL saves downloads")
                    .pick_folder(move |chosen| {
                        if let Some(dir) = chosen.and_then(|f| f.into_path().ok()) {
                            set_download_dir(&app, &dir);
                        }
                    });
            }
            "autostart" => {
                let mgr = app.autolaunch();
                let enabled = mgr.is_enabled().unwrap_or(false);
                let _ = if enabled { mgr.disable() } else { mgr.enable() };
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;

    Ok(())
}

// ---------------------------------------------------------------------------

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .setup(|app| {
            let handle = app.handle().clone();
            match start_server(&handle) {
                Ok((port, child)) => {
                    app.manage(Server {
                        child: Mutex::new(child),
                    });
                    app.manage(Downloads(Mutex::new(None)));
                    create_main_window(&handle, port)?;
                    build_tray(&handle, port)?;
                    show_dashboard_when_ready(handle, port);
                }
                Err(message) => {
                    // Keep the window up so the user sees why, instead of a
                    // silent no-op launch.
                    let escaped = message.replace('\\', "\\\\").replace('\'', "\\'");
                    let win = create_main_window(&handle, DEFAULT_PORT)?;
                    std::thread::spawn(move || {
                        std::thread::sleep(Duration::from_millis(900));
                        let _ = win.eval(format!(
                            "window.__meghxlFailed && window.__meghxlFailed('{escaped}')"
                        ));
                    });
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window parks MeghXL in the tray — the server keeps
            // serving the other devices on the network. Quit from the tray.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to start MeghXL")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                if let Some(server) = app.try_state::<Server>() {
                    if let Some(child) = server.child.lock().unwrap().take() {
                        let _ = child.kill();
                    }
                }
            }
        });
}
