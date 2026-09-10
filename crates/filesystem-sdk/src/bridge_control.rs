// SPDX-License-Identifier: MPL-2.0
//! Driver-neutral lifecycle exchange for a single native attachment process.
use crate::{FsError, FsErrorKind, FsResult};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum BridgePhase {
    Starting,
    Attached,
    Detaching,
    Detached,
    Failed,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeSnapshot {
    pub phase: BridgePhase,
    pub message: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum BridgeDirective {
    Continue,
    Detach,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum BridgeEvent {
    Ready,
    Detached,
    DetachFailed { message: String },
    Warning { message: String },
}
struct State {
    snapshot: BridgeSnapshot,
    pending: bool,
}
pub struct BridgeControl(Mutex<State>);
impl Default for BridgeControl {
    fn default() -> Self {
        Self(Mutex::new(State {
            snapshot: BridgeSnapshot {
                phase: BridgePhase::Starting,
                message: None,
            },
            pending: false,
        }))
    }
}
impl BridgeControl {
    fn state(&self) -> FsResult<std::sync::MutexGuard<'_, State>> {
        self.0
            .lock()
            .map_err(|_| FsError::new(FsErrorKind::Offline, "Attachment state unavailable"))
    }
    pub fn snapshot(&self) -> FsResult<BridgeSnapshot> {
        Ok(self.state()?.snapshot.clone())
    }
    pub fn request_detach(&self) -> FsResult<()> {
        let mut state = self.state()?;
        if state.snapshot.phase != BridgePhase::Attached {
            return Err(FsError::new(
                FsErrorKind::InvalidInput,
                "Attachment is not ready for a detach request",
            ));
        }
        state.snapshot.phase = BridgePhase::Detaching;
        state.snapshot.message = None;
        state.pending = true;
        Ok(())
    }
    pub fn poll(&self) -> FsResult<BridgeDirective> {
        let mut state = self.state()?;
        if matches!(
            state.snapshot.phase,
            BridgePhase::Failed | BridgePhase::Detached
        ) {
            return Err(FsError::new(FsErrorKind::Offline, "Attachment is retired"));
        }
        Ok(if std::mem::take(&mut state.pending) {
            BridgeDirective::Detach
        } else {
            BridgeDirective::Continue
        })
    }
    pub fn report(&self, event: BridgeEvent) -> FsResult<()> {
        let mut state = self.state()?;
        match event {
            BridgeEvent::Ready if state.snapshot.phase == BridgePhase::Starting => {
                state.snapshot.phase = BridgePhase::Attached
            }
            BridgeEvent::Detached
                if matches!(
                    state.snapshot.phase,
                    BridgePhase::Attached | BridgePhase::Detaching
                ) =>
            {
                state.snapshot.phase = BridgePhase::Detached;
                state.snapshot.message = None;
                state.pending = false;
            }
            BridgeEvent::DetachFailed { message }
                if state.snapshot.phase == BridgePhase::Detaching =>
            {
                state.snapshot.phase = BridgePhase::Attached;
                state.snapshot.message = Some(message.chars().take(4096).collect());
            }
            BridgeEvent::Warning { message }
                if matches!(
                    state.snapshot.phase,
                    BridgePhase::Attached | BridgePhase::Detaching
                ) =>
            {
                state.snapshot.message = Some(message.chars().take(4096).collect())
            }
            _ => {
                return Err(FsError::new(
                    FsErrorKind::InvalidInput,
                    "Unexpected attachment lifecycle event",
                ))
            }
        }
        Ok(())
    }
    pub fn fail(&self, message: String) {
        if let Ok(mut state) = self.state() {
            if state.snapshot.phase != BridgePhase::Detached {
                state.snapshot.phase = BridgePhase::Failed;
                state.snapshot.message = Some(message.chars().take(4096).collect());
            }
            state.pending = false;
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn busy_detach_preserves_attachment_and_requires_a_new_explicit_request() {
        let control = BridgeControl::default();
        assert!(control.request_detach().is_err());
        control.report(BridgeEvent::Ready).unwrap();
        control.request_detach().unwrap();
        assert!(control.request_detach().is_err());
        assert!(matches!(control.poll().unwrap(), BridgeDirective::Detach));
        assert!(matches!(control.poll().unwrap(), BridgeDirective::Continue));
        control
            .report(BridgeEvent::DetachFailed {
                message: "Close the editor".into(),
            })
            .unwrap();
        assert_eq!(control.snapshot().unwrap().phase, BridgePhase::Attached);
        assert!(matches!(control.poll().unwrap(), BridgeDirective::Continue));
        control.request_detach().unwrap();
        control.poll().unwrap();
        control.report(BridgeEvent::Detached).unwrap();
        control.fail("pipe closed normally".into());
        assert_eq!(control.snapshot().unwrap().phase, BridgePhase::Detached);
        assert!(control.report(BridgeEvent::Ready).is_err());
    }
}
