// SPDX-License-Identifier: MPL-2.0
//! Opt-in WinFsp -> current desktop SDK -> real Windows SFTP acceptance.
#[cfg(not(windows))]
fn main() {}
#[cfg(windows)]
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    probe::run().await
}
#[cfg(windows)]
#[path = "support/windows_semantics.rs"]
mod windows_semantics;
#[cfg(windows)]
mod probe {
    use anyhow::{ensure, Context, Result};
    use shellcanvas_core::*;
    use shellcanvas_services::{
        bridge_control::{BridgeControl, BridgePhase},
        wire::Server,
    };
    use std::{io::Write, path::PathBuf, process::Stdio, sync::Arc, time::Duration};
    use windows::{
        core::{HSTRING, PWSTR},
        Win32::{
            Foundation::*, NetworkManagement::WNet::WNetGetConnectionW,
            Storage::FileSystem::GetLogicalDrives,
        },
    };

    fn free_drive() -> Result<String> {
        let mask = unsafe { GetLogicalDrives() };
        ensure!(mask != 0, "Cannot inspect local drives");
        for letter in (b'D'..=b'Z').rev() {
            if mask & (1 << (letter - b'A')) != 0 {
                continue;
            }
            let target = format!("{}:", letter as char);
            let mut buffer = [0u16; 256];
            let mut size = buffer.len() as u32;
            let status = unsafe {
                WNetGetConnectionW(
                    &HSTRING::from(&target),
                    Some(PWSTR(buffer.as_mut_ptr())),
                    &mut size,
                )
            };
            if status == ERROR_NOT_CONNECTED {
                return Ok(target);
            }
        }
        anyhow::bail!("No unreserved drive letter for test")
    }
    async fn phase(control: &BridgeControl, expected: BridgePhase) -> Result<()> {
        tokio::time::timeout(Duration::from_secs(30), async {
            loop {
                let state = control.snapshot()?;
                if state.phase == expected {
                    return Ok(());
                }
                ensure!(
                    state.phase != BridgePhase::Failed,
                    "Bridge failed: {:?}",
                    state.message
                );
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        })
        .await?
    }
    pub async fn run() -> Result<()> {
        let args: Vec<_> = std::env::args().collect();
        ensure!(
            args.len() == 6,
            "Usage: windows_bridge_probe HOST USER KEY TRUST_FILE BRIDGE_EXE"
        );
        ensure!(
            std::env::var("SHELLCANVAS_LIVE_WINDOWS_PROBE").as_deref() == Ok("1"),
            "Explicit disposable test opt-in required"
        );
        let drive = free_drive()?;
        let connection = Arc::new(
            Connection::connect_with_trust_store(
                &ConnectOptions {
                    host: args[1].clone(),
                    username: args[2].clone(),
                    key_path: args[3].clone(),
                    port: 22,
                    password: None,
                    passphrase: None,
                    allow_legacy_mac: false,
                },
                PathBuf::from(&args[4]),
            )
            .await?,
        );
        let info = inspect_host(&connection).await;
        ensure!(info.provider == "windows", "Expected Windows host");
        let service = Arc::new(
            connection
                .text_files()
                .await?
                .with_identified_provider("windows"),
        );
        let browser =
            SshFileBrowser::new(Arc::new(SftpBrowser(service.clone())), connection.clone());
        let home = browser.list(None).await?.path;
        let name = format!("shellcanvas-native-{}", uuid::Uuid::new_v4());
        let root = service.make_directory(&home, &name).await?;
        println!("Disposable fixture: {root}; local mount: {drive}");
        let mounted = match browser.mount_root(&root, true).await {
            Ok(mounted) => mounted,
            Err(error) => {
                let entry = browser
                    .list(Some(&home))
                    .await?
                    .entries
                    .into_iter()
                    .find(|entry| entry.name == name)
                    .context("Startup fixture entry")?;
                service.remove_entry(&root, &entry.revision).await?;
                connection.disconnect().await?;
                return Err(error.into());
            }
        };
        let mut child = tokio::process::Command::new(&args[5])
            .args(["--mount", &drive])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .creation_flags(0x08000000)
            .kill_on_drop(true)
            .spawn()?;
        let control = Arc::new(BridgeControl::default());
        let server = tokio::spawn(Server::with_control(mounted, control.clone()).serve(
            child.stdout.take().context("stdout")?,
            child.stdin.take().context("stdin")?,
        ));
        let native = PathBuf::from(format!("{drive}\\probe.txt"));
        let result: Result<()> = async {
        phase(&control, BridgePhase::Attached).await?;
        let local = tempfile::tempdir()?;
        let baseline = super::windows_semantics::check(local.path());
        let comparison = super::windows_semantics::check(&PathBuf::from(format!("{drive}\\")));
        for ((case, native), (_, mapped)) in baseline.iter().zip(&comparison) {
            ensure!(native.is_ok(), "Native baseline failed for {case}: {native:?}");
            ensure!(!matches!(mapped, Err(message) if message.starts_with("ASSERTION:")), "Windows safety assertion failed: {case}: {mapped:?}");
            println!("WINDOWS COMPARISON {case}: native={native:?}; mapped={mapped:?}");
        }
        for required in ["closed-rename", "closed-delete", "rename-denied", "exclusive-denied"] {
            let (_, outcome) = comparison.iter().find(|(case, _)| case == required).unwrap();
            ensure!(outcome.is_ok(), "Required Windows behavior failed: {required}: {outcome:?}");
        }
        let bytes = "native bridge protocol two\r\n".repeat(4096).into_bytes();
        let mut held = std::fs::OpenOptions::new().read(true).write(true).create_new(true).open(&native).context("native create")?;
        held.write_all(&bytes).context("native write")?;
        held.sync_all().context("native flush")?;
        drop(held);
        ensure!(std::fs::read(&native).context("native read")? == bytes, "Local mapped bytes differ");
        ensure!(service.read_text(&format!("{root}/probe.txt")).await?.text.as_bytes() == bytes, "Independent SFTP bytes differ");
        let held = std::fs::File::open(&native).context("native held read")?;
        control.request_detach()?;
        phase(&control, BridgePhase::Attached).await?;
        ensure!(control.snapshot()?.message.is_some(), "Busy detach lacked a reason");
        drop(held);
        let renamed = native.with_file_name("renamed.txt");
        std::fs::rename(&native, &renamed).context("native rename")?;
        ensure!(std::fs::read(&renamed)? == bytes, "Rename lost bytes");
        std::fs::remove_file(&renamed).context("native delete")?;
        ensure!(!renamed.exists(), "Native deletion did not remove the file");
        control.request_detach()?;
        phase(&control, BridgePhase::Detached).await?;
        ensure!(tokio::time::timeout(Duration::from_secs(10), child.wait()).await??.success(), "Bridge failed on exit");
        println!("PASS: Windows SFTP, protocol handshake, 108 KiB write/read, independent SFTP verification, closed-file rename/delete, busy detach and ordinary detach");
        let full_parity = comparison.iter().all(|(_, result)| result.is_ok());
        if !full_parity {
            println!("ACCEPTED LIMITATIONS: shared reader/writer and open-file rename; see comparison rows. Release acceptance is not full Windows parity.");
        }
        if std::env::var("SHELLCANVAS_REQUIRE_WINDOWS_PARITY").as_deref() == Ok("1") {
            ensure!(full_parity, "Additional mapped sharing restrictions remain; see WINDOWS COMPARISON rows");
        }
        Ok(())
    }.await;
        if result.is_err() {
            let _ = child.kill().await;
        }
        server.abort();
        let _ = server.await;
        let bit = 1 << (drive.as_bytes()[0] - b'A');
        ensure!(
            unsafe { GetLogicalDrives() } & bit == 0,
            "Test mount remains at {drive}; fixture retained at {root}"
        );
        for item in browser.list(Some(&root)).await?.entries {
            ensure!(
                item.path.starts_with(&format!("{root}/")) && item.kind != "directory",
                "Unexpected fixture entry"
            );
            service.remove_entry(&item.path, &item.revision).await?;
        }
        let entry = browser
            .list(Some(&home))
            .await?
            .entries
            .into_iter()
            .find(|item| item.name == name)
            .context("Fixture entry")?;
        service.remove_entry(&root, &entry.revision).await?;
        connection.disconnect().await?;
        println!("PASS: local drive removed and disposable remote fixture deleted");
        result
    }
}
