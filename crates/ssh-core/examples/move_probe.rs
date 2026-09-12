// SPDX-License-Identifier: MPL-2.0
//! Moves only items created in a new /tmp/shellcanvas-move-UUID directory.
use anyhow::{ensure, Context, Result};
use shellcanvas_core::{
    ConnectOptions, Connection, FileMoveService, FileMutationService, FileSystemProvider,
    SftpFileSystem, TextFileService,
};
use tokio::io::AsyncWriteExt;

async fn revision(fs: &SftpFileSystem, parent: &str, name: &str) -> Result<String> {
    Ok(fs
        .list(Some(parent))
        .await?
        .entries
        .into_iter()
        .find(|item| item.name == name)
        .context("Test item missing")?
        .revision)
}

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    ensure!(args.len() == 3, "Usage: move_probe HOST USER KEY_PATH");
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
    let moves = connection.text_files().await?;
    let dir = format!("/tmp/shellcanvas-move-{}", uuid::Uuid::new_v4());
    fs.0.create_dir(&dir).await?;
    let from = format!("{dir}/from");
    let to = format!("{dir}/to");
    let name = "draft '🌍'.txt";
    let source = format!("{from}/{name}");
    let destination = format!("{to}/{name}");
    let tree = format!("{from}/tree");
    let moved_tree = format!("{to}/tree");
    let link = format!("{from}/link");
    let moved_link = format!("{to}/link");
    let alias = format!("{dir}/tree-alias");
    let result: Result<()> = async {
        moves.make_directory(&dir, "from").await?;
        moves.make_directory(&dir, "to").await?;
        moves.create_text(&from, name, "original 🌍\r\n").await?;
        moves.create_text(&to, name, "destination sentinel").await?;
        let rev = revision(&fs, &from, name).await?;
        ensure!(
            moves.move_entry(&source, &to, &rev).await.is_err(),
            "Move replaced destination"
        );
        ensure!(
            fs.0.read(&source).await? == "original 🌍\r\n".as_bytes(),
            "Source changed on collision"
        );
        ensure!(
            fs.0.read(&destination).await? == b"destination sentinel",
            "Destination changed on collision"
        );
        fs.0.remove_file(&destination).await?;
        ensure!(
            moves.move_entry(&source, &from, &rev).await.is_err(),
            "Same-folder move accepted"
        );
        ensure!(
            moves
                .move_entry(&source, &format!("{to}/missing"), &rev)
                .await
                .is_err(),
            "Missing destination accepted"
        );
        ensure!(
            moves.move_entry(&source, &source, &rev).await.is_err(),
            "File used as destination folder"
        );
        let mut external = fs.0.create(&source).await?;
        external.write_all(b"externally changed content").await?;
        external.shutdown().await?;
        ensure!(
            moves.move_entry(&source, &to, &rev).await.is_err(),
            "Stale move accepted"
        );
        let current = revision(&fs, &from, name).await?;
        let before = fs.0.metadata(&source).await?;
        let open_document = moves.read_text(&source).await?;
        let relocation = moves
            .move_tracked(&source, &to, &current, &[source.clone(), alias.clone()])
            .await?;
        ensure!(
            relocation.path == destination
                && relocation.locations.len() == 1
                && relocation.locations[0].previous == source,
            "Wrong returned destination"
        );
        ensure!(
            relocation.locations[0].location.parent.as_deref() == Some(to.as_str()),
            "Wrong editor parent"
        );
        // A retained editor revision remains usable after location-only changes.
        moves
            .save_text(
                &relocation.locations[0].location.path,
                &open_document.text,
                &open_document.revision,
            )
            .await?;
        ensure!(
            fs.0.symlink_metadata(&source).await.is_err(),
            "Source still exists after move"
        );
        ensure!(
            fs.0.read(&destination).await? == b"externally changed content",
            "Moved content changed"
        );
        let after = fs.0.metadata(&destination).await?;
        ensure!(
            before.permissions == after.permissions
                && before.uid == after.uid
                && before.gid == after.gid,
            "Move changed basic metadata"
        );
        moves.make_directory(&from, "tree").await?;
        moves.create_text(&tree, "child.txt", "keep child").await?;
        fs.0.symlink(&tree, &alias).await?;
        let tree_rev = revision(&fs, &from, "tree").await?;
        ensure!(
            moves.move_entry(&tree, &tree, &tree_rev).await.is_err(),
            "Folder moved into itself"
        );
        ensure!(
            moves.move_entry(&tree, &alias, &tree_rev).await.is_err(),
            "Aliased self destination accepted"
        );
        moves.make_directory(&tree, "nested").await?;
        let tree_rev = revision(&fs, &from, "tree").await?;
        ensure!(
            moves
                .move_entry(&tree, &format!("{tree}/nested"), &tree_rev)
                .await
                .is_err(),
            "Folder moved into a child"
        );
        let child = moves.read_text(&format!("{tree}/child.txt")).await?;
        let relocation = moves
            .move_tracked(
                &tree,
                &to,
                &tree_rev,
                &[
                    child.path.clone(),
                    tree.clone(),
                    format!("{tree}s/unrelated"),
                ],
            )
            .await?;
        ensure!(
            relocation.path == moved_tree && relocation.locations.len() == 2,
            "Folder move failed"
        );
        ensure!(
            relocation.locations[0].location.path == format!("{moved_tree}/child.txt"),
            "Descendant editor did not follow folder move"
        );
        moves
            .save_text(
                &relocation.locations[0].location.path,
                &child.text,
                &child.revision,
            )
            .await?;
        ensure!(
            fs.0.read(format!("{moved_tree}/child.txt")).await? == b"keep child",
            "Folder child lost"
        );
        // Move the link itself; never follow or rewrite its target.
        fs.0.symlink(&destination, &link).await?;
        let link_rev = revision(&fs, &from, "link").await?;
        moves.move_entry(&link, &to, &link_rev).await?;
        ensure!(
            fs.0.symlink_metadata(&moved_link).await?.is_symlink(),
            "Moved symlink changed type"
        );
        ensure!(
            fs.0.read(&moved_link).await? == b"externally changed content",
            "Symlink target changed"
        );
        ensure!(
            fs.0.read_dir(&from).await?.count() == 0,
            "Source folder is not empty"
        );
        Ok(())
    }
    .await;
    // Exact owned paths only, including pre/post-move positions. Never recurse.
    for path in [
        &source,
        &destination,
        &link,
        &moved_link,
        &alias,
        &format!("{tree}/child.txt"),
        &format!("{moved_tree}/child.txt"),
    ] {
        let _ = fs.0.remove_file(path).await;
    }
    for path in [
        &format!("{tree}/nested"),
        &format!("{moved_tree}/nested"),
        &tree,
        &moved_tree,
        &from,
        &to,
    ] {
        let _ = fs.0.remove_dir(path).await;
    }
    fs.0.remove_dir(&dir)
        .await
        .context(format!("Inspect disposable test directory: {dir}"))?;
    connection.disconnect().await?;
    result?;
    println!("Move probe passed: collision preservation, stale/same/missing/invalid destination refusal, file metadata, nonempty folder and symlink moves, self/descendant/alias refusal, cleanup and disconnect.");
    Ok(())
}
