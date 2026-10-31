// Which computer is the MeghXL host — and making sure it really is.
//
// MeghXL has one host. The first time the app opens on a computer, the person
// at it chooses: this computer is the host, or it joins the host. A joining
// app remembers the host's public key (shown as a fingerprint to compare with
// the host console), and from then on makes the host sign a fresh challenge
// before trusting it. Another machine answering as "meghxl.local" — or one
// that knocked the host offline and took its address — can't sign, so the app
// refuses it. Nothing here ever makes this computer a host on its own.
//
// The pairing lives in role.json in the app's data folder. Only a person at
// this computer can change it ("Forget this host"), never the network.

use std::fs;
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::PathBuf;
use std::time::Duration;

use base64::Engine;
use ring::rand::{SecureRandom, SystemRandom};
use ring::signature::{UnparsedPublicKey, ED25519};
use serde_json::{json, Value};
use tauri::Manager;

/// Must match PROOF_CONTEXT in src/host-identity.js.
const PROOF_CONTEXT: &str = "meghxl-host-proof-v1\n";
const DEFAULT_PORT: u16 = 3000;

#[derive(Clone, Debug)]
pub struct Paired {
    /// "http://192.168.1.20:3000" — where the host was last found.
    pub host: String,
    /// The host's Ed25519 public key, base64. This is the trust anchor.
    pub public_key: String,
    pub fingerprint: String,
    /// The host's friendly name ("meghxl.local"), tried when its address changes.
    pub name: Option<String>,
}

#[derive(Clone, Debug)]
pub enum Role {
    Host,
    Client(Paired),
}

fn role_file(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("role.json"))
}

pub fn load_role(app: &tauri::AppHandle) -> Option<Role> {
    let text = fs::read_to_string(role_file(app)?).ok()?;
    let v: Value = serde_json::from_str(&text).ok()?;
    match v.get("role")?.as_str()? {
        "host" => Some(Role::Host),
        "client" => Some(Role::Client(Paired {
            host: v.get("host")?.as_str()?.to_string(),
            public_key: v.get("publicKey")?.as_str()?.to_string(),
            fingerprint: v.get("fingerprint")?.as_str()?.to_string(),
            name: v.get("name").and_then(|n| n.as_str()).map(String::from),
        })),
        _ => None,
    }
}

pub fn save_role(app: &tauri::AppHandle, role: &Role) -> Result<(), String> {
    let file = role_file(app).ok_or("no app data folder")?;
    if let Some(dir) = file.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let v = match role {
        Role::Host => json!({ "role": "host" }),
        Role::Client(p) => json!({
            "role": "client", "host": p.host, "publicKey": p.public_key,
            "fingerprint": p.fingerprint, "name": p.name,
        }),
    };
    fs::write(&file, serde_json::to_vec_pretty(&v).unwrap_or_default()).map_err(|e| e.to_string())
}

/// Forget the host. Only ever called from this computer's own menu.
pub fn forget(app: &tauri::AppHandle) {
    if let Some(file) = role_file(app) {
        let _ = fs::remove_file(file);
    }
}

// ---------------------------------------------------------------------------
// Talking to a host (plain HTTP on the LAN — the trust comes from the key)
// ---------------------------------------------------------------------------

/// "meghxl.local", "192.168.1.20:3000", "http://…" → "http://host:port".
pub fn normalize(address: &str) -> Result<String, String> {
    let a = address.trim().trim_end_matches('/');
    let rest = a.strip_prefix("http://").unwrap_or(a);
    if rest.is_empty() || rest.contains('/') || rest.contains(char::is_whitespace) || a.starts_with("https://") {
        return Err("Enter the host's address, like 192.168.1.20:3000 or meghxl.local".into());
    }
    let with_port = if rest.rsplit_once(':').is_some_and(|(_, p)| p.parse::<u16>().is_ok()) {
        rest.to_string()
    } else {
        format!("{rest}:{DEFAULT_PORT}")
    };
    Ok(format!("http://{with_port}"))
}

/// A small HTTP/1.0 request; returns (status, body).
fn request(base: &str, method: &str, path: &str, body: Option<&Value>) -> Result<(u16, String), String> {
    let authority = base.strip_prefix("http://").ok_or("bad address")?;
    let addr = authority
        .to_socket_addrs()
        .map_err(|_| format!("Can't find {authority} on this network"))?
        .next()
        .ok_or_else(|| format!("Can't find {authority} on this network"))?;
    let mut sock = TcpStream::connect_timeout(&addr, Duration::from_secs(3))
        .map_err(|_| format!("No answer from {authority}"))?;
    let _ = sock.set_read_timeout(Some(Duration::from_secs(6)));
    let payload = body.map(|b| b.to_string()).unwrap_or_default();
    let mut req = format!("{method} {path} HTTP/1.0\r\nHost: {authority}\r\nConnection: close\r\n");
    if body.is_some() {
        req.push_str(&format!("Content-Type: application/json\r\nContent-Length: {}\r\n", payload.len()));
    }
    req.push_str("\r\n");
    req.push_str(&payload);
    sock.write_all(req.as_bytes()).map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    sock.take(1024 * 1024).read_to_end(&mut buf).map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&buf);
    let (head, body) = text.split_once("\r\n\r\n").ok_or("bad response")?;
    let status = head.split_whitespace().nth(1).and_then(|s| s.parse().ok()).ok_or("bad response")?;
    Ok((status, body.to_string()))
}

fn get_json(base: &str, path: &str) -> Result<Value, String> {
    let (_, body) = request(base, "GET", path, None)?;
    serde_json::from_str(&body).map_err(|_| "That address doesn't answer like MeghXL.".into())
}

#[derive(Clone, Debug)]
pub struct Identity {
    pub public_key: String,
    pub fingerprint: String,
    pub name: Option<String>,
    pub moved_to: Option<String>,
    pub retired: bool,
}

pub fn identity(base: &str) -> Result<Identity, String> {
    let v = get_json(base, "/api/host/identity")?;
    let retired = v.get("retired").is_some_and(|r| !r.is_null());
    Ok(Identity {
        public_key: v.get("publicKey").and_then(|s| s.as_str()).ok_or("That address doesn't answer like a MeghXL host.")?.into(),
        fingerprint: v.get("fingerprint").and_then(|s| s.as_str()).unwrap_or("").into(),
        name: v.get("name").and_then(|s| s.as_str()).map(String::from),
        moved_to: v.pointer("/retired/movedTo").and_then(|s| s.as_str()).map(String::from),
        retired,
    })
}

pub enum Check {
    /// The host answered and signed our challenge with the expected key.
    Verified(Identity),
    /// Something answered, but not with the host's key: an impostor, or a
    /// different MeghXL. Never trust it.
    WrongKey(String),
    /// The host handed its role to another computer.
    Moved(Option<String>),
    /// Nobody answered.
    Unreachable(String),
}

/// Ask `base` to prove it holds the key. With `expected`, it must be that key;
/// without (first pairing), any key it can prove it holds.
pub fn verify(base: &str, expected: Option<&str>) -> Check {
    let id = match identity(base) {
        Ok(id) => id,
        Err(e) => return Check::Unreachable(e),
    };
    if id.retired {
        return Check::Moved(id.moved_to);
    }
    if let Some(want) = expected {
        if want != id.public_key {
            return Check::WrongKey(id.fingerprint);
        }
    }
    let mut raw = [0u8; 24];
    if SystemRandom::new().fill(&mut raw).is_err() {
        return Check::Unreachable("no randomness".into());
    }
    let nonce = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(raw);
    let signature = match request(base, "POST", "/api/host/prove", Some(&json!({ "nonce": nonce }))) {
        Ok((200, body)) => serde_json::from_str::<Value>(&body)
            .ok()
            .and_then(|v| v.get("signature").and_then(|s| s.as_str()).map(String::from)),
        Ok((410, _)) => return Check::Moved(id.moved_to),
        Ok(_) => None,
        Err(e) => return Check::Unreachable(e),
    };
    let b64 = base64::engine::general_purpose::STANDARD;
    let (Some(sig), Ok(key)) = (signature.and_then(|s| b64.decode(s).ok()), b64.decode(&id.public_key)) else {
        return Check::WrongKey(id.fingerprint);
    };
    let message = format!("{PROOF_CONTEXT}{nonce}");
    match UnparsedPublicKey::new(&ED25519, key).verify(message.as_bytes(), &sig) {
        Ok(()) => Check::Verified(id),
        // It showed the right public key but couldn't sign: it copied the key.
        Err(_) => Check::WrongKey(id.fingerprint),
    }
}

/// Where a paired host can be found now: its last address, else its
/// friendly name (its address may have changed). Either way it must prove
/// the pinned key. Returns the check and the address it came from.
pub fn find_paired(p: &Paired) -> (Check, String) {
    let first = verify(&p.host, Some(&p.public_key));
    if !matches!(first, Check::Unreachable(_)) {
        return (first, p.host.clone());
    }
    if let Some(name) = &p.name {
        let port = p.host.rsplit_once(':').map(|(_, port)| port).unwrap_or("3000");
        let alt = format!("http://{name}:{port}");
        if alt != p.host {
            let second = verify(&alt, Some(&p.public_key));
            if matches!(second, Check::Verified(_)) {
                return (second, alt);
            }
        }
    }
    (first, p.host.clone())
}

/// The health check of the server on this computer: is it retired, and where to?
pub fn local_retired(port: u16) -> Option<Option<String>> {
    let v = get_json(&format!("http://127.0.0.1:{port}"), "/api/health").ok()?;
    if v.get("retired").and_then(|r| r.as_bool()) == Some(true) {
        Some(v.get("movedTo").and_then(|m| m.as_str()).map(String::from))
    } else {
        None
    }
}

/// This computer's own host key (a retired host still knows its public half).
pub fn local_public_key(port: u16) -> Option<String> {
    identity(&format!("http://127.0.0.1:{port}")).ok().map(|i| i.public_key)
}

#[cfg(test)]
mod tests {
    use super::{normalize, verify, Check};

    /// Against a real server: MEGHXL_TEST_HOST=http://127.0.0.1:PORT cargo test
    /// (skipped when unset).
    #[test]
    fn checks_a_live_host() {
        let Ok(base) = std::env::var("MEGHXL_TEST_HOST") else { return };
        let Check::Verified(id) = verify(&base, None) else { panic!("a real host proves its key") };
        assert!(matches!(verify(&base, Some(&id.public_key)), Check::Verified(_)), "and the pinned key");
        let other = "A".repeat(43) + "=";
        assert!(matches!(verify(&base, Some(&other)), Check::WrongKey(_)), "a different pinned key is refused");
        assert!(matches!(verify("http://127.0.0.1:1", None), Check::Unreachable(_)));
    }

    #[test]
    fn addresses_normalize() {
        assert_eq!(normalize("meghxl.local").unwrap(), "http://meghxl.local:3000");
        assert_eq!(normalize("192.168.1.20:3001").unwrap(), "http://192.168.1.20:3001");
        assert_eq!(normalize("http://10.0.0.5:3000/").unwrap(), "http://10.0.0.5:3000");
        assert!(normalize("https://x").is_err());
        assert!(normalize("a b").is_err());
        assert!(normalize("").is_err());
    }
}
