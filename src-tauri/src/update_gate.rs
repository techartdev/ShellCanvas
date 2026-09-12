// SPDX-License-Identifier: MPL-2.0
//! Serialize installation against operations that must not be interrupted.
use std::sync::{Arc, LazyLock, Mutex};

#[derive(Default)]
struct State {
    active: usize,
    installing: bool,
}
#[derive(Default)]
struct Gate(Arc<Mutex<State>>);
static GATE: LazyLock<Gate> = LazyLock::new(Gate::default);

pub struct Operation(Arc<Mutex<State>>);
pub struct Installation(Arc<Mutex<State>>);
impl Gate {
    fn operation(&self) -> Result<Operation, String> {
        let mut state = self.0.lock().unwrap();
        if state.installing {
            return Err("ShellCanvas is installing an update. Try again after restarting.".into());
        }
        state.active += 1;
        Ok(Operation(self.0.clone()))
    }
    fn reserve(&self) -> Result<Installation, String> {
        let mut state = self.0.lock().unwrap();
        if state.installing {
            return Err("An update is already being installed.".into());
        }
        if state.active != 0 {
            return Err("App requests, file operations or clipboard transfers are still active. Finish them before updating.".into());
        }
        state.installing = true;
        Ok(Installation(self.0.clone()))
    }
}
pub fn operation() -> Result<Operation, String> {
    GATE.operation()
}
pub fn reserve() -> Result<Installation, String> {
    GATE.reserve()
}
pub fn installing() -> bool {
    GATE.0.lock().unwrap().installing
}
impl Drop for Operation {
    fn drop(&mut self) {
        self.0.lock().unwrap().active -= 1;
    }
}
impl Drop for Installation {
    fn drop(&mut self) {
        self.0.lock().unwrap().installing = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn live_operations_block_install_and_drop_releases_them() {
        let gate = Gate::default();
        let first = gate.operation().unwrap();
        let second = gate.operation().unwrap();
        assert!(gate.reserve().is_err());
        drop(first);
        assert!(gate.reserve().is_err());
        drop(second);
        assert!(gate.reserve().is_ok());
    }
    #[test]
    fn installation_refuses_new_work_and_failures_release_the_gate() {
        let gate = Gate::default();
        let installing = gate.reserve().unwrap();
        assert!(gate.operation().is_err());
        assert!(gate.reserve().is_err());
        drop(installing);
        assert!(gate.operation().is_ok());
        assert!(gate.reserve().is_ok());
    }
    #[test]
    fn concurrent_reservations_cannot_interrupt_a_live_operation() {
        let gate = Arc::new(Gate::default());
        let operation = gate.operation().unwrap();
        let other = gate.clone();
        std::thread::spawn(move || assert!(other.reserve().is_err()))
            .join()
            .unwrap();
        drop(operation);
        assert!(gate.reserve().is_ok());
    }
}
