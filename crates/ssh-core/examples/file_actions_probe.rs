// SPDX-License-Identifier: MPL-2.0
//! Mutates only a newly-created /tmp/shellcanvas-files-UUID directory.
use anyhow::{ensure, Context, Result};
use shellcanvas_core::{
    ConnectOptions, Connection, FileMutationService, FileSystemProvider, SftpFileSystem,
    TextFileService,
};
use tokio::io::AsyncWriteExt;

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    ensure!(
        args.len() == 3,
        "Usage: file_actions_probe HOST USER KEY_PATH"
    );
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
    let fs = SftpFileSystem(connection.sftp().await?);
    let actions = connection.text_files().await?;
    let other = connection.text_files().await?;
    let dir = format!("/tmp/shellcanvas-files-{}", uuid::Uuid::new_v4());
    fs.0.create_dir(&dir).await?;
    let folder = format!("{dir}/folder");
    let original = format!("{dir}/draft.txt");
    let renamed = format!("{dir}/renamed '🌍'.txt");
    let sibling = format!("{dir}/untouched.txt");
    let race = format!("{dir}/race.txt");
    let link = format!("{dir}/link");
    let child = format!("{folder}/child.txt");
    let result: Result<()> = async {
        let saved = actions
            .create_text(&dir, "draft.txt", "Draft 🌍\r\n")
            .await?;
        ensure!(
            saved.path == original && saved.text == "Draft 🌍\r\n",
            "New text did not roundtrip"
        );
        ensure!(
            fs.0.metadata(&original).await?.permissions.unwrap_or(0) & 0o777 == 0o600,
            "New file mode was not private"
        );
        actions
            .create_text(&dir, "untouched.txt", "sentinel")
            .await?;
        ensure!(
            actions
                .create_text(&dir, "draft.txt", "overwrite")
                .await
                .is_err(),
            "Existing file was replaced"
        );
        ensure!(
            fs.0.read(&original).await? == "Draft 🌍\r\n".as_bytes(),
            "Original changed after duplicate create"
        );
        let (a, b) = tokio::join!(
            actions.create_text(&dir, "race.txt", "writer A"),
            other.create_text(&dir, "race.txt", "writer B")
        );
        ensure!(
            usize::from(a.is_ok()) + usize::from(b.is_ok()) == 1,
            "Concurrent create did not pick exactly one winner"
        );
        actions.make_directory(&dir, "folder").await?;
        ensure!(
            actions.make_directory(&dir, "folder").await.is_err(),
            "Duplicate folder accepted"
        );
        actions
            .create_text(&folder, "child.txt", "keep child")
            .await?;
        let listing = fs.list(Some(&dir)).await?;
        let folder_entry = listing
            .entries
            .iter()
            .find(|e| e.path == folder)
            .context("Folder missing")?;
        ensure!(
            actions
                .remove_entry(&folder, &folder_entry.revision)
                .await
                .is_err(),
            "Nonempty folder was removed"
        );
        let entry = listing
            .entries
            .iter()
            .find(|e| e.path == original)
            .context("Created file missing")?;
        ensure!(
            actions
                .rename_entry(&original, "untouched.txt", &entry.revision)
                .await
                .is_err(),
            "Rename replaced a sibling"
        );
        let relocation = actions
            .rename_tracked(
                &original,
                "renamed '🌍'.txt",
                &entry.revision,
                std::slice::from_ref(&original),
            )
            .await?;
        ensure!(
            relocation.path == renamed
                && relocation.locations.len() == 1
                && relocation.locations[0].location.name == "renamed '🌍'.txt"
                && fs.0.read(&renamed).await? == saved.text.as_bytes(),
            "Rename failed"
        );
        let stale = fs
            .list(Some(&dir))
            .await?
            .entries
            .into_iter()
            .find(|e| e.path == renamed)
            .context("Renamed file missing")?;
        let mut external = fs.0.create(&renamed).await?;
        external
            .write_all(b"external change with different size")
            .await?;
        external.shutdown().await?;
        ensure!(
            actions
                .remove_entry(&renamed, &stale.revision)
                .await
                .is_err(),
            "Stale delete accepted"
        );
        ensure!(
            actions
                .rename_entry(&renamed, "other.txt", &stale.revision)
                .await
                .is_err(),
            "Stale rename accepted"
        );
        // OpenSSH's wire ordering is target first, new link second.
        fs.0.symlink(&sibling, &link).await?;
        let link_entry = fs
            .list(Some(&dir))
            .await?
            .entries
            .into_iter()
            .find(|e| e.path == link)
            .context("Link missing")?;
        ensure!(link_entry.kind == "symlink", "Link type was not preserved");
        actions.remove_entry(&link, &link_entry.revision).await?;
        ensure!(
            fs.0.read(&sibling).await? == b"sentinel",
            "Symlink target changed"
        );
        for invalid in ["..", "child/other", "bad\nname"] {
            ensure!(
                actions.make_directory(&dir, invalid).await.is_err(),
                "Invalid name accepted"
            );
        }
        let child_entry = fs
            .list(Some(&folder))
            .await?
            .entries
            .into_iter()
            .next()
            .context("Child missing")?;
        actions.remove_entry(&child, &child_entry.revision).await?;
        let folder_entry = fs
            .list(Some(&dir))
            .await?
            .entries
            .into_iter()
            .find(|e| e.path == folder)
            .context("Folder missing")?;
        actions
            .remove_entry(&folder, &folder_entry.revision)
            .await?;
        ensure!(
            fs.0.read_dir(&dir)
                .await?
                .all(|e| !e.file_name().starts_with(".shellcanvas-save-")),
            "Temporary files remain"
        );
        Ok(())
    }
    .await;
    // Exact disposable paths only; never recurse into an unexpected directory.
    for path in [&original, &renamed, &sibling, &race, &link, &child] {
        let _ = fs.0.remove_file(path).await;
    }
    let _ = fs.0.remove_dir(&folder).await;
    fs.0.remove_dir(&dir)
        .await
        .context(format!("Disposable test directory needs inspection: {dir}"))?;
    connection.disconnect().await?;
    result?;
    println!("File actions probe passed: create/duplicate/concurrent creation, private new-file mode, rename, stale checks, nonempty-folder refusal, symlink isolation, invalid names and cleanup.");
    Ok(())
}
