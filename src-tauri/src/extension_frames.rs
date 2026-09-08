// SPDX-License-Identifier: MPL-2.0
//! Ephemeral UI package resources. No filesystem paths, remote sessions or grants live here.
use serde::Serialize;
use std::{collections::HashMap, sync::Mutex};
use tauri::{http, plugin::TauriPlugin, Manager, Runtime};

const SCHEME: &str = "shellcanvas-app";
const MAX_PACKAGE_BYTES: usize = 64 * 1024 * 1024;
const MAX_LIVE_BYTES: usize = 256 * 1024 * 1024;

struct Document {
    owner: String,
    html: String,
    script: String,
    style: String,
    policy: String,
}
impl Document {
    fn bytes(&self) -> usize {
        self.html.len() + self.script.len() + self.style.len() + self.policy.len()
    }
}
#[derive(Default)]
pub struct FrameDocuments(Mutex<HashMap<String, Document>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameLocation {
    id: String,
    url: String,
}

impl FrameDocuments {
    fn publish(
        &self,
        owner: &str,
        instance_token: &str,
        script: String,
        style: String,
    ) -> Result<FrameLocation, String> {
        if instance_token.is_empty()
            || instance_token.len() > 100
            || !instance_token
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        {
            return Err("Invalid app instance identity.".into());
        }
        if script.is_empty() || script.len().saturating_add(style.len()) > MAX_PACKAGE_BYTES {
            return Err("Invalid app package resource size.".into());
        }
        let id = uuid::Uuid::new_v4().to_string();
        let nonce = uuid::Uuid::new_v4().to_string();
        let policy = format!("sandbox allow-scripts; default-src 'none'; script-src 'nonce-{nonce}'; style-src 'nonce-{nonce}'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'");
        // Script and CSS are separate resources: package strings cannot escape HTML raw-text tags.
        let html = format!("<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><link nonce=\"{nonce}\" rel=\"stylesheet\" href=\"style.css\"></head><body><div id=\"root\"></div><script nonce=\"{nonce}\" src=\"script.js\"></script></body></html>");
        let html = html.replacen(
            "<head>",
            &format!("<head><meta name=\"shellcanvas-instance\" content=\"{instance_token}\">"),
            1,
        );
        let document = Document {
            owner: owner.into(), html, script,
            style: format!("html,body{{margin:0;min-height:100%;background:#182731;color:#dce7ec;font:14px system-ui}}*{{box-sizing:border-box}}\n{style}"),
            policy,
        };
        let mut documents = self
            .0
            .lock()
            .map_err(|_| "App document store is unavailable.")?;
        let bytes: usize = documents.values().map(Document::bytes).sum();
        if bytes.saturating_add(document.bytes()) > MAX_LIVE_BYTES {
            return Err("Close an app window before loading more app resources.".into());
        }
        documents.insert(id.clone(), document);
        Ok(FrameLocation {
            url: format!("http://{SCHEME}.localhost/{id}/index.html"),
            id,
        })
    }

    fn release(&self, owner: &str, id: &str) -> Result<bool, String> {
        let mut documents = self
            .0
            .lock()
            .map_err(|_| "App document store is unavailable.")?;
        if let Some(document) = documents.get(id) {
            if document.owner != owner {
                return Err("This app document belongs to another webview.".into());
            }
            documents.remove(id);
            return Ok(true);
        }
        Ok(false)
    }

    fn response(&self, owner: &str, request: &http::Request<Vec<u8>>) -> http::Response<Vec<u8>> {
        let missing = || {
            http::Response::builder()
                .status(404)
                .header("Cache-Control", "no-store")
                .body(Vec::new())
                .unwrap()
        };
        if request.method() != http::Method::GET || request.uri().query().is_some() {
            return missing();
        }
        let Some(path) = request.uri().path().strip_prefix('/') else {
            return missing();
        };
        let Some((id, resource)) = path.split_once('/') else {
            return missing();
        };
        let Ok(documents) = self.0.lock() else {
            return missing();
        };
        let Some(document) = documents.get(id).filter(|document| document.owner == owner) else {
            return missing();
        };
        let (body, mime) = match resource {
            "index.html" => (&document.html, "text/html; charset=utf-8"),
            "script.js" => (&document.script, "text/javascript; charset=utf-8"),
            "style.css" => (&document.style, "text/css; charset=utf-8"),
            _ => return missing(),
        };
        http::Response::builder()
            .header("Content-Type", mime)
            .header("Content-Security-Policy", &document.policy)
            .header("X-Content-Type-Options", "nosniff")
            .header("Cache-Control", "no-store")
            .header("Referrer-Policy", "no-referrer")
            .body(body.as_bytes().to_vec())
            .unwrap()
    }
}

#[tauri::command]
pub fn publish_app_frame(
    webview: tauri::WebviewWindow,
    state: tauri::State<'_, FrameDocuments>,
    script: String,
    style: String,
    instance_token: String,
) -> Result<FrameLocation, String> {
    if !cfg!(windows) {
        return Err("Native runtime app frames are not yet verified on this platform.".into());
    }
    if webview.label() != "main" {
        return Err("Only the desktop can create app frames.".into());
    }
    state.publish(webview.label(), &instance_token, script, style)
}
#[tauri::command]
pub fn release_app_frame(
    webview: tauri::WebviewWindow,
    state: tauri::State<'_, FrameDocuments>,
    id: String,
) -> Result<bool, String> {
    state.release(webview.label(), &id)
}

pub fn plugin<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new("runtime-app-documents")
        // Wry's Windows navigation callback handles the top-level WebView. Never promote an
        // app resource into that privileged document. Other platforms remain gated above.
        .on_navigation(|_, url| {
            !cfg!(windows)
                || (url.scheme() != SCHEME && url.host_str() != Some("shellcanvas-app.localhost"))
        })
        .register_uri_scheme_protocol(SCHEME, |context, request| {
            context
                .app_handle()
                .state::<FrameDocuments>()
                .response(context.webview_label(), &request)
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request(path: &str) -> http::Request<Vec<u8>> {
        http::Request::builder().uri(path).body(Vec::new()).unwrap()
    }
    #[test]
    fn resources_are_opaque_owner_bound_and_disappear_on_release() {
        let documents = FrameDocuments::default();
        let one = documents
            .publish(
                "main",
                "instance-one",
                "window.example = 1".into(),
                "body{color:red}".into(),
            )
            .unwrap();
        let other = documents
            .publish(
                "main",
                "instance-two",
                "window.example = 2".into(),
                "".into(),
            )
            .unwrap();
        let path = format!("/{}/script.js", one.id);
        assert_eq!(
            documents.response("main", &request(&path)).body(),
            b"window.example = 1"
        );
        assert_eq!(documents.response("foreign", &request(&path)).status(), 404);
        assert!(documents.release("foreign", &one.id).is_err());
        documents.release("main", &one.id).unwrap();
        assert_eq!(documents.response("main", &request(&path)).status(), 404);
        assert_eq!(
            documents
                .response("main", &request(&format!("/{}/script.js", other.id)))
                .status(),
            200
        );
        documents.release("main", &one.id).unwrap();
    }
    #[test]
    fn package_markup_is_never_embedded_in_the_host_document() {
        let documents = FrameDocuments::default();
        let location = documents
            .publish(
                "main",
                "instance-one",
                "const text = '</script><script>escape'".into(),
                "/* </style><script>escape */".into(),
            )
            .unwrap();
        let response =
            documents.response("main", &request(&format!("/{}/index.html", location.id)));
        let html = std::str::from_utf8(response.body()).unwrap();
        assert!(!html.contains("escape"));
        assert!(html.contains("src=\"script.js\""));
        assert!(response.headers()["Content-Security-Policy"]
            .to_str()
            .unwrap()
            .contains("sandbox allow-scripts"));
        assert_eq!(response.headers()["Cache-Control"], "no-store");
        for tail in [
            "../index.html",
            "%2e%2e/script.js",
            "script.js?other",
            "secret.txt",
            "index.html/extra",
        ] {
            assert_eq!(
                documents
                    .response("main", &request(&format!("/{}/{tail}", location.id)))
                    .status(),
                404
            );
        }
        let post = http::Request::builder()
            .method("POST")
            .uri(format!("/{}/index.html", location.id))
            .body(Vec::new())
            .unwrap();
        assert_eq!(documents.response("main", &post).status(), 404);
    }
}
