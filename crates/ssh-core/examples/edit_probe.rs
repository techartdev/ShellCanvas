// SPDX-License-Identifier: MPL-2.0
//! Writes only inside a newly-created /tmp/shellcanvas-editor-UUID directory.
use anyhow::{ensure, Context, Result};
use shellcanvas_core::{ConnectOptions, Connection, TextFileService, TEXT_LIMIT};
use tokio::io::AsyncWriteExt;

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    ensure!(args.len() == 3, "Usage: edit_probe HOST USER KEY_PATH");
    let connection = Connection::connect(ConnectOptions {
        host: args[0].clone(),
        username: args[1].clone(),
        key_path: args[2].clone(),
        port: 22,
        password: None,
        allow_legacy_mac: false,
        passphrase: None,
    })
    .await?;
    let sftp = connection.sftp().await?;
    let editor = connection.text_files().await?;
    ensure!(
        editor.can_save(),
        "Atomic text saves are unavailable on this server"
    );
    let dir = format!("/tmp/shellcanvas-editor-{}", uuid::Uuid::new_v4());
    sftp.create_dir(&dir).await?;
    let path = format!("{dir}/editable.txt");
    let sibling = format!("{dir}/untouched.txt");
    let binary = format!("{dir}/binary.dat");
    let result: Result<()> = async {
        let mut file = sftp.create(&path).await?;
        file.write_all("Original 🌍\r\n".as_bytes()).await?;
        file.shutdown().await?;
        let metadata = sftp.metadata(&path).await?;
        let mut file = sftp.create(&sibling).await?;
        file.write_all(b"untouched").await?;
        file.shutdown().await?;
        let original = editor.read_text(&path).await?;
        ensure!(
            original.text == "Original 🌍\r\n",
            "Unicode/CRLF read failed"
        );
        let saved = editor
            .save_text(&original.path, "Updated 🌍\r\n", &original.revision)
            .await?;
        ensure!(
            editor.read_text(&path).await?.text == saved.text,
            "Save did not roundtrip"
        );
        let after = sftp.metadata(&path).await?;
        ensure!(
            metadata.permissions == after.permissions
                && metadata.uid == after.uid
                && metadata.gid == after.gid,
            "Basic metadata was not preserved"
        );
        let conflict = editor.save_text(&path, "stale", &original.revision).await;
        ensure!(
            conflict.is_err_and(|e| e.to_string().contains("CONFLICT")),
            "Stale save was not rejected"
        );
        let mut file = sftp.create(&path).await?;
        file.write_all(b"external edit").await?;
        file.shutdown().await?;
        ensure!(
            editor
                .save_text(&path, "overwrite", &saved.revision)
                .await
                .is_err(),
            "External edit was overwritten"
        );
        let latest = editor.read_text(&path).await?;
        let (a, b) = tokio::join!(
            editor.save_text(&path, "writer A", &latest.revision),
            editor.save_text(&path, "writer B", &latest.revision)
        );
        ensure!(
            usize::from(a.is_ok()) + usize::from(b.is_ok()) == 1,
            "Concurrent stale writes both committed"
        );
        let mut file = sftp.create(&binary).await?;
        file.write_all(b"binary\0content").await?;
        file.shutdown().await?;
        ensure!(
            editor.read_text(&binary).await.is_err(),
            "Binary file was accepted"
        );
        let mut file = sftp.create(&binary).await?;
        file.write_all(&vec![b'x'; TEXT_LIMIT + 1]).await?;
        file.shutdown().await?;
        ensure!(
            editor.read_text(&binary).await.is_err(),
            "Oversized file was accepted"
        );
        ensure!(
            sftp.read(&sibling).await? == b"untouched",
            "Sibling file changed"
        );
        ensure!(
            sftp.read_dir(&dir)
                .await?
                .all(|entry| !entry.file_name().starts_with(".shellcanvas-save-")),
            "Temporary save file remained"
        );
        Ok(())
    }
    .await;
    for file in [&path, &sibling, &binary] {
        let _ = sftp.remove_file(file).await;
    }
    sftp.remove_dir(&dir).await.context(format!(
        "Disposable editor test directory needs cleanup: {dir}"
    ))?;
    connection.disconnect().await?;
    result?;
    println!("Editor probe passed: Unicode/CRLF, atomic save, metadata, stale/external/concurrent conflicts, binary/size bounds, sibling isolation, cleanup.");
    Ok(())
}
