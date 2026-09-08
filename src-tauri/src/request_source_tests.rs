// SPDX-License-Identifier: MPL-2.0
use super::*;
use async_trait::async_trait;
use std::sync::atomic::AtomicUsize;
use tokio::sync::Notify;

struct Lifecycle;
#[async_trait]
impl ConnectionLifecycle for Lifecycle {
    fn is_connected(&self) -> bool {
        true
    }
    async fn disconnect(&self) -> anyhow::Result<()> {
        Ok(())
    }
}
struct Files {
    calls: AtomicUsize,
}
#[async_trait]
impl FileSystemProvider for Files {
    async fn list(&self, _: Option<&str>) -> anyhow::Result<Directory> {
        unreachable!()
    }
    async fn locate(&self, _: &str) -> anyhow::Result<FileLocation> {
        unreachable!()
    }
    async fn preview(&self, _: &str) -> anyhow::Result<String> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok("new source".into())
    }
}
fn source(instance: u64) -> Arc<ConnectionResource> {
    ConnectionResource::new(
        ConnectionIdentity {
            instance,
            generation: 1,
            adapter: "fixture.files".into(),
        },
        Arc::new(Lifecycle),
    )
}

#[tokio::test]
async fn queued_native_lookup_and_captured_handle_cannot_follow_a_source_swap() {
    let state = Arc::new(DesktopState::default());
    let old = source(301);
    let fresh = source(302);
    let old_files = Arc::new(Files {
        calls: AtomicUsize::new(0),
    });
    let new_files = Arc::new(Files {
        calls: AtomicUsize::new(0),
    });
    let mut workspace = ActiveSession::new(vec![old.clone()]).unwrap();
    workspace.bind_files(&old, old_files.clone()).unwrap();
    state.registry.lock().await.sessions.insert(7, workspace);
    let captured = filesystem(&state, 7, Some(old.identity())).await.unwrap();
    let mut registry = state.registry.lock().await;
    let started = Arc::new(Notify::new());
    let queued = {
        let state = state.clone();
        let expected = old.identity().clone();
        let started = started.clone();
        tokio::spawn(async move {
            started.notify_one();
            filesystem(&state, 7, Some(&expected)).await
        })
    };
    started.notified().await;
    let mut candidate = ActiveSession::new(vec![fresh.clone()]).unwrap();
    candidate.bind_files(&fresh, new_files.clone()).unwrap();
    let retired = registry
        .sessions
        .get_mut(&7)
        .unwrap()
        .replace_source(old.identity(), candidate)
        .unwrap();
    drop(registry);
    assert!(queued.await.unwrap().is_err());
    assert!(captured.preview("opaque@old").await.is_err());
    assert!(filesystem(&state, 7, None).await.is_err());
    assert!(filesystem(&state, 8, Some(fresh.identity())).await.is_err());
    assert_eq!(old_files.calls.load(Ordering::SeqCst), 0);
    assert_eq!(new_files.calls.load(Ordering::SeqCst), 0);
    let accepted = filesystem(&state, 7, Some(fresh.identity())).await.unwrap();
    assert_eq!(accepted.preview("opaque@new").await.unwrap(), "new source");
    assert_eq!(new_files.calls.load(Ordering::SeqCst), 1);
    retired.close().await.unwrap();
    state
        .registry
        .lock()
        .await
        .remove(7)
        .unwrap()
        .disconnect()
        .await
        .unwrap();
}
