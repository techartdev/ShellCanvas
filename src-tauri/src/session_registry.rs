// SPDX-License-Identifier: MPL-2.0
use shellcanvas_services::TerminalInput;
use std::collections::HashMap;
use tokio::sync::{mpsc, oneshot};

struct TerminalOwner {
    session: u64,
    sender: mpsc::Sender<TerminalInput>,
    // Dropping the owner cancels the pump even if an IPC call retains a sender.
    _cancel: oneshot::Sender<()>,
}

/// Session IDs are never reused. Every terminal belongs to exactly one session.
pub struct SessionRegistry<T> {
    pub sessions: HashMap<u64, T>,
    terminals: HashMap<u64, TerminalOwner>,
}
impl<T> Default for SessionRegistry<T> {
    fn default() -> Self {
        Self {
            sessions: HashMap::new(),
            terminals: HashMap::new(),
        }
    }
}
impl<T> SessionRegistry<T> {
    pub fn remove(&mut self, session: u64) -> Option<T> {
        self.terminals.retain(|_, owner| owner.session != session);
        self.sessions.remove(&session)
    }
    pub fn add_terminal(
        &mut self,
        session: u64,
        id: u64,
        sender: mpsc::Sender<TerminalInput>,
    ) -> Result<oneshot::Receiver<()>, String> {
        if !self.sessions.contains_key(&session) {
            return Err("This host session is no longer connected".into());
        }
        if self.terminals.contains_key(&id) {
            return Err("Terminal identity already exists".into());
        }
        let (cancel, canceled) = oneshot::channel();
        self.terminals.insert(
            id,
            TerminalOwner {
                session,
                sender,
                _cancel: cancel,
            },
        );
        Ok(canceled)
    }
    pub fn sender(
        &self,
        session: u64,
        terminal: u64,
    ) -> Result<mpsc::Sender<TerminalInput>, String> {
        self.terminals
            .get(&terminal)
            .filter(|owner| owner.session == session && self.sessions.contains_key(&owner.session))
            .map(|owner| owner.sender.clone())
            .ok_or("Terminal is closed or belongs to another host".into())
    }
    pub fn close_terminal(&mut self, session: u64, terminal: u64) {
        if self
            .terminals
            .get(&terminal)
            .is_some_and(|owner| owner.session == session)
        {
            self.terminals.remove(&terminal);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn closing_one_host_preserves_the_other_and_rejects_stale_handles() {
        let mut registry = SessionRegistry::default();
        registry.sessions.insert(1, "host-a");
        registry.sessions.insert(2, "host-b");
        let (a, mut ar) = mpsc::channel(8);
        let (b, mut br) = mpsc::channel(8);
        let mut canceled_a = registry.add_terminal(1, 10, a).unwrap();
        let mut canceled_b = registry.add_terminal(2, 20, b).unwrap();
        let retained = registry.sender(1, 10).unwrap();
        assert!(registry.sender(1, 20).is_err());
        registry.close_terminal(1, 20);
        assert!(registry.sender(2, 20).is_ok());
        registry.remove(1);
        assert!(matches!(
            canceled_a.try_recv(),
            Err(oneshot::error::TryRecvError::Closed)
        ));
        assert!(matches!(
            canceled_b.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        ));
        drop(retained);
        assert!(ar.is_closed());
        assert!(ar.try_recv().is_err());
        assert!(!br.is_closed());
        registry
            .sender(2, 20)
            .unwrap()
            .try_send(TerminalInput::Data(vec![42]))
            .unwrap();
        assert!(matches!(br.try_recv().unwrap(), TerminalInput::Data(data) if data == vec![42]));
        registry.sessions.insert(3, "host-a-reconnected");
        assert!(registry.sender(1, 10).is_err());
        assert!(registry.sender(3, 10).is_err());
        let (late, receiver) = mpsc::channel(8);
        assert!(registry.add_terminal(1, 30, late).is_err());
        assert!(receiver.is_closed());
        assert_eq!(registry.sessions.get(&2), Some(&"host-b"));
    }
}
