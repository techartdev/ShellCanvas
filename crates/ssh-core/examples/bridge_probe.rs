// SPDX-License-Identifier: MPL-2.0
//! Live anonymous-pipe acceptance using the independently compiled bridge.
use anyhow::{ensure, Context, Result};
use shellcanvas_core::*;
use shellcanvas_filesystem_sdk::wire::Server;
use std::{path::PathBuf, process::Stdio, sync::Arc, time::Duration};
#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<_> = std::env::args().collect();
    ensure!(
        args.len() == 6,
        "Usage: bridge_probe HOST USER KEY_PATH ADDITIONAL_KNOWN_HOSTS BRIDGE_EXECUTABLE"
    );
    ensure!(
        std::env::var("SHELLCANVAS_LIVE_MOUNT_PROBE").as_deref() == Ok("1"),
        "Disposable remote writes require SHELLCANVAS_LIVE_MOUNT_PROBE=1"
    );
    let connection = Arc::new(
        Connection::connect_with_trust_store(
            &ConnectOptions {
                host: args[1].clone(),
                username: args[2].clone(),
                port: 22,
                key_path: args[3].clone(),
                password: std::env::var("SHELLCANVAS_PROBE_PASSWORD").ok(),
                allow_legacy_mac: false,
                passphrase: None,
            },
            PathBuf::from(&args[4]),
        )
        .await?,
    );
    let service = Arc::new(connection.text_files().await?);
    let root = service
        .make_directory(
            "/tmp",
            &format!("shellcanvas-bridge-{}", uuid::Uuid::new_v4()),
        )
        .await?;
    let browser = SshFileBrowser::new(Arc::new(SftpBrowser(service.clone())), connection.clone());
    let result: Result<()> = async {
        let fs = browser.mount_root(&root, true).await?;
        let executable = PathBuf::from(&args[5]).canonicalize()?;
        let mut command = tokio::process::Command::new(executable);
        command
            .arg("--verify-transport")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let mut child = command.spawn()?;
        let reader = child.stdout.take().context("Missing child stdout")?;
        let writer = child.stdin.take().context("Missing child stdin")?;
        let serving = tokio::spawn(Server::new(fs).serve(reader, writer));
        let status = tokio::time::timeout(Duration::from_secs(90), child.wait()).await??;
        let outcome = serving.await?;
        ensure!(status.success(), "Bridge process failed: {status}");
        ensure!(
            outcome.is_err_and(|e| e.kind() == std::io::ErrorKind::UnexpectedEof),
            "Unexpected server termination"
        );
        Ok(())
    }
    .await;
    let entries = browser.list(Some("/tmp")).await?;
    if let Some(entry) = entries.entries.iter().find(|e| e.path == root) {
        service.remove_entry(&root, &entry.revision).await?;
    }
    connection.disconnect().await?;
    result?;
    println!("PASS: separate native bridge -> inherited pipes -> scoped core -> SFTP; disposable root removed");
    Ok(())
}
