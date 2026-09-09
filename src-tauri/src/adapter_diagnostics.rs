// SPDX-License-Identifier: MPL-2.0
use shellcanvas_adapter_runtime::{DiagnosticSnapshot, Diagnostics};
use shellcanvas_services::ConnectionIdentity;
use std::{collections::VecDeque, sync::Mutex};
use tauri::{State, WebviewWindow};

const HISTORIES: usize = 32;
struct Record {
    owner: String,
    connection: ConnectionIdentity,
    attempt: u64,
    log: Diagnostics,
}
#[derive(Default)]
pub struct AdapterDiagnostics(Mutex<VecDeque<Record>>);
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionDiagnostics {
    connection: ConnectionIdentity,
    attempt: u64,
    #[serde(flatten)]
    snapshot: DiagnosticSnapshot,
}
impl AdapterDiagnostics {
    pub fn begin(
        &self,
        owner: &str,
        mut connection: ConnectionIdentity,
        attempt: u64,
    ) -> Diagnostics {
        let log = Diagnostics::default();
        // Only validated, bounded public package identifiers belong in history.
        // Acquiring an unknown/invalid package may fail before manifest validation.
        if !shellcanvas_adapter_runtime::wire::name(&connection.adapter) {
            connection.adapter = "unknown-adapter".into();
        }
        let mut records = self.0.lock().unwrap();
        if records.len() == HISTORIES {
            records.pop_front();
        }
        records.push_back(Record {
            owner: owner.into(),
            connection,
            attempt,
            log: log.clone(),
        });
        log
    }
    fn list(&self, owner: &str) -> Vec<ConnectionDiagnostics> {
        self.0
            .lock()
            .unwrap()
            .iter()
            .rev()
            .filter(|record| record.owner == owner)
            .map(|record| ConnectionDiagnostics {
                connection: record.connection.clone(),
                attempt: record.attempt,
                snapshot: record.log.snapshot(),
            })
            .collect()
    }
}
#[tauri::command]
pub fn adapter_diagnostics(
    window: WebviewWindow,
    state: State<'_, AdapterDiagnostics>,
) -> Vec<ConnectionDiagnostics> {
    state.list(window.label())
}
#[cfg(test)]
mod tests {
    use super::*;
    fn identity(instance: u64) -> ConnectionIdentity {
        ConnectionIdentity {
            instance,
            generation: 1,
            adapter: "example.device".into(),
        }
    }
    #[test]
    fn histories_are_window_owned_bounded_and_do_not_own_connections() {
        let store = AdapterDiagnostics::default();
        let first = store.begin("one", identity(1), 10);
        first.preparation_failed();
        store.begin("two", identity(2), 20);
        assert_eq!(store.list("one").len(), 1);
        assert_eq!(store.list("two")[0].connection.instance, 2);
        assert!(store.list("other").is_empty());
        for n in 3..=34 {
            store.begin("one", identity(n), n);
        }
        assert_eq!(store.list("one").len(), 32);
        assert_eq!(store.list("one")[0].connection.instance, 34);
        assert!(store.list("two").is_empty());
        // Eviction only releases a history handle, never a connection resource.
        assert_eq!(first.snapshot().events.len(), 1);
    }
    #[test]
    fn failed_preparation_does_not_retain_invalid_package_identifiers() {
        let store = AdapterDiagnostics::default();
        let mut connection = identity(1);
        connection.adapter = "invalid-private-value".repeat(1024);
        store.begin("main", connection, 1).preparation_failed();
        let report = serde_json::to_string(&store.list("main")).unwrap();
        assert!(report.contains("unknown-adapter"));
        assert!(report.contains("preparationFailed"));
        assert!(!report.contains("invalid-private-value"));
        assert!(report.len() < 1024);
    }
}
