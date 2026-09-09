// SPDX-License-Identifier: MPL-2.0
#![cfg(windows)]
use serde_json::{json, Value};
use shellcanvas_adapter_runtime::{AdapterProcess, Launch};
use std::{
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use windows_sys::Win32::{
    Foundation::{WAIT_OBJECT_0, WAIT_TIMEOUT},
    System::Threading::{
        OpenProcess, TerminateProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
    },
};
const DEADLINE: Duration = Duration::from_secs(5);
fn launch() -> Launch {
    Launch {
        executable: PathBuf::from(env!("CARGO_BIN_EXE_fixture-adapter")),
        arguments: vec![],
        directory: std::env::current_dir().unwrap(),
    }
}
struct Evidence(Vec<OwnedHandle>);
impl Evidence {
    fn capture(pids: &[u32]) -> Self {
        assert_eq!(pids.len(), 3); // adapter, child, grandchild
        assert!(pids.iter().all(|pid| *pid != std::process::id()));
        Self(
            pids.iter()
                .map(|pid| {
                    // Handles pin identity and cannot accidentally refer to a reused PID later.
                    let handle =
                        unsafe { OpenProcess(PROCESS_SYNCHRONIZE | PROCESS_TERMINATE, 0, *pid) };
                    assert!(
                        !handle.is_null(),
                        "fixture process {pid} missing: {}",
                        std::io::Error::last_os_error()
                    );
                    unsafe { OwnedHandle::from_raw_handle(handle) }
                })
                .collect(),
        )
    }
    fn exited(&self) -> bool {
        self.0.iter().all(
            |handle| unsafe { WaitForSingleObject(handle.as_raw_handle(), 0) } == WAIT_OBJECT_0,
        )
    }
    fn running(&self) -> bool {
        self.0
            .iter()
            .all(|handle| unsafe { WaitForSingleObject(handle.as_raw_handle(), 0) } == WAIT_TIMEOUT)
    }
    async fn wait(&self) {
        tokio::time::timeout(DEADLINE, async {
            while !self.exited() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("adapter descendants survived cleanup");
    }
}
impl Drop for Evidence {
    fn drop(&mut self) {
        // Failure cleanup is restricted to handles opened for our own fixture tree.
        for handle in &self.0 {
            unsafe {
                if WaitForSingleObject(handle.as_raw_handle(), 0) == WAIT_TIMEOUT {
                    TerminateProcess(handle.as_raw_handle(), 1);
                }
            }
        }
    }
}
async fn tree(adapter: &AdapterProcess) -> Evidence {
    let pids: Vec<u32> = serde_json::from_value(
        adapter
            .call("acme.spawnTree", Value::Null, DEADLINE)
            .await
            .unwrap(),
    )
    .unwrap();
    Evidence::capture(&pids)
}
async fn written_pids(path: &Path) -> Vec<u32> {
    tokio::time::timeout(DEADLINE, async {
        loop {
            if let Ok(bytes) = std::fs::read(path) {
                if let Ok(pids) = serde_json::from_slice(&bytes) {
                    return pids;
                }
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("fixture tree never became ready")
}

#[tokio::test]
async fn close_drop_crash_and_protocol_failure_stop_only_the_owned_tree() {
    for reason in ["close", "drop", "acme.crash", "acme.malformed"] {
        let first = AdapterProcess::launch(launch(), Value::Null, DEADLINE)
            .await
            .unwrap();
        let survivor = AdapterProcess::launch(launch(), Value::Null, DEADLINE)
            .await
            .unwrap();
        let owned = tree(&first).await;
        let other = tree(&survivor).await;
        assert!(owned.running() && other.running());
        match reason {
            "drop" => drop(first),
            "close" => {
                first.close().await.unwrap();
                assert!(
                    owned.exited(),
                    "{reason} returned before the owned tree exited"
                );
            }
            method => {
                assert!(first.call(method, Value::Null, DEADLINE).await.is_err());
                first.close().await.unwrap();
                assert!(
                    owned.exited(),
                    "{reason} returned before the owned tree exited"
                );
            }
        }
        owned.wait().await;
        assert!(other.running());
        assert_eq!(
            survivor
                .call("acme.echo", json!("surviving generation"), DEADLINE)
                .await
                .unwrap(),
            "surviving generation"
        );
        survivor.close().await.unwrap();
        assert!(other.exited());
    }
}

#[tokio::test]
async fn canceled_and_rejected_initialization_release_already_spawned_helpers() {
    for cancel in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let ready = directory.path().join("ready.json");
        let gate = directory.path().join("continue");
        let config = json!({"treeReadyFile":ready,"treeGateFile":gate,"protocol":999});
        let pending = tokio::spawn(AdapterProcess::launch(
            launch(),
            config,
            Duration::from_secs(10),
        ));
        let owned = Evidence::capture(&written_pids(&ready).await);
        assert!(owned.running());
        if cancel {
            pending.abort();
            assert!(matches!(pending.await, Err(error) if error.is_cancelled()));
        } else {
            std::fs::write(gate, b"continue").unwrap();
            assert!(pending.await.unwrap().is_err());
            assert!(owned.exited());
        }
        owned.wait().await;
    }
}

#[tokio::test]
async fn terminating_the_supervisor_process_closes_its_job_and_descendants() {
    let directory = tempfile::tempdir().unwrap();
    let ready = directory.path().join("ready.json");
    let mut supervisor = tokio::process::Command::new(env!("CARGO_BIN_EXE_fixture-adapter"))
        .arg("--tree-owner")
        .arg(&ready)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(0x08000000)
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let owned = Evidence::capture(&written_pids(&ready).await);
    assert!(owned.running());
    supervisor.kill().await.unwrap();
    owned.wait().await;
}
