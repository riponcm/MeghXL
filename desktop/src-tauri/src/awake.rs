// Keep the host computer from going to sleep while it hosts.
//
// A sleeping host is a total outage: every phone and computer loses the board
// and every link stops working. So while this computer is the host, MeghXL
// asks the OS not to sleep when idle. The screen may still turn off, and
// closing a laptop's lid still sleeps it — this only stops idle sleep. The
// host can turn it off from the menu.
//
//   macOS:   caffeinate -i, tied to this process (it exits when we do)
//   Windows: SetThreadExecutionState(ES_SYSTEM_REQUIRED | ES_CONTINUOUS)
//   Linux:   systemd-inhibit --what=idle, with a watcher that ends with us

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use tauri::Manager;

#[cfg(not(windows))]
static CHILD: Mutex<Option<std::process::Child>> = Mutex::new(None);

fn setting_file(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("keep-awake.txt"))
}

/// On unless the host turned it off.
pub fn wanted(app: &tauri::AppHandle) -> bool {
    setting_file(app)
        .and_then(|f| fs::read_to_string(f).ok())
        .map_or(true, |s| s.trim() != "off")
}

pub fn remember(app: &tauri::AppHandle, on: bool) {
    if let Some(f) = setting_file(app) {
        if let Some(dir) = f.parent() {
            let _ = fs::create_dir_all(dir);
        }
        let _ = fs::write(f, if on { "on" } else { "off" });
    }
}

#[cfg(target_os = "macos")]
fn start() -> Option<std::process::Child> {
    std::process::Command::new("/usr/bin/caffeinate")
        .args(["-i", "-w", &std::process::id().to_string()])
        .spawn()
        .ok()
}

#[cfg(all(unix, not(target_os = "macos")))]
fn start() -> Option<std::process::Child> {
    // The watcher loop ends when MeghXL does, releasing the inhibitor even if
    // MeghXL is killed rather than quit.
    let watch = format!("while kill -0 {} 2>/dev/null; do sleep 30; done", std::process::id());
    std::process::Command::new("systemd-inhibit")
        .args(["--what=idle", "--who=MeghXL", "--why=Sharing files on the local network", "--mode=block", "sh", "-c", &watch])
        .spawn()
        .ok()
}

/// Ask the OS to stay awake (`true`) or let it sleep again (`false`).
#[cfg(not(windows))]
pub fn set(on: bool) {
    let mut child = CHILD.lock().unwrap();
    if let Some(mut c) = child.take() {
        let _ = c.kill();
        let _ = c.wait();
    }
    if on {
        *child = start();
    }
}

#[cfg(windows)]
pub fn set(on: bool) {
    use windows_sys::Win32::System::Power::{SetThreadExecutionState, ES_CONTINUOUS, ES_SYSTEM_REQUIRED};
    // Applies to the calling thread until changed; called from the main
    // thread, which lives as long as the app.
    unsafe {
        SetThreadExecutionState(if on { ES_CONTINUOUS | ES_SYSTEM_REQUIRED } else { ES_CONTINUOUS });
    }
}
