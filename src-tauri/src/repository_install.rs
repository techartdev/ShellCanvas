// SPDX-License-Identifier: MPL-2.0
//! Read-only repository transport for the trusted Apps manager, never an app HTTP API.
use std::{
    collections::HashMap,
    sync::{LazyLock, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::{watch, Semaphore};

static DOWNLOADS: LazyLock<Semaphore> = LazyLock::new(|| Semaphore::new(4));
type Pending = (Instant, watch::Sender<bool>);
static REQUESTS: LazyLock<Mutex<HashMap<String, Pending>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

#[tauri::command]
pub fn prepare_repository_read() -> Result<String, String> {
    let mut requests = REQUESTS
        .lock()
        .map_err(|_| "Repository download state unavailable.")?;
    requests.retain(|_, (created, _)| created.elapsed() < Duration::from_secs(60));
    if requests.len() >= 32 {
        return Err("Too many pending repository downloads.".into());
    }
    let id = uuid::Uuid::new_v4().to_string();
    requests.insert(id.clone(), (Instant::now(), watch::channel(false).0));
    Ok(id)
}

#[tauri::command]
pub fn cancel_repository_read(id: String) {
    if let Ok(mut requests) = REQUESTS.lock() {
        if let Some((_, sender)) = requests.remove(&id) {
            let _ = sender.send(true);
        }
    }
}

struct RequestGuard(String);
impl Drop for RequestGuard {
    fn drop(&mut self) {
        cancel_repository_read(self.0.clone());
    }
}

fn segment(value: &str) -> bool {
    !value.is_empty()
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}

fn repository_url(
    owner: &str,
    repository: &str,
    reference: &str,
    path: &str,
) -> Result<String, String> {
    if owner.len() > 39
        || !segment(owner)
        || owner.contains(['.', '_'])
        || repository.len() > 100
        || !segment(repository)
        || reference.len() > 200
        || !reference.split('/').all(segment)
        || path.len() > 240
        || !path.split('/').all(segment)
    {
        return Err("Invalid GitHub repository, reference or package path.".into());
    }
    Ok(format!(
        "https://raw.githubusercontent.com/{owner}/{repository}/{reference}/{path}"
    ))
}

#[tauri::command]
pub async fn read_repository_file(
    id: String,
    owner: String,
    repository: String,
    reference: String,
    path: String,
    limit: usize,
) -> Result<String, String> {
    let mut canceled = REQUESTS
        .lock()
        .map_err(|_| "Repository download state unavailable.")?
        .get(&id)
        .ok_or("Repository download canceled or expired.")?
        .1
        .subscribe();
    let _guard = RequestGuard(id);
    tokio::select! {
        biased;
        _ = canceled.changed() => Err("Repository download canceled.".into()),
        result = download_file(owner, repository, reference, path, limit) => result,
    }
}

async fn download_file(
    owner: String,
    repository: String,
    reference: String,
    path: String,
    limit: usize,
) -> Result<String, String> {
    if limit == 0 || limit > 32 * 1024 * 1024 {
        return Err("Invalid package download limit.".into());
    }
    let url = repository_url(&owner, &repository, &reference, &path)?;
    let _permit = DOWNLOADS
        .try_acquire()
        .map_err(|_| "Other repository downloads are still running. Try again shortly.")?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(45))
        .user_agent("ShellCanvas/0.1 repository-installer")
        .build()
        .map_err(|_| "Unable to initialize repository download.")?;
    let mut response = client.get(url).send().await.map_err(|_| {
        "Unable to reach the GitHub repository. Check your connection and try again."
    })?;
    if response.status() != reqwest::StatusCode::OK {
        return Err(format!("Repository file unavailable (HTTP {}). Check the repository, reference and package manifest.", response.status().as_u16()));
    }
    if response
        .content_length()
        .is_some_and(|size| size > limit as u64)
    {
        return Err("Repository file exceeds the package size limit.".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Repository download was interrupted.")?
    {
        if chunk.len() > limit - bytes.len() {
            return Err("Repository file exceeds the package size limit.".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    String::from_utf8(bytes).map_err(|_| "Repository file must be UTF-8 JSON.".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn download_target_is_confined_to_github_raw() {
        assert_eq!(
            repository_url("owner", "assistant", "main", "dist/app.shellcanvas.json").unwrap(),
            "https://raw.githubusercontent.com/owner/assistant/main/dist/app.shellcanvas.json"
        );
        for bad in [
            "../secret",
            "/absolute",
            "https://elsewhere",
            "x?token=y",
            "a%2fb",
            "a\\b",
            "a//b",
            "a/../b",
        ] {
            assert!(repository_url("owner", "app", "main", bad).is_err());
            assert!(repository_url("owner", "app", bad, "manifest.json").is_err());
        }
        assert!(repository_url("owner@evil", "app", "main", "manifest.json").is_err());
    }
}
