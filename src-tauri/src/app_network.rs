// SPDX-License-Identifier: MPL-2.0
//! App-scoped, user-configured HTTP endpoints. Credentials never cross into app frames.
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, LazyLock, Mutex,
    },
    time::Duration,
};
use tokio::sync::{watch, Mutex as AsyncMutex};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredProfile {
    endpoint: String,
    key: String,
    revision: String,
    remembered: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    endpoint: String,
    revision: String,
    has_key: bool,
    remembered: bool,
}
impl StoredProfile {
    fn public(&self) -> Profile {
        Profile {
            endpoint: self.endpoint.clone(),
            revision: self.revision.clone(),
            has_key: !self.key.is_empty(),
            remembered: self.remembered,
        }
    }
}
static PROFILES: LazyLock<Mutex<HashMap<String, StoredProfile>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
fn identity(app: &str, slot: &str) -> Result<String, String> {
    if app.len() > 200
        || !app.contains('.')
        || !app
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b".-".contains(&b))
        || slot.is_empty()
        || slot.len() > 64
        || !slot
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
    {
        return Err("Invalid app connection identity.".into());
    }
    Ok(format!("{app}/{slot}"))
}
fn endpoint(raw: &str) -> Result<String, String> {
    let url =
        reqwest::Url::parse(raw).map_err(|_| "Enter a complete HTTP or HTTPS endpoint URL.")?;
    if raw.len() > 2048
        || !matches!(url.scheme(), "https" | "http")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(
            "Use an HTTP(S) endpoint without embedded credentials, query or fragment.".into(),
        );
    }
    Ok(url.to_string())
}
fn load_profile(id: &str) -> Result<Option<StoredProfile>, String> {
    if let Some(profile) = PROFILES
        .lock()
        .map_err(|_| "Connection store unavailable.")?
        .get(id)
    {
        return Ok(Some(profile.clone()));
    }
    let entry = keyring::Entry::new("ShellCanvas.app-connections.v1", id)
        .map_err(|_| "System credential store unavailable.")?;
    match entry.get_password() {
        Ok(raw) => {
            let profile: StoredProfile = serde_json::from_str(&raw).map_err(|_| "Saved connection is invalid; configure it again.")?;
            endpoint(&profile.endpoint)?;
            Ok(Some(profile))
        },
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("Cannot read the system credential store. Unlock it or configure a session-only connection.".into()),
    }
}
#[tauri::command]
pub async fn app_network_profile(app: String, slot: String) -> Result<Option<Profile>, String> {
    let id = identity(&app, &slot)?;
    tauri::async_runtime::spawn_blocking(move || {
        load_profile(&id).map(|profile| profile.map(|p| p.public()))
    })
    .await
    .map_err(|_| "Connection lookup failed.")?
}
#[tauri::command]
pub async fn app_network_configure(
    app: String,
    slot: String,
    endpoint_url: String,
    key: Option<String>,
    remember: bool,
) -> Result<Profile, String> {
    let id = identity(&app, &slot)?;
    let endpoint_url = endpoint(&endpoint_url)?;
    if key
        .as_ref()
        .is_some_and(|key| key.len() > 8192 || key.contains(['\r', '\n']))
    {
        return Err("Invalid API key.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        // Keeping an existing key is allowed only at precisely its old endpoint.
        let key = match key { Some(value) => value, None => {
            let old = load_profile(&id)?.ok_or("Enter an API key or explicitly use no key.")?;
            if old.endpoint != endpoint_url { return Err("Re-enter the key when changing endpoints.".into()); }
            old.key
        }};
        let profile = StoredProfile { endpoint: endpoint_url, key, revision: uuid::Uuid::new_v4().to_string(), remembered: remember };
        let entry = keyring::Entry::new("ShellCanvas.app-connections.v1", &id).map_err(|_| "System credential store unavailable.")?;
        if remember {
            entry.set_password(&serde_json::to_string(&profile).map_err(|_| "Connection encoding failed.")?).map_err(|_| "Cannot save in the system credential store. Choose session only or unlock the store.")?;
        } else {
            // Remove a previously remembered key when switching to session-only.
            match entry.delete_credential() { Ok(()) | Err(keyring::Error::NoEntry) => (), Err(_) => return Err("Cannot remove the old saved credential. Unlock the credential store and try again.".into()) }
        }
        let public = profile.public();
        PROFILES.lock().map_err(|_| "Connection store unavailable.")?.insert(id, profile);
        Ok(public)
    }).await.map_err(|_| "Connection configuration failed.")?
}
#[tauri::command]
pub async fn app_network_forget(app: String, slot: String) -> Result<(), String> {
    let id = identity(&app, &slot)?;
    tauri::async_runtime::spawn_blocking(move || {
        let entry = keyring::Entry::new("ShellCanvas.app-connections.v1", &id)
            .map_err(|_| "System credential store unavailable.")?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => (),
            Err(_) => return Err(
                "Cannot remove the saved credential. Unlock the credential store and try again."
                    .into(),
            ),
        }
        PROFILES
            .lock()
            .map_err(|_| "Connection store unavailable.")?
            .remove(&id);
        Ok(())
    })
    .await
    .map_err(|_| "Connection removal failed.")?
}

struct Request {
    owner: String,
    started: AtomicBool,
    canceled: watch::Sender<bool>,
    response: AsyncMutex<Option<reqwest::Response>>,
    remaining: AsyncMutex<usize>,
}
static REQUESTS: LazyLock<Mutex<HashMap<String, Arc<Request>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
fn request(owner: &str, id: &str) -> Result<Arc<Request>, String> {
    REQUESTS
        .lock()
        .map_err(|_| "HTTP request state unavailable.")?
        .get(id)
        .filter(|request| request.owner == owner)
        .cloned()
        .ok_or_else(|| "HTTP request closed.".into())
}
#[tauri::command]
pub fn app_network_prepare(owner: String) -> Result<String, String> {
    if uuid::Uuid::parse_str(&owner).is_err() {
        return Err("Invalid request owner.".into());
    }
    let mut requests = REQUESTS
        .lock()
        .map_err(|_| "HTTP request state unavailable.")?;
    if requests.len() >= 32 || requests.values().filter(|r| r.owner == owner).count() >= 4 {
        return Err("Too many active HTTP requests.".into());
    }
    let id = uuid::Uuid::new_v4().to_string();
    requests.insert(
        id.clone(),
        Arc::new(Request {
            owner: owner.clone(),
            started: AtomicBool::new(false),
            canceled: watch::channel(false).0,
            response: AsyncMutex::new(None),
            remaining: AsyncMutex::new(16 * 1024 * 1024),
        }),
    );
    let cleanup = id.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(300)).await;
        app_network_close(owner, cleanup);
    });
    Ok(id)
}
#[tauri::command]
pub fn app_network_close(owner: String, id: String) {
    if let Ok(mut requests) = REQUESTS.lock() {
        if requests.get(&id).is_some_and(|r| r.owner == owner) {
            if let Some(request) = requests.remove(&id) {
                request.canceled.send_replace(true);
            }
        }
    }
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResponseHead {
    status: u16,
    content_type: String,
}
#[tauri::command]
pub async fn app_network_start(
    owner: String,
    id: String,
    app: String,
    slot: String,
    revision: String,
    body: String,
) -> Result<ResponseHead, String> {
    let request = request(&owner, &id)?;
    if request.started.swap(true, Ordering::SeqCst) {
        return Err("HTTP request already started.".into());
    }
    if body.len() > 3 * 1024 * 1024 || serde_json::from_str::<serde_json::Value>(&body).is_err() {
        return Err("Send a JSON request body of at most 3 MiB.".into());
    }
    let profile_id = identity(&app, &slot)?;
    let mut canceled = request.canceled.subscribe();
    if *canceled.borrow() {
        return Err("HTTP request canceled.".into());
    }
    let work = async {
        let profile = tauri::async_runtime::spawn_blocking(move || load_profile(&profile_id))
            .await
            .map_err(|_| "Connection lookup failed.")??
            .ok_or("Configure this app connection first.")?;
        if profile.revision != revision {
            return Err(
                "Connection changed. Review the selected endpoint before sending again.".into(),
            );
        }
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(180))
            .build()
            .map_err(|_| "HTTP client unavailable.")?;
        let mut builder = client
            .post(endpoint(&profile.endpoint)?)
            .header("Content-Type", "application/json")
            .header("Accept", "text/event-stream, application/json")
            .body(body);
        if !profile.key.is_empty() {
            builder = builder.bearer_auth(&profile.key);
        }
        let response = builder.send().await.map_err(|_| {
            "Endpoint request failed. Check the URL, TLS certificate and connection."
        })?;
        let head = ResponseHead {
            status: response.status().as_u16(),
            content_type: response
                .headers()
                .get("content-type")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .to_string(),
        };
        *request.response.lock().await = Some(response);
        Ok(head)
    };
    tokio::select! { biased; _ = canceled.changed() => Err("HTTP request canceled.".into()), result = work => result }
}
#[tauri::command]
pub async fn app_network_read(owner: String, id: String) -> Result<Option<Vec<u8>>, String> {
    let request = request(&owner, &id)?;
    let mut canceled = request.canceled.subscribe();
    if *canceled.borrow() {
        return Err("HTTP request canceled.".into());
    }
    let work = async {
        let mut response = request.response.lock().await;
        let response = response.as_mut().ok_or("HTTP response is not open.")?;
        let chunk = response
            .chunk()
            .await
            .map_err(|_| "Endpoint response was interrupted.")?;
        if let Some(chunk) = chunk {
            let mut remaining = request.remaining.lock().await;
            if chunk.len() > *remaining {
                return Err("Endpoint response exceeded 16 MiB.".into());
            }
            *remaining -= chunk.len();
            // The trusted broker splits transport chunks into bounded app RPC messages.
            Ok(Some(chunk.to_vec()))
        } else {
            Ok(None)
        }
    };
    tokio::select! { biased; _ = canceled.changed() => Err("HTTP request canceled.".into()), result = work => result }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn restrict_endpoint_and_credential_identity() {
        assert!(endpoint("https://api.example.test/v1/chat/completions").is_ok());
        assert!(endpoint("http://127.0.0.1:11434/v1/chat/completions").is_ok());
        for bad in [
            "file:///secret",
            "https://user:key@host/api",
            "https://host/api?key=secret",
            "https://host/#fragment",
        ] {
            assert!(endpoint(bad).is_err());
        }
        assert!(identity("org.example.app", "model").is_ok());
        assert!(identity("org.example.app", "../other").is_err());
        let p = StoredProfile {
            endpoint: "https://host/api".into(),
            key: "secret".into(),
            revision: "r".into(),
            remembered: true,
        };
        assert!(!serde_json::to_string(&p.public())
            .unwrap()
            .contains("secret"));
    }
    #[tokio::test]
    async fn requests_are_owned_and_cancel_before_start() {
        let owner = uuid::Uuid::new_v4().to_string();
        let id = app_network_prepare(owner.clone()).unwrap();
        assert!(request("other", &id).is_err());
        app_network_close("other".into(), id.clone());
        assert!(request(&owner, &id).is_ok());
        app_network_close(owner.clone(), id.clone());
        assert!(request(&owner, &id).is_err());
    }
    #[tokio::test]
    async fn native_http_uses_exact_profile_and_streams_without_returning_credentials() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut raw = Vec::new();
            let mut buffer = [0; 1024];
            loop {
                let count = socket.read(&mut buffer).await.unwrap();
                raw.extend_from_slice(&buffer[..count]);
                if raw.windows(4).any(|part| part == b"\r\n\r\n") {
                    break;
                }
                assert!(raw.len() < 10000 && count > 0);
            }
            let request = String::from_utf8(raw).unwrap().to_lowercase();
            assert!(request.starts_with("post /v1/chat/completions "));
            assert!(request.contains("authorization: bearer fixture-only-key"));
            socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: 14\r\nConnection: close\r\n\r\ndata: [DONE]\n\n").await.unwrap();
        });
        let app = "org.example.network-test".to_string();
        let slot = uuid::Uuid::new_v4().simple().to_string();
        let profile_id = identity(&app, &slot).unwrap();
        PROFILES.lock().unwrap().insert(
            profile_id.clone(),
            StoredProfile {
                endpoint: format!("http://{address}/v1/chat/completions"),
                key: "fixture-only-key".into(),
                revision: "fixture-revision".into(),
                remembered: false,
            },
        );
        let owner = uuid::Uuid::new_v4().to_string();
        let id = app_network_prepare(owner.clone()).unwrap();
        let head = app_network_start(
            owner.clone(),
            id.clone(),
            app.clone(),
            slot.clone(),
            "fixture-revision".into(),
            "{}".into(),
        )
        .await
        .unwrap();
        assert_eq!(head.status, 200);
        let mut bytes = Vec::new();
        while let Some(chunk) = app_network_read(owner.clone(), id.clone()).await.unwrap() {
            bytes.extend(chunk);
        }
        assert_eq!(bytes, b"data: [DONE]\n\n");
        app_network_close(owner.clone(), id);
        let stale = app_network_prepare(owner.clone()).unwrap();
        assert!(app_network_start(
            owner.clone(),
            stale.clone(),
            app,
            slot,
            "old-revision".into(),
            "{}".into()
        )
        .await
        .unwrap_err()
        .contains("changed"));
        app_network_close(owner, stale);
        PROFILES.lock().unwrap().remove(&profile_id);
        server.await.unwrap();
    }
}
