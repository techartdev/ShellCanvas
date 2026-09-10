// SPDX-License-Identifier: MPL-2.0
//! Cancellation stops at the native launch boundary. Live mounts use detach.
use std::{future::Future, sync::Mutex};
use tokio::sync::Notify;

#[derive(Default, PartialEq)]
enum Phase {
    #[default]
    Preparing,
    Canceled,
    Launching,
    Finished,
}
#[derive(Default)]
pub(crate) struct Startup {
    phase: Mutex<Phase>,
    canceled: Notify,
}
const CANCELED: &str = "Attachment canceled before native startup.";
impl Startup {
    pub fn can_cancel(&self) -> bool {
        self.phase
            .lock()
            .is_ok_and(|phase| *phase == Phase::Preparing)
    }
    pub fn cancel(&self) -> Result<(), String> {
        let mut phase = self
            .phase
            .lock()
            .map_err(|_| "Attachment state unavailable")?;
        match *phase {
            Phase::Preparing => {
                *phase = Phase::Canceled;
                self.canceled.notify_one();
                Ok(())
            }
            Phase::Canceled => Ok(()),
            _ => Err(
                "Native startup has already begun. Wait for the attachment, then use Detach."
                    .into(),
            ),
        }
    }
    pub fn finish(&self) {
        let mut phase = self.phase.lock().unwrap_or_else(|e| e.into_inner());
        if *phase != Phase::Canceled {
            *phase = Phase::Finished;
        }
    }
    pub fn was_canceled(&self) -> bool {
        self.phase
            .lock()
            .is_ok_and(|phase| *phase == Phase::Canceled)
    }
    async fn cancellation(&self) {
        // notify_one retains a permit for cancellation before this await.
        self.canceled.notified().await;
    }
    pub async fn prepare<T>(
        &self,
        preparation: impl Future<Output = Result<T, String>>,
    ) -> Result<T, String> {
        if !self.can_cancel() {
            return Err(CANCELED.into());
        }
        let prepared = tokio::select! {
            biased;
            _ = self.cancellation() => return Err(CANCELED.into()),
            result = preparation => result?,
        };
        // Serialize with cancel(): after this claim no cancellation may drop
        // native ownership, including the spawn() await in ProcessTree.
        let mut phase = self
            .phase
            .lock()
            .map_err(|_| "Attachment state unavailable")?;
        if *phase != Phase::Preparing {
            return Err(CANCELED.into());
        }
        *phase = Phase::Launching;
        Ok(prepared)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    struct Resource(Arc<AtomicUsize>);
    impl Drop for Resource {
        fn drop(&mut self) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }
    #[tokio::test]
    async fn canceled_preparation_drops_owned_resources_without_claiming_launch() {
        let startup = Arc::new(Startup::default());
        let worker = startup.clone();
        let drops = Arc::new(AtomicUsize::new(0));
        let resource = Resource(drops.clone());
        let (entered, wait) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            worker
                .prepare(async move {
                    let _resource = resource;
                    entered.send(()).unwrap();
                    std::future::pending::<Result<(), String>>().await
                })
                .await
        });
        wait.await.unwrap();
        startup.cancel().unwrap();
        startup.cancel().unwrap();
        assert_eq!(
            tokio::time::timeout(std::time::Duration::from_secs(1), task)
                .await
                .unwrap()
                .unwrap()
                .unwrap_err(),
            CANCELED
        );
        assert_eq!(drops.load(Ordering::SeqCst), 1);
        assert!(!startup.can_cancel());
        startup.finish();
        assert!(startup.was_canceled());
        assert!(!startup.can_cancel());
    }
    #[tokio::test]
    async fn cancellation_wins_a_ready_result_but_cannot_cancel_claimed_native_startup() {
        let startup = Startup::default();
        startup.cancel().unwrap();
        assert_eq!(
            startup
                .prepare(async {
                    panic!("Canceled work was polled");
                    #[allow(unreachable_code)]
                    Ok(())
                })
                .await
                .unwrap_err(),
            CANCELED
        );
        let startup = Startup::default();
        let drops = Arc::new(AtomicUsize::new(0));
        let resource = Resource(drops.clone());
        let result = startup
            .prepare(async {
                startup.cancel().unwrap();
                Ok(resource)
            })
            .await;
        assert_eq!(result.err().unwrap(), CANCELED);
        assert_eq!(drops.load(Ordering::SeqCst), 1);
        let startup = Startup::default();
        assert_eq!(startup.prepare(async { Ok(42) }).await.unwrap(), 42);
        assert!(!startup.can_cancel());
        assert!(startup.cancel().is_err());
    }
}
