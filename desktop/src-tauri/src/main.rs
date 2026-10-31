// MeghXL desktop shell.
//
// The app is a thin native wrapper: it starts the MeghXL server as a bundled
// sidecar binary, waits for it to listen, and points the window at the
// dashboard it serves. A tray icon keeps it reachable once the window is
// closed. All of the product lives in the server + dashboard; nothing here
// duplicates it.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod awake;
mod host_link;

use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream, UdpSocket};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::menu::{
    AboutMetadata, CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, Submenu,
};
use tauri::tray::TrayIconBuilder;
use tauri::webview::{DownloadEvent, NewWindowResponse, WebviewWindow, WebviewWindowBuilder};
use tauri::WebviewUrl;
use tauri::{Manager, RunEvent, WindowEvent};
use tauri_plugin_autostart::ManagerExt as AutostartExt;
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;
use tauri_plugin_updater::UpdaterExt;

use host_link::{Check, Paired, Role};

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

/// The destinations we assigned to downloads in flight, keyed by download URL
/// (the one value both `Requested` and `Finished` carry). macOS never reports
/// the saved path back on `Finished`, so we keep our own copy. Each URL holds a
/// queue because the same file can be fetched twice before the first finishes.
#[derive(Default)]
struct Downloads(Mutex<HashMap<String, Vec<PathBuf>>>);

impl Downloads {
    fn insert(&self, url: &str, path: PathBuf) {
        self.0.lock().unwrap().entry(url.to_owned()).or_default().push(path);
    }

    /// Claim the destination recorded for `url`: the one matching the path the
    /// platform reported, if any, else the oldest.
    fn take(&self, url: &str, reported: Option<&Path>) -> Option<PathBuf> {
        let mut map = self.0.lock().unwrap();
        let queue = map.get_mut(url)?;
        let i = reported
            .and_then(|r| queue.iter().position(|p| p == r))
            .unwrap_or(0);
        let path = queue.remove(i);
        if queue.is_empty() {
            map.remove(url);
        }
        Some(path)
    }
}

/// The port the server ended up on, so menu handlers can build URLs.
struct AppPort(u16);

/// Where the dashboard lives: this computer's own server when it is the
/// host, the paired host otherwise. Changes if the host's address does.
struct Base(Mutex<String>);

/// Whether this computer is the host (a host shows the console; a client
/// can forget its host).
struct IsHost(bool);

fn base(app: &tauri::AppHandle) -> String {
    app.try_state::<Base>()
        .map(|b| b.0.lock().unwrap().clone())
        .unwrap_or_else(|| format!("http://127.0.0.1:{DEFAULT_PORT}"))
}

/// The app's own bundled pages (setup, waiting, warnings).
fn local_page() -> &'static str {
    if cfg!(windows) { "http://tauri.localhost/index.html" } else { "tauri://localhost/index.html" }
}

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

/// Tag a received file as downloaded from elsewhere, so the OS runs its usual
/// checks (Gatekeeper, SmartScreen, Office Protected View) before it can be
/// opened. Files come from other devices on the network and may be programs in
/// disguise; MeghXL never opens them, but without this mark the OS would trust
/// them like a file the user made. Best effort: a failure here must not turn a
/// finished transfer into an error.
#[cfg(target_os = "macos")]
fn mark_downloaded(path: &Path, _url: &str) {
    const ATTR: &str = "com.apple.quarantine";
    // WebKit's networking process may already have quarantined the file,
    // possibly with stricter flags. Never replace an existing mark.
    if matches!(xattr::get(path, ATTR), Ok(Some(_))) {
        return;
    }
    // flags;time;agent;event-uuid. 0083 is what Safari writes for downloads.
    // An empty UUID only means there is no entry in the Launch Services
    // quarantine history; Gatekeeper still checks the file.
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let _ = xattr::set(path, ATTR, format!("0083;{secs:x};MeghXL;").as_bytes());
}

#[cfg(windows)]
fn mark_downloaded(path: &Path, url: &str) {
    let mut stream = path.as_os_str().to_owned();
    stream.push(":Zone.Identifier");
    let stream = PathBuf::from(stream);
    // WebView2 may have written its own zone. Keep it if it is already
    // Internet (3) or Restricted (4); never downgrade.
    if let Ok(existing) = fs::read_to_string(&stream) {
        let zone = existing
            .lines()
            .find_map(|l| l.trim().strip_prefix("ZoneId="))
            .and_then(|z| z.trim().parse::<u8>().ok());
        if zone.is_some_and(|z| z >= 3) {
            return;
        }
    }
    // ZoneId=3 (Internet) on purpose: the sender is a LAN address, which
    // Windows could otherwise class as Intranet and skip SmartScreen and
    // Protected View for.
    let origin = tauri::Url::parse(url)
        .map(|u| u.origin().ascii_serialization())
        .unwrap_or_default();
    let body = format!("[ZoneTransfer]\r\nZoneId=3\r\nReferrerUrl={origin}\r\nHostUrl={url}\r\n");
    // Fails on FAT/exFAT, which have no alternate data streams. Nothing to do.
    let _ = fs::write(&stream, body);
}

/// Linux has no OS-enforced equivalent that file managers honour.
#[cfg(not(any(target_os = "macos", windows)))]
fn mark_downloaded(_path: &Path, _url: &str) {}

/// The dashboard asks for the built-in updater by navigating here.
const UPDATE_PATH: &str = "/desktop/check-updates";

/// The dashboard window. Files are always written to disk — this window never
/// renders a transferred file, whatever its type.
fn create_main_window(app: &tauri::AppHandle) -> tauri::Result<WebviewWindow> {
    let dl = app.clone();
    let nav = app.clone();
    let popup = app.clone();
    let origin = app.clone();
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
                DownloadEvent::Requested { url, destination } => {
                    let name = destination
                        .file_name()
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_else(|| "download".into());
                    let dir = download_dir(&dl);
                    let _ = fs::create_dir_all(&dir);
                    let target = unique_path(&dir, &name);
                    if let Some(state) = dl.try_state::<Downloads>() {
                        state.insert(url.as_str(), target.clone());
                    }
                    *destination = target;
                }
                DownloadEvent::Finished { url, path, success } => {
                    // Always claim our entry so the map doesn't grow. Windows
                    // and Linux report the real path; macOS never does, so
                    // there we rely on the entry alone.
                    let assigned = dl
                        .try_state::<Downloads>()
                        .and_then(|s| s.take(url.as_str(), path.as_deref()));
                    let saved = path.or(assigned);
                    // With no path and no entry we don't know which file this
                    // was, so nothing is marked. Even a failed transfer may
                    // leave a partial file behind; mark that too.
                    if let Some(p) = saved.as_deref().filter(|p| p.is_file()) {
                        mark_downloaded(p, url.as_str());
                    }
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
        // Tells the dashboard it runs inside the app, so About can offer the
        // built-in updater instead of a download link.
        .initialization_script("window.__MEGHXL_DESKTOP__ = { updater: true };")
        // Keep this window on the dashboard; send anything else to the browser.
        .on_navigation(move |url| {
            // The app's own pages, and the dashboard's origin — nothing else.
            let home: Option<tauri::Url> = base(&origin).parse().ok();
            let same_origin = home.is_some_and(|h| {
                h.scheme() == url.scheme() && h.host_str() == url.host_str() && h.port_or_known_default() == url.port_or_known_default()
            });
            // About's "Check for updates" — the same flow as the menu item.
            // Installing still needs the user's yes and a signed package.
            if same_origin && url.path() == UPDATE_PATH {
                check_for_updates(&nav);
                return false;
            }
            let allowed = matches!(url.scheme(), "tauri" | "asset")
                || url.host_str() == Some("tauri.localhost")
                || same_origin;
            if !allowed {
                let _ = nav.opener().open_url(url.to_string(), None::<&str>);
            }
            allowed
        })
        // target="_blank" links (GitHub, the update download) ask for a new
        // window, which on_navigation never sees; without this they do nothing.
        .on_new_window(move |url, _features| {
            if matches!(url.scheme(), "http" | "https") {
                let _ = popup.opener().open_url(url.to_string(), None::<&str>);
            }
            NewWindowResponse::Deny
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

    let shown = app.clone();
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
                CommandEvent::Stderr(line) => {
                    let text = String::from_utf8_lossy(&line);
                    eprint!("{text}");
                    // The server explains startup failures in plain words on a
                    // line starting MEGHXL-FATAL: — show that, not a timeout.
                    if let Some(msg) = text.split("MEGHXL-FATAL:").nth(1) {
                        show_local(&shown, format!(
                            "window.__meghxlFailed && window.__meghxlFailed({})",
                            js_str(msg.trim())
                        ));
                    }
                }
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
                // After a planned move this computer's server is retired: become
                // a client of the new host — but only if it proves our old key.
                if let Some(moved_to) = host_link::local_retired(port) {
                    return follow_moved_host(&app, port, moved_to);
                }
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

/// Run one of the bundled page's functions (`__meghxlWaiting(...)` etc.),
/// loading the bundled page first if the window is showing something else.
fn show_local(app: &tauri::AppHandle, script: String) {
    let Some(win) = app.get_webview_window("main") else { return };
    let on_local = win
        .url()
        .map(|u| u.scheme() == "tauri" || u.host_str() == Some("tauri.localhost"))
        .unwrap_or(false);
    if !on_local {
        if let Ok(url) = local_page().parse() {
            let _ = win.navigate(url);
        }
        std::thread::sleep(Duration::from_millis(900));
    }
    let _ = win.eval(script);
}

fn js_str(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into())
}

/// This computer handed the host role on. Pair with the new host, provided
/// it proves it holds the key this computer used to have.
fn follow_moved_host(app: &tauri::AppHandle, port: u16, moved_to: Option<String>) {
    let key = host_link::local_public_key(port);
    if let (Some(to), Some(key)) = (moved_to.clone(), key) {
        if let Ok(to) = host_link::normalize(&to) {
            if let Check::Verified(id) = host_link::verify(&to, Some(&key)) {
                let paired = Paired { host: to, public_key: key, fingerprint: id.fingerprint, name: id.name };
                if host_link::save_role(app, &Role::Client(paired)).is_ok() {
                    app.restart();
                }
            }
        }
    }
    let to = moved_to.unwrap_or_default();
    show_local(app, format!("window.__meghxlMoved && window.__meghxlMoved({})", js_str(&to)));
}

// ---------------------------------------------------------------------------
// Client mode: this computer uses the host's dashboard
// ---------------------------------------------------------------------------

/// Find the paired host, check it is really the host, and keep checking.
/// Shows "waiting" while it's away and a warning if anything else answers in
/// its place. Never starts a server here, whatever happens.
fn watch_host(app: tauri::AppHandle, mut paired: Paired) {
    std::thread::spawn(move || {
        let mut showing_dashboard = false;
        loop {
            let (check, from) = host_link::find_paired(&paired);
            let pause = match check {
                Check::Verified(_) => {
                    if from != paired.host {
                        // The host's address changed; it proved the key, so follow it.
                        paired.host = from.clone();
                        let _ = host_link::save_role(&app, &Role::Client(paired.clone()));
                        if let Some(b) = app.try_state::<Base>() {
                            *b.0.lock().unwrap() = from.clone();
                        }
                        showing_dashboard = false;
                    }
                    if !showing_dashboard {
                        if let (Some(win), Ok(url)) = (app.get_webview_window("main"), format!("{from}/").parse()) {
                            let _ = win.navigate(url);
                        }
                        showing_dashboard = true;
                    }
                    60
                }
                Check::WrongKey(fingerprint) => {
                    showing_dashboard = false;
                    show_local(&app, format!(
                        "window.__meghxlImpostor && window.__meghxlImpostor({}, {}, {})",
                        js_str(&from), js_str(&paired.fingerprint), js_str(&fingerprint)
                    ));
                    15
                }
                Check::Moved(to) => {
                    showing_dashboard = false;
                    show_local(&app, format!("window.__meghxlMoved && window.__meghxlMoved({})", js_str(&to.unwrap_or_default())));
                    30
                }
                Check::Unreachable(_) => {
                    // Once the dashboard is up it shows its own "host offline"
                    // banner and reconnects by itself.
                    if !showing_dashboard {
                        let name = paired.name.clone().unwrap_or_else(|| paired.host.clone());
                        show_local(&app, format!("window.__meghxlWaiting && window.__meghxlWaiting({})", js_str(&name)));
                    }
                    if showing_dashboard { 30 } else { 5 }
                }
            };
            std::thread::sleep(Duration::from_secs(pause));
        }
    });
}

// ---------------------------------------------------------------------------
// First launch: choose the host, on purpose
// ---------------------------------------------------------------------------

/// Commands answer only the app's own bundled page — never a dashboard
/// loaded from the network, even if that page somehow reached the bridge.
fn from_local_page(webview: &tauri::Webview) -> Result<(), String> {
    let ok = webview
        .url()
        .map(|u| u.scheme() == "tauri" || u.host_str() == Some("tauri.localhost"))
        .unwrap_or(false);
    if ok { Ok(()) } else { Err("not allowed".into()) }
}

#[tauri::command]
fn choose_host(app: tauri::AppHandle, webview: tauri::Webview) -> Result<(), String> {
    from_local_page(&webview)?;
    host_link::save_role(&app, &Role::Host)?;
    app.restart();
}

/// Look for a host at `address` and make it prove it holds a key. Returns
/// what to show the person, who compares the fingerprint with the host
/// console before pairing.
#[tauri::command]
fn find_host(webview: tauri::Webview, address: String) -> Result<serde_json::Value, String> {
    from_local_page(&webview)?;
    let base = host_link::normalize(&address)?;
    match host_link::verify(&base, None) {
        Check::Verified(id) => Ok(serde_json::json!({
            "address": base, "publicKey": id.public_key, "fingerprint": id.fingerprint, "name": id.name,
        })),
        Check::WrongKey(_) => Err("Something answered there, but it couldn't prove it is a MeghXL host.".into()),
        Check::Moved(to) => Err(format!("That computer is no longer the host{}.", to.map(|t| format!(" — it moved to {t}")).unwrap_or_default())),
        Check::Unreachable(e) => Err(e),
    }
}

#[tauri::command]
fn pair_host(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    address: String,
    public_key: String,
) -> Result<(), String> {
    from_local_page(&webview)?;
    let base = host_link::normalize(&address)?;
    // Check again with the key the person just accepted.
    let Check::Verified(id) = host_link::verify(&base, Some(&public_key)) else {
        return Err("The host didn't answer the same way twice. Try again.".into());
    };
    host_link::save_role(&app, &Role::Client(Paired {
        host: base, public_key, fingerprint: id.fingerprint, name: id.name,
    }))?;
    app.restart();
}

/// Ask, then forget the paired host and start over. Only from this computer's
/// own menu — the network can never unpair it.
fn forget_host(app: &tauri::AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let yes = app
            .dialog()
            .message("Forget this host? MeghXL will ask again which computer is the host. Do this only if the host was replaced and its recovery key is lost.")
            .title("Forget host")
            .buttons(tauri_plugin_dialog::MessageDialogButtons::OkCancelCustom("Forget".into(), "Cancel".into()))
            .blocking_show();
        if yes {
            host_link::forget(&app);
            app.restart();
        }
    });
}

/// Which role to start in. An existing install that already holds data — or a
/// MeghXL server already running here — has been the host all along.
fn initial_role(app: &tauri::AppHandle) -> Option<Role> {
    if let Some(role) = host_link::load_role(app) {
        return Some(role);
    }
    let has_data = app
        .path()
        .app_data_dir()
        .map(|d| d.join("metadata.json").is_file())
        .unwrap_or(false);
    if has_data || is_meghxl(DEFAULT_PORT) {
        let _ = host_link::save_role(app, &Role::Host);
        return Some(Role::Host);
    }
    None
}

// ---------------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------------

/// Check GitHub for a signed release, show the changelog, and — if the user
/// agrees — download and install it in the background.
///
/// Only ever runs when the user picks "Check for updates…". Nothing is checked
/// on a timer or at launch, so the app still makes no unsolicited network
/// request. Updates are verified against the public key baked into the bundle,
/// so an unsigned or tampered package is refused.
fn check_for_updates(app: &tauri::AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let notify = |title: &str, body: String| {
            let _ = app.notification().builder().title(title).body(body).show();
        };

        let updater = match app.updater() {
            Ok(u) => u,
            Err(e) => return notify("MeghXL", format!("Update check unavailable: {e}")),
        };

        match updater.check().await {
            Ok(Some(update)) => {
                let notes = update.body.clone().unwrap_or_default();
                let version = update.version.clone();
                let current = update.current_version.clone();
                let prompt = if notes.trim().is_empty() {
                    format!("MeghXL {version} is available. You have {current}.\n\nDownload and install it now?")
                } else {
                    format!(
                        "MeghXL {version} is available. You have {current}.\n\nWhat's new:\n{}\n\nDownload and install it now?",
                        notes.chars().take(1200).collect::<String>()
                    )
                };

                let answer = app
                    .dialog()
                    .message(prompt)
                    .title("Update available")
                    .buttons(tauri_plugin_dialog::MessageDialogButtons::OkCancelCustom(
                        "Install".into(),
                        "Not now".into(),
                    ))
                    .blocking_show();
                if !answer {
                    return;
                }

                notify("MeghXL", format!("Downloading version {version}…"));
                match update.download_and_install(|_, _| {}, || {}).await {
                    Ok(()) => {
                        let restart = app
                            .dialog()
                            .message("MeghXL has been updated. Restart now to use the new version?")
                            .title("Update installed")
                            .buttons(tauri_plugin_dialog::MessageDialogButtons::OkCancelCustom(
                                "Restart".into(),
                                "Later".into(),
                            ))
                            .blocking_show();
                        if restart {
                            app.restart();
                        }
                    }
                    Err(e) => notify("MeghXL", format!("Update failed: {e}")),
                }
            }
            Ok(None) => notify("MeghXL", "You're running the latest version.".into()),
            Err(e) => notify("MeghXL", format!("Could not check for updates: {e}")),
        }
    });
}

// ---------------------------------------------------------------------------
// Menus
// ---------------------------------------------------------------------------

const REPO: &str = "https://github.com/riponcm/MeghXL";

/// Bring the window forward on `path` of the dashboard.
fn show_at(app: &tauri::AppHandle, path: &str) {
    if let Some(win) = app.get_webview_window("main") {
        if let Ok(url) = format!("{}{path}", base(app)).parse() {
            let _ = win.navigate(url);
        }
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

/// Every menu action, in one place. The tray and the macOS menu bar both
/// dispatch here, so the two can never drift apart.
fn menu_action(app: &tauri::AppHandle, id: &str) {
    match id {
        "open" => show_at(app, "/"),
        "console" => show_at(app, "/admin"),
        "about" => show_at(app, "/#about"),
        "nav-dashboard" => show_at(app, "/#dashboard"),
        "nav-send" => show_at(app, "/#send"),
        "nav-private" => show_at(app, "/#private"),
        "nav-devices" => show_at(app, "/#devices"),
        "reload" => {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.eval("location.reload()");
            }
        }
        "forget" => forget_host(app),
        "keep-awake" => {
            let on = !awake::wanted(app);
            awake::remember(app, on);
            awake::set(on);
        }
        "copy" => {
            let link = if app.try_state::<IsHost>().map_or(true, |h| h.0) {
                let port = app.try_state::<AppPort>().map(|p| p.0).unwrap_or(DEFAULT_PORT);
                let host = lan_ip().unwrap_or_else(|| "127.0.0.1".into());
                format!("http://{host}:{port}/")
            } else {
                format!("{}/", base(app))
            };
            let _ = app.clipboard().write_text(link);
            let _ = app
                .notification()
                .builder()
                .title("MeghXL")
                .body("Network link copied")
                .show();
        }
        "updates" => check_for_updates(app),
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
        "help-github" => { let _ = app.opener().open_url(REPO, None::<&str>); }
        "help-issue" => { let _ = app.opener().open_url(format!("{REPO}/issues/new"), None::<&str>); }
        "help-security" => { let _ = app.opener().open_url(format!("{REPO}/blob/main/SECURITY.md"), None::<&str>); }
        "help-releases" => { let _ = app.opener().open_url(format!("{REPO}/releases"), None::<&str>); }
        "quit" => app.exit(0),
        _ => {}
    }
}

fn about_metadata() -> AboutMetadata<'static> {
    AboutMetadata {
        name: Some("MeghXL".into()),
        version: Some(env!("CARGO_PKG_VERSION").into()),
        copyright: Some("Copyright © 2026 Matily".into()),
        authors: Some(vec!["Matily".into()]),
        license: Some("Apache-2.0".into()),
        website: Some("https://matily.org".into()),
        website_label: Some("matily.org".into()),
        comments: Some("Transfer anything across your local network.".into()),
        ..Default::default()
    }
}

/// The macOS menu bar. Without one, the app shows Tao's bare default; more
/// importantly, the Edit menu is what makes Cmd-C/V work inside the webview.
fn build_app_menu(app: &tauri::AppHandle, is_host: bool) -> tauri::Result<()> {
    let sep = || PredefinedMenuItem::separator(app);
    // The host has a console; a client has a host it can forget.
    let role_item = if is_host {
        MenuItemBuilder::with_id("console", "Host Console").build(app)?
    } else {
        MenuItemBuilder::with_id("forget", "Forget This Host…").build(app)?
    };
    let awake_item = CheckMenuItemBuilder::with_id("keep-awake", "Keep Computer Awake While Hosting")
        .checked(is_host && awake::wanted(app))
        .enabled(is_host)
        .build(app)?;

    let app_menu = Submenu::with_items(app, "MeghXL", true, &[
        &PredefinedMenuItem::about(app, Some("About MeghXL"), Some(about_metadata()))?,
        &MenuItemBuilder::with_id("updates", "Check for Updates…").build(app)?,
        &sep()?,
        &MenuItemBuilder::with_id("downloads-set", "Downloads Folder…").build(app)?,
        &CheckMenuItemBuilder::with_id("autostart", "Start at Login")
            .checked(app.autolaunch().is_enabled().unwrap_or(false))
            .build(app)?,
        &awake_item,
        &sep()?,
        &PredefinedMenuItem::services(app, None)?,
        &sep()?,
        &PredefinedMenuItem::hide(app, None)?,
        &PredefinedMenuItem::hide_others(app, None)?,
        &PredefinedMenuItem::show_all(app, None)?,
        &sep()?,
        &PredefinedMenuItem::quit(app, Some("Quit MeghXL"))?,
    ])?;

    let file_menu = Submenu::with_items(app, "File", true, &[
        &MenuItemBuilder::with_id("copy", "Copy Network Link").build(app)?,
        &MenuItemBuilder::with_id("downloads", "Open Downloads Folder").build(app)?,
        &sep()?,
        &PredefinedMenuItem::close_window(app, None)?,
    ])?;

    let edit_menu = Submenu::with_items(app, "Edit", true, &[
        &PredefinedMenuItem::undo(app, None)?,
        &PredefinedMenuItem::redo(app, None)?,
        &sep()?,
        &PredefinedMenuItem::cut(app, None)?,
        &PredefinedMenuItem::copy(app, None)?,
        &PredefinedMenuItem::paste(app, None)?,
        &PredefinedMenuItem::select_all(app, None)?,
    ])?;

    let view_menu = Submenu::with_items(app, "View", true, &[
        &MenuItemBuilder::with_id("nav-dashboard", "Dashboard").build(app)?,
        &MenuItemBuilder::with_id("nav-send", "Send").build(app)?,
        &MenuItemBuilder::with_id("nav-private", "Private").build(app)?,
        &MenuItemBuilder::with_id("nav-devices", "Devices").build(app)?,
        &MenuItemBuilder::with_id("about", "About").build(app)?,
        &sep()?,
        &role_item,
        &sep()?,
        &MenuItemBuilder::with_id("reload", "Reload").build(app)?,
        &PredefinedMenuItem::fullscreen(app, None)?,
    ])?;

    let window_menu = Submenu::with_items(app, "Window", true, &[
        &PredefinedMenuItem::minimize(app, None)?,
        &PredefinedMenuItem::maximize(app, None)?,
        &sep()?,
        &PredefinedMenuItem::bring_all_to_front(app, None)?,
    ])?;

    let help_menu = Submenu::with_items(app, "Help", true, &[
        &MenuItemBuilder::with_id("help-github", "MeghXL on GitHub").build(app)?,
        &MenuItemBuilder::with_id("help-releases", "Release Notes").build(app)?,
        &MenuItemBuilder::with_id("help-security", "Security Policy").build(app)?,
        &sep()?,
        &MenuItemBuilder::with_id("help-issue", "Report an Issue").build(app)?,
    ])?;

    let menu = MenuBuilder::new(app)
        .items(&[&app_menu, &file_menu, &edit_menu, &view_menu, &window_menu, &help_menu])
        .build()?;
    app.set_menu(menu)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------

fn build_tray(app: &tauri::AppHandle, is_host: bool) -> tauri::Result<()> {
    let sep = || PredefinedMenuItem::separator(app);
    let role_item = if is_host {
        MenuItemBuilder::with_id("console", "Host console").build(app)?
    } else {
        MenuItemBuilder::with_id("forget", "Forget this host…").build(app)?
    };
    let awake_item = CheckMenuItemBuilder::with_id("keep-awake", "Keep computer awake")
        .checked(is_host && awake::wanted(app))
        .enabled(is_host)
        .build(app)?;
    let menu = MenuBuilder::new(app)
        .items(&[
            &MenuItemBuilder::with_id("open", "Open MeghXL").build(app)?,
            &role_item,
            &MenuItemBuilder::with_id("copy", "Copy network link").build(app)?,
            &sep()?,
            &MenuItemBuilder::with_id("downloads", "Open downloads folder").build(app)?,
            &MenuItemBuilder::with_id("downloads-set", "Change downloads folder…").build(app)?,
            &sep()?,
            &MenuItemBuilder::with_id("about", "About MeghXL").build(app)?,
            &MenuItemBuilder::with_id("updates", "Check for updates…").build(app)?,
            &sep()?,
            &CheckMenuItemBuilder::with_id("autostart", "Start at login")
                .checked(app.autolaunch().is_enabled().unwrap_or(false))
                .build(app)?,
            &awake_item,
            &sep()?,
            &MenuItemBuilder::with_id("quit", "Quit MeghXL").build(app)?,
        ])
        .build()?;

    TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().unwrap().clone())
        .tooltip("MeghXL — local network file transfer")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| menu_action(app, event.id().as_ref()))
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
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .on_menu_event(|app, event| menu_action(app, event.id().as_ref()))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .invoke_handler(tauri::generate_handler![choose_host, find_host, pair_host])
        .setup(|app| {
            let handle = app.handle().clone();
            app.manage(Downloads::default());
            match initial_role(&handle) {
                // A client never starts a server: it shows the host's dashboard,
                // once the host proves who it is.
                Some(Role::Client(paired)) => {
                    app.manage(Server { child: Mutex::new(None) });
                    app.manage(Base(Mutex::new(paired.host.clone())));
                    app.manage(IsHost(false));
                    create_main_window(&handle)?;
                    build_app_menu(&handle, false)?;
                    build_tray(&handle, false)?;
                    watch_host(handle, paired);
                }
                // First launch: the person chooses. Nothing is served until then.
                None => {
                    app.manage(Server { child: Mutex::new(None) });
                    app.manage(Base(Mutex::new(String::new())));
                    app.manage(IsHost(false));
                    create_main_window(&handle)?;
                    build_app_menu(&handle, false)?;
                    std::thread::spawn(move || {
                        std::thread::sleep(Duration::from_millis(900));
                        if let Some(win) = handle.get_webview_window("main") {
                            let _ = win.eval("window.__meghxlSetup && window.__meghxlSetup()");
                        }
                    });
                }
                Some(Role::Host) => match start_server(&handle) {
                    Ok((port, child)) => {
                        app.manage(Server {
                            child: Mutex::new(child),
                        });
                        app.manage(AppPort(port));
                        app.manage(Base(Mutex::new(format!("http://127.0.0.1:{port}"))));
                        app.manage(IsHost(true));
                        create_main_window(&handle)?;
                        build_app_menu(&handle, true)?;
                        build_tray(&handle, true)?;
                        if awake::wanted(&handle) {
                            awake::set(true);
                        }
                        show_dashboard_when_ready(handle, port);
                    }
                    Err(message) => {
                        // Keep the window up so the user sees why, instead of a
                        // silent no-op launch.
                        app.manage(Server { child: Mutex::new(None) });
                        app.manage(Base(Mutex::new(format!("http://127.0.0.1:{DEFAULT_PORT}"))));
                        app.manage(IsHost(true));
                        let win = create_main_window(&handle)?;
                        std::thread::spawn(move || {
                            std::thread::sleep(Duration::from_millis(900));
                            let _ = win.eval(format!(
                                "window.__meghxlFailed && window.__meghxlFailed({})",
                                js_str(&message)
                            ));
                        });
                    }
                },
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
