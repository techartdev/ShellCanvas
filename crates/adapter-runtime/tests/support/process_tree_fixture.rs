// SPDX-License-Identifier: MPL-2.0
//! Deliberately leaves helper lifetime to the host job; never starts external tools.
use std::{io::Write, process::Stdio};
use tokio::{io::AsyncBufReadExt, process::Command};

fn command(mode: &str) -> Command {
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .arg(mode)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    command.creation_flags(0x08000000); // Hidden helper; still inherits the adapter job.
    command
}
pub async fn helper_mode() -> bool {
    match std::env::args().nth(1).as_deref() {
        Some("--tree-leaf") => {
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
            true
        }
        Some("--tree-branch") => {
            let mut leaf = command("--tree-leaf").spawn().unwrap();
            println!(
                "{}",
                serde_json::json!([std::process::id(), leaf.id().unwrap()])
            );
            std::io::stdout().flush().unwrap();
            // A failed test still has a short-lived fixture rather than an immortal helper.
            let _ = leaf.wait().await;
            true
        }
        Some("--tree-owner") => {
            use shellcanvas_adapter_runtime::{AdapterProcess, Launch};
            let output = std::env::args_os().nth(2).unwrap();
            let adapter = AdapterProcess::launch(
                Launch {
                    executable: std::env::current_exe().unwrap(),
                    arguments: vec![],
                    directory: std::env::current_dir().unwrap(),
                },
                serde_json::Value::Null,
                std::time::Duration::from_secs(4),
            )
            .await
            .unwrap();
            let pids = adapter
                .call(
                    "acme.spawnTree",
                    serde_json::Value::Null,
                    std::time::Duration::from_secs(4),
                )
                .await
                .unwrap();
            std::fs::write(output, serde_json::to_vec(&pids).unwrap()).unwrap();
            std::future::pending::<()>().await;
            true
        }
        _ => false,
    }
}
pub async fn spawn_tree() -> Vec<u32> {
    let mut branch = command("--tree-branch")
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let output = branch.stdout.take().unwrap();
    let mut line = String::new();
    tokio::io::BufReader::new(output)
        .read_line(&mut line)
        .await
        .unwrap();
    let mut pids: Vec<u32> = serde_json::from_str(&line).unwrap();
    assert_eq!(pids[0], branch.id().unwrap());
    pids.insert(0, std::process::id());
    // Dropping a Tokio child with kill_on_drop=false intentionally leaves it running.
    drop(branch);
    pids
}
