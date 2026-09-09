// SPDX-License-Identifier: MPL-2.0
//! Bounded host observations. No adapter-supplied messages, paths, method names,
//! configuration, arguments, stdout/stderr or request/response values are stored.
use serde::Serialize;
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
    time::Instant,
};

const HISTORY: usize = 256;
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DiagnosticStatus {
    Preparing,
    Starting,
    Connected,
    Closed,
    Failed,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DiagnosticKind {
    PreparationFailed,
    PreparationCanceled,
    LaunchRequested,
    Spawned,
    Ready,
    InitializationFailed,
    InitializationCanceled,
    RequestDispatched,
    RequestSucceeded,
    RequestFailed,
    RequestCanceled,
    RequestRejected,
    RequestDeadline,
    LateReply,
    CloseRequested,
    ProcessExited,
    InputFailure,
    OutputFailure,
    InvalidResponse,
    UnknownReply,
    InputBackpressure,
    IdentityExhausted,
    CleanupConfirmed,
    CleanupUnconfirmed,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DiagnosticCode {
    Invalid,
    Closed,
    Aborted,
    Denied,
    Unavailable,
    Busy,
    Failed,
    Deadline,
}
impl DiagnosticCode {
    pub(crate) fn from_code(code: &str) -> Self {
        match code {
            "invalid" => Self::Invalid,
            "closed" => Self::Closed,
            "aborted" => Self::Aborted,
            "denied" => Self::Denied,
            "unavailable" => Self::Unavailable,
            "busy" => Self::Busy,
            "deadline" => Self::Deadline,
            _ => Self::Failed,
        }
    }
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticEvent {
    pub sequence: u64,
    pub elapsed_ms: u64,
    pub kind: DiagnosticKind,
    pub request_id: Option<u64>,
    pub code: Option<DiagnosticCode>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticSnapshot {
    pub schema_version: u8,
    pub status: DiagnosticStatus,
    pub events: Vec<DiagnosticEvent>,
    pub discarded_events: u64,
}
struct State {
    status: DiagnosticStatus,
    claimed: bool,
    started: Instant,
    total: u64,
    events: VecDeque<DiagnosticEvent>,
}
/// Retaining observations never retains the process or installed package lease.
/// Use one fresh handle per launch; it remains readable after failed startup/exit.
#[derive(Clone)]
pub struct Diagnostics(Arc<Mutex<State>>);
impl Default for Diagnostics {
    fn default() -> Self {
        Self(Arc::new(Mutex::new(State {
            claimed: false,
            status: DiagnosticStatus::Preparing,
            started: Instant::now(),
            total: 0,
            events: VecDeque::new(),
        })))
    }
}
impl Diagnostics {
    pub fn snapshot(&self) -> DiagnosticSnapshot {
        let state = self.0.lock().unwrap();
        DiagnosticSnapshot {
            schema_version: 1,
            status: state.status,
            events: state.events.iter().cloned().collect(),
            discarded_events: state.total.saturating_sub(state.events.len() as u64),
        }
    }
    pub(crate) fn claim(&self) -> bool {
        let mut state = self.0.lock().unwrap();
        if state.claimed {
            return false;
        }
        state.claimed = true;
        true
    }
    /// A package could not be acquired/validated before process launch. Record
    /// only this host category, never the potentially sensitive original error.
    pub fn preparation_failed(&self) {
        if self.claim() {
            self.record(DiagnosticKind::PreparationFailed, None, None);
        }
    }
    pub fn preparation_canceled(&self) {
        if self.claim() {
            self.record(DiagnosticKind::PreparationCanceled, None, None);
        }
    }
    pub(crate) fn record(
        &self,
        kind: DiagnosticKind,
        request_id: Option<u64>,
        code: Option<DiagnosticCode>,
    ) {
        let mut state = self.0.lock().unwrap();
        state.total = state.total.saturating_add(1);
        use DiagnosticKind::*;
        state.status = match kind {
            LaunchRequested | Spawned => DiagnosticStatus::Starting,
            Ready if state.status == DiagnosticStatus::Starting => DiagnosticStatus::Connected,
            PreparationFailed | InitializationFailed | ProcessExited | InputFailure
            | OutputFailure | InvalidResponse | UnknownReply | InputBackpressure
            | IdentityExhausted | CleanupUnconfirmed => DiagnosticStatus::Failed,
            PreparationCanceled | InitializationCanceled
                if state.status != DiagnosticStatus::Failed =>
            {
                DiagnosticStatus::Closed
            }
            CloseRequested if state.status != DiagnosticStatus::Failed => DiagnosticStatus::Closed,
            _ => state.status,
        };
        let event = DiagnosticEvent {
            sequence: state.total,
            elapsed_ms: state.started.elapsed().as_millis().min(u64::MAX as u128) as u64,
            kind,
            request_id,
            code,
        };
        if state.events.len() == HISTORY {
            state.events.pop_front();
        }
        state.events.push_back(event);
    }
}
