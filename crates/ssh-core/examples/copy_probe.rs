// SPDX-License-Identifier: MPL-2.0
// Writes only within a newly owned UUID directory and removes it after the probe.
use anyhow::{ensure, Context, Result};
use shellcanvas_core::*;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

async fn verify(service: Arc<SftpTextFiles>, entry: &FileEntry, size: usize) -> Result<()> {
    let mut reader = service.download(&entry.path, &entry.revision).await?;
    let mut offset = 0;
    loop {
        let bytes = reader.read().await?;
        if bytes.is_empty() {
            break;
        }
        ensure!(
            bytes
                .iter()
                .enumerate()
                .all(|(i, byte)| *byte == ((offset + i) % 251) as u8),
            "Copy bytes differ"
        );
        offset += bytes.len();
    }
    ensure!(offset == size, "Wrong file size");
    reader.finish().await
}
#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<_> = std::env::args().collect();
    ensure!(args.len() == 4, "Usage: copy_probe HOST USER KEY_PATH");
    let connection = Connection::connect(ConnectOptions {
        host: args[1].clone(),
        port: 22,
        username: args[2].clone(),
        key_path: args[3].clone(),
        password: None,
        passphrase: None,
    })
    .await?;
    let service = Arc::new(connection.text_files().await?);
    let fs = SftpFileSystem(connection.sftp().await?);
    let root = service
        .make_directory(
            "/tmp",
            &format!("shellcanvas-copy-{}", uuid::Uuid::new_v4()),
        )
        .await?;
    ensure!(
        root.starts_with("/tmp/shellcanvas-copy-") && !root[5..].contains('/'),
        "Unexpected disposable root"
    );
    println!("Owned copy fixture: {root}");
    let result: Result<()> = async {
        let destination = service.make_directory(&root, "destination").await?;
        let size = 1024 * 1024 + 7;
        let mut writer = service.clone().upload(&root, "binary ' 🌍.bin", size as u64).await?;
        let mut offset = 0;
        while offset < size {
            let end = (offset + TRANSFER_CHUNK).min(size);
            writer.write(&(offset..end).map(|i| (i % 251) as u8).collect::<Vec<_>>()).await?;
            offset = end;
        }
        let original = writer.finish().await?;
        let source = fs.list(Some(&root)).await?.entries.into_iter().find(|entry| entry.path == original.path).context("Source missing")?;
        let copy = copy_regular_file(service.clone(), &source.path, &source.revision, &destination, &source.name, || false, &mut |_| {}).await?;
        let copied = fs.list(Some(&destination)).await?.entries.into_iter().find(|entry| entry.path == copy.path).context("Copy missing")?;
        verify(service.clone(), &copied, size).await?;
        verify(service.clone(), &source, size).await?;
        ensure!(copy_regular_file(service.clone(), &source.path, &source.revision, &destination, &source.name, || false, &mut |_| {}).await.is_err(), "Copy overwrote an existing target");
        verify(service.clone(), &copied, size).await?;
        let canceled = AtomicBool::new(false);
        ensure!(copy_regular_file(service.clone(), &source.path, &source.revision, &destination, "canceled.bin", || canceled.load(Ordering::SeqCst), &mut |event| { if event.bytes > 0 { canceled.store(true, Ordering::SeqCst); } }).await.is_err(), "Cancellation ignored");
        ensure!(copy_regular_file(service.clone(), &source.path, "stale", &destination, "stale.bin", || false, &mut |_| {}).await.is_err(), "Stale source accepted");
        let remaining = fs.list(Some(&destination)).await?;
        ensure!(remaining.entries.len() == 1 && remaining.entries[0].path == copy.path, "Canceled/stale copy left temporary data");
        println!("1 MiB binary copy, source preservation, collision refusal, cancellation and stale revision: OK");
        Ok(())
    }.await;
    let cleanup: Result<()> = async {
        for entry in fs.list(Some(&root)).await?.entries {
            ensure!(
                entry.path.starts_with(&format!("{root}/")),
                "Unexpected cleanup location"
            );
            if entry.kind == "directory" {
                ensure!(entry.name == "destination", "Unexpected nested directory");
                for child in fs.list(Some(&entry.path)).await?.entries {
                    ensure!(
                        child.path.starts_with(&format!("{}/", entry.path))
                            && child.kind != "directory",
                        "Unexpected nested cleanup target"
                    );
                    service.remove_entry(&child.path, &child.revision).await?;
                }
                let fresh = fs
                    .list(Some(&root))
                    .await?
                    .entries
                    .into_iter()
                    .find(|item| item.path == entry.path)
                    .context("Directory missing")?;
                service.remove_entry(&fresh.path, &fresh.revision).await?;
            } else {
                service.remove_entry(&entry.path, &entry.revision).await?;
            }
        }
        let fresh = fs
            .list(Some("/tmp"))
            .await?
            .entries
            .into_iter()
            .find(|entry| entry.path == root)
            .context("Root missing")?;
        service.remove_entry(&fresh.path, &fresh.revision).await?;
        ensure!(
            !fs.list(Some("/tmp"))
                .await?
                .entries
                .iter()
                .any(|entry| entry.path == root),
            "Cleanup incomplete"
        );
        Ok(())
    }
    .await;
    connection.disconnect().await?;
    cleanup.with_context(|| format!("Cleanup failed for {root}"))?;
    println!("Owned files and directories removed: OK");
    result
}
