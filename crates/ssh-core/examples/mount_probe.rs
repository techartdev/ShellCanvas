// SPDX-License-Identifier: MPL-2.0
//! Opt-in SFTP mounted-file contract acceptance. Touches only a fresh UUID tree.
use anyhow::{ensure, Result};
use shellcanvas_core::*;
use std::{path::PathBuf, sync::Arc};

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<_> = std::env::args().collect();
    ensure!(
        args.len() == 5,
        "Usage: mount_probe HOST USER KEY_PATH ADDITIONAL_KNOWN_HOSTS"
    );
    ensure!(
        std::env::var("SHELLCANVAS_LIVE_MOUNT_PROBE").as_deref() == Ok("1"),
        "Set SHELLCANVAS_LIVE_MOUNT_PROBE=1 to authorize a disposable remote directory"
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
    let browser = SshFileBrowser::new(Arc::new(SftpBrowser(service.clone())), connection.clone());
    let root = service
        .make_directory(
            "/tmp",
            &format!("shellcanvas-mount-{}", uuid::Uuid::new_v4()),
        )
        .await?;
    println!("Created disposable root: {root}");
    let fs = browser.mount_root(&root, true).await?;
    let result: Result<()> = async {
        let path = MountPath::root().child("資料 ' data.bin")?;
        let create = FsOpenOptions {
            read: true,
            write: true,
            create: FsCreate::CreateNew,
            truncate: false,
        };
        // Windows applies initial read-only attributes after exclusive OPEN,
        // while the creating handle still has permission to write its content.
        let attributes_path = MountPath::root().child("creation-attributes.txt")?;
        let attributes_file = fs.open(&attributes_path, create).await?;
        attributes_file.set_metadata(FsSetMetadata {
            permissions: Some(0o444), ..Default::default()
        }).await?;
        attributes_file.write_at(0, b"initial readonly contents").await?;
        attributes_file.flush().await?;
        ensure!(attributes_file.read_at(0, 32).await? == b"initial readonly contents",
            "Read-only creation lost the original handle's write access");
        ensure!(attributes_file.metadata().await?.permissions.unwrap_or(0) & 0o777 == 0o444,
            "Initial readonly permissions were not persisted");
        attributes_file.set_metadata(FsSetMetadata {
            size: Some(0), permissions: Some(0o444), ..Default::default()
        }).await?;
        attributes_file.write_at(0, b"replacement").await?;
        attributes_file.flush().await?;
        ensure!(attributes_file.read_at(0, 32).await? == b"replacement",
            "Combined truncate/readonly overwrite did not preserve the handle");
        attributes_file.close().await?;
        fs.remove(&attributes_path, false).await?;
        println!("SFTP_CREATION_ATTRIBUTES_PASS: initial read-only and combined truncate/permissions preserve the original writable handle");
        let file = fs.open(&path, create).await?;
        ensure!(
            fs.open(&path, create).await.is_err(),
            "Exclusive create replaced a file"
        );
        file.write_at(0, b"begin").await?;
        // More than 4 GiB exercises 64-bit offsets without a huge transfer.
        let offset = (1_u64 << 32) + 19;
        file.write_at(offset, b"end").await?;
        file.flush().await?;
        ensure!(
            file.metadata().await?.size == offset + 3,
            "Incorrect large-file size"
        );
        ensure!(
            file.read_at(offset, 3).await? == b"end",
            "Seeked read differs"
        );
        ensure!(
            file.read_at(0, 5).await? == b"begin",
            "Initial bytes differ"
        );
        ensure!(
            file.read_at(offset + 3, 20).await?.is_empty(),
            "EOF differs"
        );
        file.set_metadata(FsSetMetadata {
            size: Some(5),
            ..Default::default()
        })
        .await?;
        ensure!(file.metadata().await?.size == 5, "Truncate failed");
        let reader = fs
            .open(
                &path,
                FsOpenOptions {
                    read: true,
                    write: false,
                    create: FsCreate::OpenExisting,
                    truncate: false,
                },
            )
            .await?;
        ensure!(
            reader.write_at(0, b"x").await.is_err(),
            "Read handle permitted write"
        );
        reader.set_metadata(FsSetMetadata {
            permissions: Some(0o444),
            ..Default::default()
        }).await?;
        ensure!(reader.metadata().await?.permissions.unwrap_or(0) & 0o777 == 0o444,
            "Read handle could not change permissions within writable root");
        reader.set_metadata(FsSetMetadata {
            permissions: Some(0o644),
            ..Default::default()
        }).await?;
        ensure!(reader.metadata().await?.permissions.unwrap_or(0) & 0o777 == 0o644,
            "Read handle could not restore owner write permission");
        ensure!(reader.set_metadata(FsSetMetadata { size: Some(0), ..Default::default() }).await.is_err(),
            "Read handle permitted truncation");
        ensure!(reader.metadata().await?.size == 5, "Rejected truncation changed file size");
        let previous_access = reader.metadata().await?.accessed;
        reader.set_metadata(FsSetMetadata { modified: Some(1_600_000_123), ..Default::default() }).await?;
        let times = reader.metadata().await?;
        ensure!(times.modified == Some(1_600_000_123) && times.accessed == previous_access,
            "Single-field modification-time update changed access time");
        reader.set_metadata(FsSetMetadata { accessed: Some(1_600_000_000), ..Default::default() }).await?;
        let times = reader.metadata().await?;
        ensure!(times.accessed == Some(1_600_000_000) && times.modified == Some(1_600_000_123),
            "Single-field access-time update changed modification time");
        ensure!(reader.set_metadata(FsSetMetadata {
            modified: Some(u64::from(u32::MAX) + 1), permissions: Some(0o444), ..Default::default()
        }).await.is_err(), "SFTP v3 accepted an out-of-range timestamp");
        let unchanged = reader.metadata().await?;
        ensure!(unchanged.modified == times.modified && unchanged.accessed == times.accessed
            && unchanged.permissions == times.permissions, "Rejected timestamp request partially changed metadata");
        println!("SFTP_TIMES_PASS: single-field updates preserve the other timestamp; out-of-range mixed update has no partial effects");
        let temp = MountPath::root().child("save.tmp")?;
        let save = fs.open(&temp, create).await?;
        save.write_at(0, b"saved").await?;
        save.flush().await?;
        save.close().await?;
        fs.rename(&temp, &path, true).await?;
        ensure!(
            reader.read_at(0, 5).await? == b"begin",
            "Rename retargeted an open handle"
        );
        let saved = fs
            .open(
                &path,
                FsOpenOptions {
                    read: true,
                    write: false,
                    create: FsCreate::OpenExisting,
                    truncate: false,
                },
            )
            .await?;
        ensure!(
            saved.read_at(0, 5).await? == b"saved",
            "Atomic save bytes differ"
        );
        saved.close().await?;
        reader.close().await?;
        file.close().await?;
        ensure!(
            file.read_at(0, 1).await.is_err(),
            "Closed handle stayed usable"
        );
        let readonly = browser.mount_root(&root, false).await?;
        let readonly_file = readonly.open(&path, FsOpenOptions {
            read: true, write: false, create: FsCreate::OpenExisting, truncate: false,
        }).await?;
        ensure!(readonly_file.set_metadata(FsSetMetadata {
            permissions: Some(0o777), ..Default::default()
        }).await.is_err(), "Read-only mount accepted metadata changes through a handle");
        readonly_file.close().await?;
        ensure!(
            readonly.open(&path, create).await.is_err(),
            "Read-only mount accepted writable open"
        );
        ensure!(
            readonly.remove(&path, false).await.is_err(),
            "Read-only mount removed a file"
        );
        ensure!(
            fs.remove(&MountPath::root(), true).await.is_err(),
            "Root was removable"
        );
        let dir = MountPath::root().child("subfolder")?;
        fs.mkdir(&dir).await?;
        let mut listing = fs.open_directory(&MountPath::root()).await?;
        let mut names = vec![];
        loop {
            let page = listing.next().await?;
            if page.is_empty() {
                break;
            }
            names.extend(page.into_iter().map(|e| e.name));
        }
        listing.close().await?;
        ensure!(
            names.len() == 2 && names.contains(&"subfolder".into()),
            "Directory enumeration differs"
        );
        fs.remove(&dir, true).await?;
        fs.remove(&path, false).await?;
        Ok(())
    }
    .await;
    // The checked mutation service removes only the UUID root created above.
    let listing = browser.list(Some("/tmp")).await?;
    if let Some(entry) = listing.entries.iter().find(|entry| entry.path == root) {
        service.remove_entry(&root, &entry.revision).await?;
    }
    connection.disconnect().await?;
    result?;
    println!("PASS: >4 GiB offsets, truncate, EOF, concurrent handles, atomic replacement, read-only enforcement, directory enumeration, close and cleanup");
    Ok(())
}
