// SPDX-License-Identifier: MPL-2.0
use anyhow::{bail, Result};
use shellcanvas_services::{FileMoveService, FileRelocation};
use std::sync::{Arc, Mutex};
use tokio::sync::watch;

enum State {
    Ready,
    Reserved(u64),
    Running,
    Retired,
}
struct Ledger {
    state: State,
    serial: u64,
}

/// One cut intent shared by clipboard snapshots and prepared jobs. A dispatched
/// move is never replayed, even if its waiter disappears before seeing the result.
pub(crate) struct CutSelection {
    owner: u64,
    service: Arc<dyn FileMoveService>,
    path: String,
    revision: String,
    pub name: String,
    ledger: Mutex<Ledger>,
}
impl CutSelection {
    pub fn new(
        owner: u64,
        service: Arc<dyn FileMoveService>,
        path: String,
        revision: String,
        name: String,
    ) -> Result<Arc<Self>> {
        if path.is_empty() || revision.is_empty() {
            bail!("Refresh the item before cutting it");
        }
        Ok(Arc::new(Self {
            owner,
            service,
            path,
            revision,
            name,
            ledger: Mutex::new(Ledger {
                state: State::Ready,
                serial: 0,
            }),
        }))
    }
    pub fn retired(&self) -> bool {
        matches!(self.ledger.lock().unwrap().state, State::Retired)
    }
    pub fn cancel(&self, owner: u64) -> Result<()> {
        if self.owner != owner {
            bail!("Cut item belongs to another workspace");
        }
        let mut ledger = self.ledger.lock().unwrap();
        if matches!(ledger.state, State::Running) {
            bail!("The cut item is already moving. Wait for its result.");
        }
        ledger.state = State::Retired;
        Ok(())
    }
    pub fn prepare(
        self: &Arc<Self>,
        owner: u64,
        service: &Arc<dyn FileMoveService>,
        parent: String,
    ) -> Result<MoveClaim> {
        if owner != self.owner || !Arc::ptr_eq(service, &self.service) {
            bail!("Cut item belongs to another workspace or an earlier file connection. Cut it again on this connection.");
        }
        if parent.is_empty() || parent == self.path {
            bail!("Choose a different destination folder");
        }
        let mut ledger = self.ledger.lock().unwrap();
        match ledger.state {
            State::Ready => {}
            State::Reserved(_) | State::Running => {
                bail!("A paste of this cut item is already pending")
            }
            State::Retired => {
                bail!("This cut has already been dispatched. Refresh and cut again if needed.")
            }
        }
        ledger.serial += 1;
        let token = ledger.serial;
        ledger.state = State::Reserved(token);
        Ok(MoveClaim {
            selection: self.clone(),
            token,
            parent,
            started: false,
        })
    }
}
pub(crate) struct MoveClaim {
    selection: Arc<CutSelection>,
    token: u64,
    parent: String,
    started: bool,
}
impl MoveClaim {
    pub async fn run(
        mut self,
        cancel: &watch::Receiver<bool>,
        tracked: &[String],
    ) -> Result<FileRelocation> {
        if *cancel.borrow() {
            bail!("Transfer canceled");
        }
        {
            let mut ledger = self.selection.ledger.lock().unwrap();
            if !matches!(ledger.state,State::Reserved(token) if token == self.token) {
                bail!("Cut reservation is no longer available");
            }
            ledger.state = State::Running;
            self.started = true;
        }
        // Once dispatched, await the provider's authoritative outcome. A late
        // cancel does not turn a confirmed rename into a canceled transfer.
        self.selection
            .service
            .move_tracked(
                &self.selection.path,
                &self.parent,
                &self.selection.revision,
                tracked,
            )
            .await
    }
}
impl Drop for MoveClaim {
    fn drop(&mut self) {
        let mut ledger = self.selection.ledger.lock().unwrap();
        if self.started {
            ledger.state = State::Retired;
        } else if matches!(ledger.state,State::Reserved(token) if token == self.token) {
            ledger.state = State::Ready;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::sync::Notify;

    struct Probe {
        calls: AtomicUsize,
        started: Notify,
        release: Notify,
        outcome: &'static str,
    }
    #[async_trait::async_trait]
    impl FileMoveService for Probe {
        async fn move_tracked(
            &self,
            path: &str,
            parent: &str,
            revision: &str,
            tracked: &[String],
        ) -> Result<FileRelocation> {
            assert_eq!(
                (path, parent, revision),
                ("opaque@source", "opaque@target", "exact")
            );
            assert_eq!(tracked, &["tracked@draft"]);
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.started.notify_one();
            self.release.notified().await;
            match self.outcome {
                "error" => bail!("Provider lost acknowledgement; destination may exist"),
                "panic" => panic!("Synthetic provider panic"),
                _ => Ok(FileRelocation {
                    path: "opaque@result".into(),
                    locations: vec![],
                }),
            }
        }
    }
    fn setup(outcome: &'static str) -> (Arc<Probe>, Arc<dyn FileMoveService>, Arc<CutSelection>) {
        let probe = Arc::new(Probe {
            calls: AtomicUsize::new(0),
            started: Notify::new(),
            release: Notify::new(),
            outcome,
        });
        let service: Arc<dyn FileMoveService> = probe.clone();
        let cut = CutSelection::new(
            10,
            service.clone(),
            "opaque@source".into(),
            "exact".into(),
            "notes".into(),
        )
        .unwrap();
        (probe, service, cut)
    }
    fn prepare(cut: &Arc<CutSelection>, service: &Arc<dyn FileMoveService>) -> Result<MoveClaim> {
        cut.prepare(10, service, "opaque@target".into())
    }
    #[test]
    fn cut_is_bound_to_owner_and_provider_and_reservations_are_exclusive() {
        let (_, service, cut) = setup("ok");
        let (_, other, independent) = setup("ok");
        assert!(cut.prepare(11, &service, "opaque@target".into()).is_err());
        assert!(prepare(&cut, &other).is_err());
        let first = prepare(&cut, &service).unwrap();
        assert!(prepare(&cut.clone(), &service).is_err());
        let independent_claim = prepare(&independent, &other).unwrap();
        drop(first);
        assert!(!cut.retired());
        drop(prepare(&cut, &service).unwrap());
        drop(independent_claim);
    }
    #[tokio::test]
    async fn canceling_a_cut_retires_existing_snapshots_and_prepared_claims() {
        let (probe, service, cut) = setup("ok");
        let snapshot = cut.clone();
        let claim = prepare(&cut, &service).unwrap();
        assert!(cut.cancel(11).is_err());
        assert!(!cut.retired());
        cut.cancel(10).unwrap();
        let (_stop, cancel) = watch::channel(false);
        assert!(claim.run(&cancel, &[]).await.is_err());
        assert!(snapshot.retired());
        assert!(prepare(&snapshot, &service).is_err());
        assert_eq!(probe.calls.load(Ordering::SeqCst), 0);
    }
    #[tokio::test]
    async fn canceled_before_dispatch_can_be_prepared_again_without_touching_provider() {
        let (probe, service, cut) = setup("ok");
        let claim = prepare(&cut, &service).unwrap();
        let (_stop, cancel) = watch::channel(true);
        assert!(claim
            .run(&cancel, &[])
            .await
            .unwrap_err()
            .to_string()
            .starts_with("Transfer canceled"));
        assert_eq!(probe.calls.load(Ordering::SeqCst), 0);
        assert!(!cut.retired());
        drop(prepare(&cut, &service).unwrap());
    }
    #[tokio::test]
    async fn late_cancel_waits_for_authoritative_move_and_never_replays_it() {
        let (probe, service, cut) = setup("ok");
        let claim = prepare(&cut, &service).unwrap();
        let (stop, cancel) = watch::channel(false);
        let task = tokio::spawn(async move { claim.run(&cancel, &["tracked@draft".into()]).await });
        tokio::time::timeout(std::time::Duration::from_secs(2), probe.started.notified())
            .await
            .unwrap();
        stop.send_replace(true);
        assert!(!task.is_finished());
        assert!(prepare(&cut, &service).is_err());
        probe.release.notify_one();
        assert_eq!(task.await.unwrap().unwrap().path, "opaque@result");
        assert!(cut.retired());
        assert!(prepare(&cut, &service).is_err());
        assert_eq!(probe.calls.load(Ordering::SeqCst), 1);
    }
    #[tokio::test]
    async fn failed_panicked_and_abandoned_dispatched_moves_are_never_replayed() {
        for outcome in ["error", "panic", "abandoned"] {
            let (probe, service, cut) = setup(outcome);
            let claim = prepare(&cut, &service).unwrap();
            let (_stop, cancel) = watch::channel(false);
            let task =
                tokio::spawn(async move { claim.run(&cancel, &["tracked@draft".into()]).await });
            tokio::time::timeout(std::time::Duration::from_secs(2), probe.started.notified())
                .await
                .unwrap();
            if outcome == "abandoned" {
                task.abort();
            } else {
                probe.release.notify_one();
            }
            match task.await {
                Ok(result) => assert!(result.is_err()),
                Err(error) => assert!(error.is_cancelled() || error.is_panic()),
            }
            assert!(cut.retired());
            assert!(prepare(&cut, &service).is_err());
            assert_eq!(probe.calls.load(Ordering::SeqCst), 1);
        }
    }
}
