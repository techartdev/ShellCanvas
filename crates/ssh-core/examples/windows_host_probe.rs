// SPDX-License-Identifier: MPL-2.0
//! Live Windows SSH acceptance. Writes only to a fresh UUID folder under SFTP home.
use anyhow::{ensure, Context, Result};
use shellcanvas_core::*;
use std::{path::PathBuf, sync::Arc, time::Duration};

async fn file_security(connection: &Connection, path: &str) -> Result<String> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let native = path
        .strip_prefix('/')
        .context("Expected Windows drive path")?
        .replace('/', "\\");
    let script = format!(
        "(Get-Acl -LiteralPath '{}').Sddl",
        native.replace('\'', "''")
    );
    let bytes: Vec<_> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    connection
        .exec_readonly(&format!(
            "powershell.exe -NoProfile -NonInteractive -EncodedCommand {}",
            STANDARD.encode(bytes)
        ))
        .await
}

async fn entry(browser: &SshFileBrowser, parent: &str, name: &str) -> Result<FileEntry> {
    browser
        .list(Some(parent))
        .await?
        .entries
        .into_iter()
        .find(|e| e.name == name)
        .context("Fixture entry missing")
}
async fn clean(browser: &SshFileBrowser, service: &SftpTextFiles, root: &str) -> Result<()> {
    let mut folders = vec![root.to_owned()];
    let mut index = 0;
    while index < folders.len() {
        for item in browser.list(Some(&folders[index])).await?.entries {
            ensure!(
                item.path.starts_with(&format!("{root}/")),
                "Cleanup escaped owned fixture"
            );
            if item.kind == "directory" {
                folders.push(item.path);
            } else {
                service.remove_entry(&item.path, &item.revision).await?;
            }
        }
        index += 1;
    }
    for folder in folders.into_iter().rev() {
        let location = browser.locate(&folder).await?;
        let item = entry(
            browser,
            location
                .parent
                .as_deref()
                .context("Fixture parent missing")?,
            &location.name,
        )
        .await?;
        service.remove_entry(&item.path, &item.revision).await?;
    }
    Ok(())
}
#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<_> = std::env::args().collect();
    ensure!(
        args.len() == 5,
        "Usage: windows_host_probe HOST USER KEY_PATH ADDITIONAL_KNOWN_HOSTS"
    );
    ensure!(
        std::env::var("SHELLCANVAS_LIVE_WINDOWS_PROBE").as_deref() == Ok("1"),
        "Set SHELLCANVAS_LIVE_WINDOWS_PROBE=1 for disposable writes"
    );
    let options = ConnectOptions {
        host: args[1].clone(),
        username: args[2].clone(),
        key_path: args[3].clone(),
        port: 22,
        password: None,
        passphrase: None,
        allow_legacy_mac: false,
    };
    let trust = PathBuf::from(&args[4]);
    let connection = Arc::new(Connection::connect_with_trust_store(&options, trust.clone()).await?);
    let info = inspect_host(&connection).await;
    ensure!(
        info.provider == "windows",
        "Windows detection failed: {}",
        info.provider
    );
    println!("PASS: trusted SSH and Windows identification");
    let clock = clock::SshHostClock::for_provider(connection.clone(), &info.provider)
        .context("Clock missing")?;
    let mut failures = Vec::new();
    let clock_result: Result<()> = async {
        let sample = clock.read().await?;
        let local_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_millis() as i64;
        ensure!(
            (sample.unix_ms - local_ms).abs() < 120_000,
            "Host clock differs by over two minutes"
        );
        println!(
            "PASS: remote clock (UTC offset {} minutes)",
            sample.offset_minutes
        );
        Ok(())
    }
    .await;
    if let Err(error) = clock_result {
        println!("FAIL: clock: {error:#}");
        failures.push(format!("clock: {error:#}"));
    }
    let service = Arc::new(
        connection
            .text_files()
            .await?
            .with_identified_provider(&info.provider),
    );
    let browser = Arc::new(
        SshFileBrowser::new(Arc::new(SftpBrowser(service.clone())), connection.clone())
            .with_identified_provider(&info.provider),
    );
    let home = browser.list(None).await?;
    let mut page = browser.clone().open_directory(None).await?;
    ensure!(
        page.next().await?.directory.entries.len() <= DIRECTORY_PAGE,
        "Oversized directory page"
    );
    page.close().await?;
    ensure!(page.next().await.is_err(), "Closed cursor was reusable");
    println!("PASS: home browsing, directory paging and cursor closure");
    let volumes = browser.volumes().await?;
    ensure!(!volumes.volumes.is_empty(), "No drives discovered");
    let mut locations = 0;
    for volume in &volumes.volumes {
        for location in &volume.locations {
            browser.list(Some(&location.path)).await?;
            locations += 1;
        }
    }
    println!(
        "PASS: {} volumes, {locations} browsable locations",
        volumes.volumes.len()
    );
    let mut terminal = connection.terminal(80, 24).await?;
    terminal.window_change(120, 35, 0, 0).await?;
    terminal
        .data(&b"echo SHELLCANVAS_WINDOWS_PROBE\r\n"[..])
        .await?;
    tokio::time::timeout(Duration::from_secs(15), async {
        let mut output = Vec::new();
        while let Some(message) = terminal.wait().await {
            if let russh::ChannelMsg::Data { data } = message {
                output.extend_from_slice(&data);
                if String::from_utf8_lossy(&output)
                    .matches("SHELLCANVAS_WINDOWS_PROBE")
                    .count()
                    >= 2
                {
                    return Ok::<_, anyhow::Error>(());
                }
                ensure!(output.len() < 65536, "Unexpected terminal output size");
            }
        }
        anyhow::bail!("Terminal closed before echo response")
    })
    .await??;
    terminal.close().await?;
    println!("PASS: terminal open, resize, command input/output and close");
    let name = format!("shellcanvas-windows-probe-{}", uuid::Uuid::new_v4());
    let root = service.make_directory(&home.path, &name).await?;
    ensure!(
        root == format!("{}/{}", home.path.trim_end_matches('/'), name),
        "Unexpected fixture root"
    );
    println!("Disposable root: {root}");
    let result: Result<()> = async {
        let doc = service.create_text(&root, "draft ' Български 🌍.txt", "Original 🌍\r\n").await?;
        if std::env::var_os("SHELLCANVAS_PROBE_METADATA").is_some() {
            let sftp = connection.sftp().await?;
            let path_attrs = sftp.symlink_metadata(&doc.path).await?;
            let mut file = sftp.open(&doc.path).await?;
            let handle_attrs = file.metadata().await?;
            println!("DIAGNOSTIC LSTAT: {path_attrs:?}; FSTAT: {handle_attrs:?}");
            use tokio::io::AsyncWriteExt;
            file.shutdown().await?;
            sftp.close().await?;
        }
        ensure!(service.create_text(&root, &doc.name, "overwrite").await.is_err(), "Duplicate create replaced file");
        let edit_result: Result<()> = async {
        let security = file_security(&connection, &doc.path).await?;
        ensure!(!security.is_empty(), "Missing Windows security descriptor");
        ensure!(service.save_text_confirmed(&doc.path, "unconfirmed", &doc.revision, false).await.is_err(), "Unconfirmed overwrite accepted");
        ensure!(service.read_text(&doc.path).await?.text == doc.text, "Unconfirmed save changed content");
        let saved = service.save_text_confirmed(&doc.path, "Changed Български\r\n", &doc.revision, true).await?;
        ensure!(service.read_text(&doc.path).await?.text == saved.text, "Unicode/CRLF save mismatch");
        ensure!(service.save_text_confirmed(&doc.path, "stale", &doc.revision, true).await.is_err(), "Stale editor save accepted");
        let large_text = "Български 🌍\r\n".repeat(4000);
        let large = service.save_text_confirmed(&doc.path, &large_text, &saved.revision, true).await?;
        ensure!(service.read_text(&doc.path).await?.text == large_text, "Large text save mismatch");
        let empty = service.save_text_confirmed(&doc.path, "", &large.revision, true).await?;
        ensure!(service.read_text(&empty.path).await?.text.is_empty(), "Empty save mismatch");
        ensure!(file_security(&connection, &doc.path).await? == security, "Windows security descriptor changed");
        println!("PASS: text creation, Unicode/CRLF, confirmed large save, conflict, empty save and unchanged Windows security descriptor (atomic: {})", service.can_save());
        Ok(())
        }.await;
        if let Err(error) = edit_result {
            println!("FAIL: editor overwrite: {error:#}");
            failures.push(format!("editor overwrite: {error:#}"));
            ensure!(service.read_text(&doc.path).await?.text == doc.text, "Failed save changed original");
        }
        if std::env::var_os("SHELLCANVAS_PROBE_EDITOR_ONLY").is_some() { return Ok(()); }
        let expected_text = service.read_text(&doc.path).await?.text;
        let old = entry(&browser, &root, &doc.name).await?;
        let renamed = service.rename_entry(&old.path, "renamed.txt", &old.revision).await?;
        let folder = service.make_directory(&root, "folder with spaces").await?;
        let old = entry(&browser, &root, "renamed.txt").await?;
        let moved = service.move_entry(&renamed, &folder, &old.revision).await?;
        ensure!(service.read_text(&moved).await?.text == expected_text, "Moved text mismatch");
        let folder_entry = entry(&browser, &root, "folder with spaces").await?;
        ensure!(service.remove_entry(&folder, &folder_entry.revision).await.is_err(), "Nonempty folder removed");
        println!("PASS: rename, move, spaced folder and nonempty-folder deletion refusal");
        let transfer_result: Result<()> = async {
        let size = 2 * 1024 * 1024 + 7;
        let bytes: Vec<_> = (0..size).map(|n| (n % 251) as u8).collect();
        let mut upload = service.clone().upload(&root, "transfer.bin", size as u64).await?;
        println!("TRANSFER: upload opened");
        let wire_chunk: usize = std::env::var("SHELLCANVAS_PROBE_WRITE_CHUNK").ok().map(|v| v.parse()).transpose()?.unwrap_or(TRANSFER_CHUNK);
        ensure!((1..=TRANSFER_CHUNK).contains(&wire_chunk), "Invalid diagnostic write chunk");
        for (index, chunk) in bytes.chunks(wire_chunk).enumerate() { upload.write(chunk).await.with_context(|| format!("upload write at {}", index * wire_chunk))?; }
        println!("TRANSFER: upload bytes written");
        upload.finish().await.context("upload finish")?;
        println!("TRANSFER: upload finished");
        let original = entry(&browser, &root, "transfer.bin").await?;
        println!("TRANSFER: starting remote copy");
        let copied = copy_regular_file(service.clone(), &original.path, &original.revision, &folder, "copy.bin", || false, &mut |_| {}).await?;
        println!("TRANSFER: copy finished");
        let copied_entry = entry(&browser, &folder, "copy.bin").await?;
        let mut download = service.clone().download(&copied.path, &copied_entry.revision).await?;
        let mut received = Vec::new();
        loop { let chunk = download.read().await?; if chunk.is_empty() { break; } received.extend(chunk); }
        download.finish().await.context("download finish")?;
        println!("TRANSFER: download finished");
        ensure!(received == bytes, "Binary roundtrip mismatch");
        ensure!(service.clone().download(&original.path, &"0".repeat(64)).await.is_err(), "Stale download accepted");
        let mut canceled = service.clone().upload(&root, "canceled.bin", size as u64).await?;
        canceled.write(&bytes[..TRANSFER_CHUNK]).await?;
        canceled.abort().await?;
        ensure!(!browser.list(Some(&root)).await?.entries.iter().any(|e| e.name == "canceled.bin" || e.name.starts_with(".shellcanvas-")), "Canceled upload residue");
        println!("PASS: 2 MiB binary upload/copy/download, exact bytes, stale guard and cancellation cleanup");
        Ok(())
        }.await;
        if let Err(error) = transfer_result { println!("FAIL: transfers: {error:#}"); failures.push(format!("transfers: {error:#}")); }
        let mounted = browser.mount_root(&root, true).await?;
        let path = MountPath::root().child("mounted.bin")?;
        let options = FsOpenOptions { read: true, write: true, create: FsCreate::CreateNew, truncate: false };
        let handle = mounted.open(&path, options).await?;
        ensure!(mounted.open(&path, options).await.is_err(), "Mounted exclusive create replaced file");
        handle.write_at(0, b"abcdef").await?;
        handle.write_at(2, b"XY").await?;
        handle.flush().await?;
        ensure!(handle.read_at(0, 6).await? == b"abXYef", "Random I/O mismatch");
        handle.set_metadata(FsSetMetadata { size: Some(3), ..Default::default() }).await?;
        ensure!(handle.metadata().await?.size == 3, "Truncate mismatch");
        handle.close().await?;
        mounted.remove(&path, false).await?;
        println!("PASS: mounted filesystem contract create, random I/O, flush, truncate, close and delete (no OS drive attached)");
        let second = Connection::connect_with_trust_store(&options_for_reconnect(&args), trust.clone()).await?;
        ensure!(inspect_host(&second).await.provider == "windows", "Second session detection failed");
        let other = second.text_files().await?;
        ensure!(other.read_text(&moved).await?.text == expected_text, "Second session cannot read test file");
        second.disconnect().await?;
        ensure!(service.read_text(&moved).await?.text == expected_text, "Closing second session broke first");
        println!("PASS: two simultaneous sessions and independent disconnect");
        Ok(())
    }.await;
    let cleanup = clean(&browser, &service, &root).await;
    connection.disconnect().await?;
    cleanup.context(format!("Fixture cleanup needs inspection: {root}"))?;
    println!("PASS: disposable fixture removed");
    result?;
    ensure!(failures.is_empty(), "{}", failures.join("; "));
    Ok(())
}
fn options_for_reconnect(args: &[String]) -> ConnectOptions {
    ConnectOptions {
        host: args[1].clone(),
        username: args[2].clone(),
        key_path: args[3].clone(),
        port: 22,
        password: None,
        passphrase: None,
        allow_legacy_mac: false,
    }
}
