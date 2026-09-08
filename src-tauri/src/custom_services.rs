// SPDX-License-Identifier: MPL-2.0
use crate::custom_binding::CustomMethodInfo;
use shellcanvas_services::ServiceCallError;
use tauri::State;

/// Custom calls have their own capacity and identities; they cannot consume or
/// cancel a connection/trust-review request.
#[derive(Default)]
pub struct CustomRequests(std::sync::Mutex<std::collections::HashMap<String, Request>>);
struct Request {
    canceled: tokio::sync::watch::Sender<bool>,
    started: bool,
}
impl CustomRequests {
    fn begin(&self) -> Result<String, ServiceCallError> {
        let mut calls = self.0.lock().unwrap();
        if calls.len() >= 64 {
            return Err(ServiceCallError::new(
                "busy",
                "Too many pending service calls",
                false,
            ));
        }
        let id = uuid::Uuid::new_v4().to_string();
        let (canceled, _) = tokio::sync::watch::channel(false);
        calls.insert(
            id.clone(),
            Request {
                canceled,
                started: false,
            },
        );
        Ok(id)
    }
    fn claim(&self, id: &str) -> Result<tokio::sync::watch::Receiver<bool>, ServiceCallError> {
        let mut calls = self.0.lock().unwrap();
        let request = calls
            .get_mut(id)
            .ok_or_else(|| ServiceCallError::new("aborted", "Service call was canceled", false))?;
        if request.started {
            return Err(ServiceCallError::new(
                "invalid",
                "Service call already started",
                false,
            ));
        }
        request.started = true;
        Ok(request.canceled.subscribe())
    }
    fn retire(&self, id: &str) {
        if let Some(request) = self.0.lock().unwrap().remove(id) {
            request.canceled.send_replace(true);
        }
    }
}
#[tauri::command]
pub fn begin_custom_call(calls: State<'_, CustomRequests>) -> Result<String, ServiceCallError> {
    calls.begin()
}
#[tauri::command]
pub fn cancel_custom_call(request_id: String, calls: State<'_, CustomRequests>) {
    calls.retire(&request_id);
}

#[tauri::command]
pub async fn list_custom_services(
    session_id: u64,
    state: State<'_, crate::DesktopState>,
) -> Result<Vec<CustomMethodInfo>, String> {
    let registry = state.registry.lock().await;
    let workspace = registry
        .sessions
        .get(&session_id)
        .ok_or("Workspace is closed")?;
    Ok(workspace.custom_methods())
}
#[tauri::command]
pub async fn call_custom_service(
    session_id: u64,
    request_id: String,
    binding: String,
    method: String,
    params: serde_json::Value,
    state: State<'_, crate::DesktopState>,
    calls: State<'_, CustomRequests>,
) -> Result<serde_json::Value, ServiceCallError> {
    let mut canceled = calls.claim(&request_id)?;
    let operation = async {
        let service = state
            .registry
            .lock()
            .await
            .sessions
            .get(&session_id)
            .and_then(|workspace| workspace.custom_method(&method, &binding))
            .ok_or_else(|| {
                ServiceCallError::new(
                    "unavailable",
                    "The selected service binding no longer exists",
                    false,
                )
            })?;
        service.call(&method, params).await
    };
    let result = if *canceled.borrow() {
        Err(ServiceCallError::new(
            "aborted",
            "Service call canceled",
            false,
        ))
    } else {
        tokio::select! { biased;
            _=canceled.changed()=>Err(ServiceCallError::new("aborted","Service call canceled",true)),
            result=operation=>result,
        }
    };
    calls.retire(&request_id);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn requests_are_single_use_cancelable_before_dispatch_and_recover_capacity() {
        let calls = CustomRequests::default();
        let first = calls.begin().unwrap();
        calls.retire(&first);
        assert_eq!(calls.claim(&first).unwrap_err().code, "aborted");
        let first = calls.begin().unwrap();
        let cancellation = calls.claim(&first).unwrap();
        assert_eq!(calls.claim(&first).unwrap_err().code, "invalid");
        let remaining: Vec<_> = (0..63).map(|_| calls.begin().unwrap()).collect();
        assert_eq!(calls.begin().unwrap_err().code, "busy");
        calls.retire(&first);
        assert!(*cancellation.borrow());
        let replacement = calls.begin().unwrap();
        assert_ne!(replacement, first);
        calls.retire(&first);
        assert!(calls.claim(&replacement).is_ok());
        for id in remaining {
            calls.retire(&id);
        }
        calls.retire(&replacement);
        assert!(calls.0.lock().unwrap().is_empty());
    }
}
