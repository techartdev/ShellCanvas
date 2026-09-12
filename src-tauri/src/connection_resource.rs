// SPDX-License-Identifier: MPL-2.0
use shellcanvas_services::{ConnectionIdentity, ConnectionLifecycle};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::Duration;
use tokio::sync::watch;

/// One established connection shared by its service roles. Explicit teardown is
/// started once, survives a canceled caller and reports the same outcome to all
/// waiters. Service handles do not count as workspace leases.
pub struct ConnectionResource {
    identity: ConnectionIdentity,
    lifecycle: Arc<dyn ConnectionLifecycle>,
    closing: AtomicBool,
    outcome: watch::Sender<Option<Result<(), String>>>,
    leases: Mutex<usize>,
    runtime: tokio::runtime::Handle,
    pub clock: Option<Arc<dyn shellcanvas_services::HostClock>>,
}

impl ConnectionResource {
    pub fn new(identity: ConnectionIdentity, lifecycle: Arc<dyn ConnectionLifecycle>) -> Arc<Self> {
        Self::with_clock(identity, lifecycle, None)
    }

    pub fn with_clock(
        identity: ConnectionIdentity,
        lifecycle: Arc<dyn ConnectionLifecycle>,
        clock: Option<Arc<dyn shellcanvas_services::HostClock>>,
    ) -> Arc<Self> {
        let (outcome, _) = watch::channel(None);
        Arc::new(Self {
            identity,
            lifecycle,
            closing: AtomicBool::new(false),
            outcome,
            leases: Mutex::new(0),
            runtime: tokio::runtime::Handle::current(),
            clock,
        })
    }

    pub fn identity(&self) -> &ConnectionIdentity {
        &self.identity
    }

    pub fn is_connected(&self) -> bool {
        !self.closing.load(Ordering::Acquire) && self.lifecycle.is_connected()
    }

    pub fn lease(self: &Arc<Self>) -> Result<ConnectionLease, String> {
        let mut leases = self.leases.lock().unwrap();
        if !self.is_connected() {
            return Err("Cannot lease a disconnected connection".into());
        }
        *leases += 1;
        Ok(ConnectionLease {
            resource: Some(self.clone()),
        })
    }

    fn start_disconnect(self: &Arc<Self>) {
        if !self.closing.swap(true, Ordering::AcqRel) {
            let resource = self.clone();
            self.runtime.spawn(async move {
                let lifecycle = resource.lifecycle.clone();
                let mut task = tokio::spawn(async move { lifecycle.disconnect().await });
                let result = match tokio::time::timeout(Duration::from_secs(15), &mut task).await {
                    Ok(Ok(result)) => result.map_err(|error| error.to_string()),
                    Ok(Err(_)) => {
                        Err("Connection teardown task failed; remote cleanup is unconfirmed".into())
                    }
                    Err(_) => {
                        task.abort();
                        Err("Connection teardown timed out; remote cleanup is unconfirmed".into())
                    }
                };
                resource.outcome.send_replace(Some(result));
            });
        }
    }

    pub async fn disconnect(self: &Arc<Self>) -> Result<(), String> {
        let mut outcome = self.outcome.subscribe();
        self.start_disconnect();
        loop {
            if let Some(result) = outcome.borrow_and_update().clone() {
                return result;
            }
            outcome
                .changed()
                .await
                .map_err(|_| "Connection teardown result unavailable".to_string())?;
        }
    }
}

/// A logical workspace's ownership, independent of retained operation handles.
pub struct ConnectionLease {
    resource: Option<Arc<ConnectionResource>>,
}
impl ConnectionLease {
    pub fn resource(&self) -> &Arc<ConnectionResource> {
        self.resource.as_ref().unwrap()
    }
    fn release(&mut self) -> Option<(Arc<ConnectionResource>, bool)> {
        let resource = self.resource.take()?;
        let last = {
            let mut leases = resource.leases.lock().unwrap();
            *leases -= 1;
            let last = *leases == 0;
            if last {
                resource.start_disconnect();
            }
            last
        };
        Some((resource, last))
    }
    pub async fn close(mut self) -> Result<(), String> {
        if let Some((resource, true)) = self.release() {
            resource.disconnect().await
        } else {
            Ok(())
        }
    }
}
impl Drop for ConnectionLease {
    fn drop(&mut self) {
        self.release();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use tokio::sync::Notify;

    struct FakeConnection {
        calls: AtomicUsize,
        connected: AtomicBool,
        release: Notify,
        fail: bool,
    }
    #[async_trait::async_trait]
    impl ConnectionLifecycle for FakeConnection {
        fn is_connected(&self) -> bool {
            self.connected.load(Ordering::SeqCst)
        }
        async fn disconnect(&self) -> anyhow::Result<()> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.release.notified().await;
            self.connected.store(false, Ordering::SeqCst);
            if self.fail {
                anyhow::bail!("Fixture teardown failed");
            }
            Ok(())
        }
    }
    fn fixture(
        instance: u64,
        adapter: &str,
        fail: bool,
    ) -> (Arc<ConnectionResource>, Arc<FakeConnection>) {
        let fake = Arc::new(FakeConnection {
            calls: AtomicUsize::new(0),
            connected: AtomicBool::new(true),
            release: Notify::new(),
            fail,
        });
        (
            ConnectionResource::new(
                ConnectionIdentity {
                    instance,
                    generation: 1,
                    adapter: adapter.into(),
                },
                fake.clone(),
            ),
            fake,
        )
    }

    #[tokio::test]
    async fn canceled_waiter_and_shared_roles_still_close_once_without_affecting_another_connection(
    ) {
        let (files, fake) = fixture(10, "fixture.files", false);
        let (console, console_fake) = fixture(20, "fixture.console", false);
        let original = {
            let files = files.clone();
            tokio::spawn(async move { files.disconnect().await })
        };
        while fake.calls.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
        original.abort();
        assert!(!files.is_connected());
        assert!(console.is_connected());
        assert_eq!(console_fake.calls.load(Ordering::SeqCst), 0);
        let waiter = {
            let files = files.clone();
            tokio::spawn(async move { files.disconnect().await })
        };
        fake.release.notify_one();
        tokio::time::timeout(Duration::from_secs(1), waiter)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        files.disconnect().await.unwrap();
        assert_eq!(fake.calls.load(Ordering::SeqCst), 1);
        assert_eq!(files.identity().instance, 10);
        assert_eq!(console.identity().adapter, "fixture.console");
        console_fake.release.notify_one();
        console.disconnect().await.unwrap();
    }

    #[tokio::test]
    async fn teardown_failure_is_retained_and_reconnect_gets_an_independent_identity() {
        let (old, fake) = fixture(30, "fixture.api", true);
        fake.release.notify_one();
        assert!(old
            .disconnect()
            .await
            .unwrap_err()
            .contains("Fixture teardown failed"));
        assert!(old.disconnect().await.is_err());
        assert_eq!(fake.calls.load(Ordering::SeqCst), 1);
        let (new, new_fake) = fixture(31, "fixture.api", false);
        assert_ne!(old.identity(), new.identity());
        assert!(!old.is_connected());
        assert!(new.is_connected());
        new_fake.release.notify_one();
        new.disconnect().await.unwrap();
    }

    #[tokio::test]
    async fn panicking_adapter_does_not_leave_teardown_waiters_hanging() {
        struct Panics;
        #[async_trait::async_trait]
        impl ConnectionLifecycle for Panics {
            fn is_connected(&self) -> bool {
                true
            }
            async fn disconnect(&self) -> anyhow::Result<()> {
                panic!("Fixture adapter panic");
            }
        }
        let connection = ConnectionResource::new(
            ConnectionIdentity {
                instance: 40,
                generation: 1,
                adapter: "fixture.panic".into(),
            },
            Arc::new(Panics),
        );
        let result = tokio::time::timeout(Duration::from_secs(1), connection.disconnect())
            .await
            .unwrap();
        assert!(result.unwrap_err().contains("task failed"));
        assert!(connection.disconnect().await.is_err());
        assert!(!connection.is_connected());
    }

    #[tokio::test]
    async fn stalled_adapter_teardown_is_bounded_and_not_retried() {
        let (connection, fake) = fixture(50, "fixture.stalled", false);
        let error = tokio::time::timeout(Duration::from_secs(20), connection.disconnect())
            .await
            .unwrap()
            .unwrap_err();
        assert!(error.contains("timed out"));
        assert_eq!(connection.disconnect().await.unwrap_err(), error);
        assert_eq!(fake.calls.load(Ordering::SeqCst), 1);
        assert!(!connection.is_connected());
    }
}
