// SPDX-License-Identifier: MPL-2.0
//! Permission checks inside one newly-created disposable /tmp directory.
//! Requires root plus existing nobody/runuser/OpenSSH SFTP server; creates no accounts.
use anyhow::{bail, ensure, Context, Result};
use russh::{client, Channel, ChannelMsg};
use russh_sftp::{
    client::{error::Error as SftpError, RawSftpSession, SftpSession},
    protocol::{FileAttributes, StatusCode},
};
use shellcanvas_core::*;
use std::sync::Arc;

async fn unprivileged(connection: &Connection) -> Result<Channel<client::Msg>> {
    tokio::time::timeout(OP_TIMEOUT, async {
        let mut channel = connection.handle.channel_open_session().await?;
        channel
            .exec(
                true,
                "cd /tmp && exec /usr/sbin/runuser -u nobody -- /usr/lib/openssh/sftp-server",
            )
            .await?;
        while let Some(message) = channel.wait().await {
            match message {
                ChannelMsg::Success => return Ok(channel),
                ChannelMsg::Failure | ChannelMsg::Close => {
                    bail!("Unprivileged SFTP process was rejected")
                }
                _ => {}
            }
        }
        bail!("Unprivileged SFTP process closed")
    })
    .await?
}
fn denied<T>(result: Result<T>, operation: &str) -> Result<()> {
    match result {
        Ok(_) => bail!("{operation} unexpectedly succeeded"),
        Err(error) => {
            ensure!(error.chain().any(|cause| matches!(cause.downcast_ref::<SftpError>(), Some(SftpError::Status(s)) if s.status_code == StatusCode::PermissionDenied)),
                "{operation} failed for a reason other than permission denial: {error:#}");
            Ok(())
        }
    }
}
async fn entry(fs: &SftpFileSystem, parent: &str, name: &str) -> Result<FileEntry> {
    fs.list(Some(parent))
        .await?
        .entries
        .into_iter()
        .find(|e| e.name == name)
        .context("Fixture file missing")
}

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    ensure!(
        args.len() == 4,
        "Usage: permission_probe HOST USER KEY_PATH"
    );
    let connection = Connection::connect(ConnectOptions {
        host: args[1].clone(),
        port: 22,
        username: args[2].clone(),
        key_path: args[3].clone(),
        password: None,
        passphrase: None,
    })
    .await?;
    ensure!(
        connection.exec_readonly("id -u").await? == "0",
        "Fixture setup requires the authorized root account"
    );
    let uid: u32 = connection.exec_readonly("id -u nobody").await?.parse()?;
    let gid: u32 = connection.exec_readonly("id -g nobody").await?.parse()?;
    ensure!(uid != 0, "The test identity must be unprivileged");
    connection
        .exec_readonly("test -x /usr/sbin/runuser && test -x /usr/lib/openssh/sftp-server")
        .await?;
    let root_fs = SftpFileSystem(connection.sftp().await?);
    let root_service = connection.text_files().await?;
    let fs =
        SftpFileSystem(SftpSession::new(unprivileged(&connection).await?.into_stream()).await?);
    let service = Arc::new(
        SftpTextFiles::new(RawSftpSession::new(
            unprivileged(&connection).await?.into_stream(),
        ))
        .await?,
    );
    let dir = root_service
        .make_directory(
            "/tmp",
            &format!("shellcanvas-permissions-{}", uuid::Uuid::new_v4()),
        )
        .await?;
    ensure!(
        dir.starts_with("/tmp/shellcanvas-permissions-") && !dir[5..].contains('/'),
        "Unexpected fixture path"
    );
    let writable = format!("{dir}/writable");
    let public = format!("{dir}/public.txt");
    let private = format!("{dir}/private.txt");
    let result: Result<()> = async {
        root_fs.0.set_metadata(&dir, FileAttributes { permissions: Some(0o755), ..FileAttributes::empty() }).await?;
        root_service.create_text(&dir, "public.txt", "Public fixture\n").await?;
        root_service.create_text(&dir, "private.txt", "Private fixture\n").await?;
        root_fs.0.set_metadata(&public, FileAttributes { permissions: Some(0o644), ..FileAttributes::empty() }).await?;
        root_service.make_directory(&dir, "writable").await?;
        root_fs.0.set_metadata(&writable, FileAttributes { uid: Some(uid), gid: Some(gid), permissions: Some(0o700), ..FileAttributes::empty() }).await?;

        let before = fs.list(Some(&dir)).await?;
        ensure!(before.entries.len() == 3, "Unexpected initial directory contents");
        ensure!(fs.preview(&public).await? == "Public fixture\n", "Public preview failed");
        denied(fs.preview(&private).await, "Private preview")?;
        denied(service.read_text(&private).await, "Private editor read")?;
        let private_entry = entry(&fs, &dir, "private.txt").await?;
        denied(service.clone().download(&private_entry.path, &private_entry.revision).await, "Private download")?;
        denied(service.make_directory(&dir, "denied-folder").await, "Folder creation")?;
        denied(service.create_text(&dir, "denied.txt", "must not exist").await, "Text creation")?;
        let public_document = service.read_text(&public).await?;
        denied(service.save_text(&public, "must not replace", &public_document.revision).await, "Editor save")?;
        let public_entry = entry(&fs, &dir, "public.txt").await?;
        denied(service.rename_entry(&public, "renamed.txt", &public_entry.revision).await, "Rename")?;
        denied(service.remove_entry(&public, &public_entry.revision).await, "Delete")?;
        denied(service.clone().upload(&dir, "denied.bin", 1).await, "Upload")?;
        ensure!(root_fs.0.read(&public).await? == b"Public fixture\n", "Denied operations changed public data");
        ensure!(root_fs.0.read(&private).await? == b"Private fixture\n", "Denied operations changed private data");
        ensure!(root_fs.list(Some(&dir)).await?.entries.len() == 3, "Denied operations left temporary files");
        println!("Unprivileged browsing works; private reads/downloads and denied create/save/rename/delete/upload preserve data");

        let created = service.create_text(&writable, "allowed.txt", "before").await?;
        let saved = service.save_text(&created.path, "after", &created.revision).await?;
        ensure!(saved.text == "after", "Allowed editor save failed after denial");
        let bytes: Vec<u8> = (0..TRANSFER_CHUNK + 7).map(|i| (i % 251) as u8).collect();
        let mut writer = service.clone().upload(&writable, "allowed.bin", bytes.len() as u64).await?;
        for chunk in bytes.chunks(TRANSFER_CHUNK) { writer.write(chunk).await?; }
        writer.finish().await?;
        let uploaded = entry(&fs, &writable, "allowed.bin").await?;
        let mut reader = service.clone().download(&uploaded.path, &uploaded.revision).await?;
        let mut read = Vec::new();
        loop { let chunk = reader.read().await?; if chunk.is_empty() { break; } read.extend(chunk); }
        reader.finish().await?;
        ensure!(read == bytes, "Allowed transfer did not roundtrip after denial");
        let text = entry(&fs, &writable, "allowed.txt").await?;
        service.rename_entry(&text.path, "renamed.txt", &text.revision).await?;
        let renamed = entry(&fs, &writable, "renamed.txt").await?;
        service.remove_entry(&renamed.path, &renamed.revision).await?;
        service.remove_entry(&uploaded.path, &uploaded.revision).await?;
        ensure!(fs.list(Some(&writable)).await?.entries.is_empty(), "Allowed operations left temporary files");
        println!("Same unprivileged services recover: editor save, binary upload/download, rename and removal OK");
        Ok(())
    }.await;
    drop(service);
    let _ = fs.0.close().await;
    // Only known fixture files; fail and report the directory if anything unexpected remains.
    for path in [
        public,
        private,
        format!("{writable}/allowed.txt"),
        format!("{writable}/allowed.bin"),
        format!("{writable}/renamed.txt"),
    ] {
        let _ = root_fs.0.remove_file(path).await;
    }
    let _ = root_fs.0.remove_dir(&writable).await;
    root_fs.0.remove_dir(&dir).await.with_context(|| {
        format!("Inspect the disposable directory before further cleanup: {dir}")
    })?;
    connection.disconnect().await?;
    result?;
    println!("Disposable permission fixture removed; SSH disconnected");
    Ok(())
}
