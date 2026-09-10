// SPDX-License-Identifier: MPL-2.0
//! Retain the original helper ownership until an explicit cleanup retry succeeds.
use std::sync::Mutex;
use tokio::sync::Notify;

#[derive(Default)]
pub(crate) struct Recovery {
    state: Mutex<(Option<String>, bool)>,
    retry: Notify,
}
impl Recovery {
    pub fn snapshot(&self) -> Result<(Option<String>, bool), String> {
        self.state
            .lock()
            .map(|s| s.clone())
            .map_err(|_| "Cleanup state unavailable".into())
    }
    pub fn request(&self) -> Result<(), String> {
        let mut state = self.state.lock().map_err(|_| "Cleanup state unavailable")?;
        if !state.1 {
            return Err("This attachment is not waiting for a cleanup retry.".into());
        }
        state.1 = false;
        self.retry.notify_one();
        Ok(())
    }
    pub async fn wait_for_retry(&self, message: String) {
        *self.state.lock().unwrap_or_else(|e| e.into_inner()) = (Some(message), true);
        // Notify retains a permit if a user retries just before this await.
        // No automatic retry and no dropped process ownership while waiting.
        self.retry.notified().await;
    }
    pub fn finished(&self) {
        *self.state.lock().unwrap_or_else(|e| e.into_inner()) = (None, false);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    #[tokio::test]
    async fn cleanup_waits_for_explicit_retries_and_clears_only_after_success() {
        let recovery = Arc::new(Recovery::default());
        assert!(recovery.request().is_err());
        let attempts = Arc::new(AtomicUsize::new(0));
        let worker = recovery.clone();
        let count = attempts.clone();
        let task = tokio::spawn(async move {
            while count.fetch_add(1, Ordering::SeqCst) < 2 {
                worker.wait_for_retry("Mount still exists".into()).await;
            }
            worker.finished();
        });
        for expected in 1..=2 {
            tokio::time::timeout(std::time::Duration::from_secs(1), async {
                while !recovery.snapshot().unwrap().1 {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
            assert_eq!(attempts.load(Ordering::SeqCst), expected);
            assert!(!task.is_finished());
            assert_eq!(
                recovery.snapshot().unwrap().0.as_deref(),
                Some("Mount still exists")
            );
            recovery.request().unwrap();
            assert!(recovery.request().is_err());
        }
        task.await.unwrap();
        assert_eq!(attempts.load(Ordering::SeqCst), 3);
        assert_eq!(recovery.snapshot().unwrap(), (None, false));
    }
}
