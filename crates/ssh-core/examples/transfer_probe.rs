// SPDX-License-Identifier: MPL-2.0
// Writes only inside a newly-created UUID directory and removes its own test files.
use anyhow::{ensure, Context, Result};
use sha2::{Digest, Sha256};
use shellcanvas_core::*;
use std::sync::Arc;
#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    ensure!(args.len() == 4, "Usage: transfer_probe HOST USER KEY_PATH");
    let connection = Connection::connect(ConnectOptions {
        host: args[1].clone(),
        port: 22,
        username: args[2].clone(),
        key_path: args[3].clone(),
        password: None,
        allow_legacy_mac: false,
        passphrase: None,
    })
    .await?;
    let service = Arc::new(connection.text_files().await?);
    let fs = SftpFileSystem(connection.sftp().await?);
    let dir = service
        .make_directory(
            "/tmp",
            &format!("shellcanvas-transfers-{}", uuid::Uuid::new_v4()),
        )
        .await?;
    ensure!(
        dir.starts_with("/tmp/shellcanvas-transfers-") && !dir[5..].contains('/'),
        "Unexpected disposable directory"
    );
    println!("Disposable transfer directory created");
    let result: Result<()> = async {
        let size = 8 * 1024 * 1024 + 7;
        let mut upload = service
            .clone()
            .upload(&dir, "binary ' 🌍.bin", size as u64)
            .await?;
        let mut expected = Sha256::new();
        let mut offset = 0;
        while offset < size {
            let count = (size - offset).min(TRANSFER_CHUNK);
            let bytes: Vec<u8> = (offset..offset + count).map(|i| (i % 251) as u8).collect();
            expected.update(&bytes);
            upload.write(&bytes).await?;
            offset += count;
        }
        let location = upload.finish().await?;
        println!("8 MiB binary upload with Unicode/quote name: OK");
        let listing = fs.list(Some(&dir)).await?;
        let entry = listing
            .entries
            .iter()
            .find(|e| e.path == location.path)
            .context("Uploaded file missing")?;
        let mut download = service
            .clone()
            .download(&entry.path, &entry.revision)
            .await?;
        let mut actual = Sha256::new();
        let mut received = 0;
        loop {
            let bytes = download.read().await?;
            if bytes.is_empty() {
                break;
            }
            ensure!(bytes.len() <= TRANSFER_CHUNK, "Unbounded read");
            received += bytes.len();
            actual.update(bytes);
        }
        download.finish().await?;
        ensure!(
            received == size && expected.finalize() == actual.finalize(),
            "Binary checksum mismatch"
        );
        ensure!(
            service
                .clone()
                .upload(&dir, "binary ' 🌍.bin", 1)
                .await
                .is_err(),
            "Existing target accepted"
        );
        ensure!(
            service
                .clone()
                .download(&entry.path, &"0".repeat(64))
                .await
                .is_err(),
            "Stale listing accepted"
        );
        println!("Download checksum, size and stale-listing checks: OK");
        let mut canceled = service
            .clone()
            .upload(&dir, "canceled.bin", size as u64)
            .await?;
        canceled.write(&vec![0; TRANSFER_CHUNK]).await?;
        canceled.abort().await?;
        let mut first = service.clone().upload(&dir, "race.bin", 1).await?;
        let mut second = service.clone().upload(&dir, "race.bin", 1).await?;
        first.write(b"1").await?;
        second.write(b"2").await?;
        first.finish().await?;
        ensure!(
            second.finish().await.is_err(),
            "Concurrent destination was overwritten"
        );
        second.abort().await?;
        let mut empty = service.clone().upload(&dir, "empty.bin", 0).await?;
        empty.finish().await?;
        let listing = fs.list(Some(&dir)).await?;
        ensure!(
            !listing
                .entries
                .iter()
                .any(|e| e.name == "canceled.bin" || e.name.starts_with(".shellcanvas-upload-")),
            "Partial upload remains"
        );
        ensure!(
            listing
                .entries
                .iter()
                .any(|e| e.name == "empty.bin" && e.size == 0),
            "Empty file failed"
        );
        let changing = service.create_text(&dir, "changing.txt", "before").await?;
        let listing = fs.list(Some(&dir)).await?;
        let entry = listing
            .entries
            .iter()
            .find(|e| e.path == changing.path)
            .unwrap();
        let mut reader = service
            .clone()
            .download(&entry.path, &entry.revision)
            .await?;
        reader.read().await?;
        service
            .save_text(&changing.path, "a longer replacement", &changing.revision)
            .await?;
        ensure!(reader.finish().await.is_err(), "Changed source accepted");
        reader.abort().await?;
        println!(
            "Cancellation cleanup, concurrent no-clobber, empty file and changed-source checks: OK"
        );
        Ok(())
    }
    .await;
    let cleanup: Result<()> = async {
        for entry in fs.list(Some(&dir)).await?.entries {
            ensure!(
                entry.path.starts_with(&format!("{dir}/")),
                "Unexpected cleanup path"
            );
            service.remove_entry(&entry.path, &entry.revision).await?;
        }
        let parent = fs.list(Some("/tmp")).await?;
        let entry = parent
            .entries
            .iter()
            .find(|entry| entry.path == dir)
            .context("Disposable folder missing")?;
        service.remove_entry(&entry.path, &entry.revision).await?;
        Ok(())
    }
    .await;
    connection.disconnect().await?;
    cleanup.context("Disposable transfer cleanup failed")?;
    println!("Disposable files and directory removed: OK");
    result
}
