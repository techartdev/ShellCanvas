// SPDX-License-Identifier: MPL-2.0
//! Linux native mount acceptance. SSH carries only the inherited-pipe protocol
//! to a separately built bridge; the selected filesystem remains the core SFTP provider.
use anyhow::{ensure, Context, Result};
use shellcanvas_core::*;
use shellcanvas_filesystem_sdk::wire::Server;
use std::{path::PathBuf, process::Stdio, sync::Arc, time::Duration};
fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}
fn ssh(args: &[String], remote: &str) -> tokio::process::Command {
    let mut command = tokio::process::Command::new("ssh");
    command.args([
        "-T",
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=yes",
        "-i",
        &args[3],
        "-l",
        &args[2],
        &args[1],
        remote,
    ]);
    command.kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    command
}
async fn run(args: &[String], remote: &str) -> Result<String> {
    let output =
        tokio::time::timeout(Duration::from_secs(300), ssh(args, remote).output()).await??;
    ensure!(
        output.status.success(),
        "Remote test failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}
#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<_> = std::env::args().collect();
    ensure!(
        args.len() == 6,
        "Usage: native_bridge_probe HOST USER KEY_PATH ADDITIONAL_KNOWN_HOSTS REMOTE_BRIDGE"
    );
    ensure!(
        std::env::var("SHELLCANVAS_LIVE_MOUNT_PROBE").as_deref() == Ok("1"),
        "Set SHELLCANVAS_LIVE_MOUNT_PROBE=1 for disposable native mount testing"
    );
    let connection = Arc::new(
        Connection::connect_with_trust_store(
            &ConnectOptions {
                host: args[1].clone(),
                username: args[2].clone(),
                port: 22,
                key_path: args[3].clone(),
                password: None,
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
            &format!("shellcanvas-native-{}", uuid::Uuid::new_v4()),
        )
        .await?;
    let source = service.make_directory(&root, "source").await?;
    let target = service.make_directory(&root, "mount").await?;
    let browser = SshFileBrowser::new(Arc::new(SftpBrowser(service.clone())), connection.clone());
    let fs = browser.mount_root(&source, true).await?;
    let remote = format!("exec {} --mount {}", quote(&args[5]), quote(&target));
    let mut child = ssh(&args, &remote)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()?;
    let reader = child.stdout.take().context("Missing child stdout")?;
    let writer = child.stdin.take().context("Missing child stdin")?;
    let serving = tokio::spawn(Server::new(fs).serve(reader, writer));
    let result: Result<()> = async {
        run(
            &args,
            &format!(
                "for i in $(seq 1 50); do mountpoint -q {} && exit 0; sleep .1; done; exit 1",
                quote(&target)
            ),
        )
        .await?;
        let script = service.create_text(&root, "test.py", TEST).await?;
        print!(
            "{}",
            run(
                &args,
                &format!(
                    "timeout 240s python3 {} {}",
                    quote(&script.path),
                    quote(&target)
                )
            )
            .await?
        );
        Ok(())
    }
    .await;
    // All test file descriptors are closed before ordinary unmount. Never use lazy/forced detach.
    let detached = run(
        &args,
        &format!(
            "if mountpoint -q {}; then fusermount3 -u {}; fi",
            quote(&target),
            quote(&target)
        ),
    )
    .await;
    serving.abort(); // Drops both pipe endpoints; heartbeat retires the helper.
    let _ = serving.await;
    let ended = tokio::time::timeout(Duration::from_secs(10), child.wait()).await;
    if ended.is_err() {
        let _ = child.kill().await;
    }
    if let Err(error) = detached {
        anyhow::bail!(
            "Native test result: {result:?}; detach failed: {error}. Fixture retained at {root}"
        );
    }
    // The regular Files action intentionally removes only empty directories.
    // This harness owns the entire UUID fixture, including the populated source.
    let cleanup = "import os,shutil,sys; p=sys.argv[1]; assert p.startswith('/tmp/shellcanvas-native-') and os.path.dirname(p)=='/tmp' and not os.path.islink(p) and not os.path.ismount(p+'/mount'); shutil.rmtree(p)";
    run(&args, &format!("python3 -c {} {}", quote(cleanup), quote(&root))).await?;
    connection.disconnect().await?;
    result?;
    println!("PASS: native Linux filesystem -> FUSE bridge -> core root grant -> real SFTP; detached and disposable tree removed");
    Ok(())
}
const TEST: &str = r#"import os, sys, errno
from pathlib import Path
p = Path(sys.argv[1])
f = os.open(p/'seek.bin', os.O_CREAT|os.O_EXCL|os.O_RDWR, 0o600)
try:
    os.pwrite(f, b'begin', 0)
    os.pwrite(f, b'end', (1<<32)+19)
    os.fsync(f)
    assert os.fstat(f).st_size == (1<<32)+22
    assert os.pread(f, 3, (1<<32)+19) == b'end'
    os.ftruncate(f, 5)
    assert os.pread(f, 20, 0) == b'begin'
    (p/'save.tmp').write_bytes(b'replacement')
    os.replace(p/'save.tmp', p/'seek.bin')
    assert os.pread(f, 20, 0) == b'begin'
    assert (p/'seek.bin').read_bytes() == b'replacement'
finally:
    os.close(f)
(p/'directory').mkdir()
for i in range(70):
    (p/'directory'/f'item-{i:03}').write_bytes(bytes([i]))
assert len(list((p/'directory').iterdir())) == 70
assert len(list((p/'directory').iterdir())) == 70
fd = os.open(p/'directory'/'item-000', os.O_RDWR)
os.rename(p/'directory', p/'renamed')
try:
    os.pwrite(fd, b'changed', 0)
    assert (p/'renamed'/'item-000').read_bytes() == b'changed'
finally:
    os.close(fd)
try:
    os.rmdir(p/'renamed')
    raise AssertionError('nonempty directory removed')
except OSError as e:
    assert e.errno in (errno.ENOTEMPTY, errno.EIO)
assert os.statvfs(p).f_blocks > 0
try:
    (p/'missing').read_bytes()
    raise AssertionError('missing file readable')
except FileNotFoundError:
    pass
print('LINUX_NATIVE_MOUNT_PASS: sparse offset, truncate, atomic editor save, old handle identity, paged enumeration, directory rename with open file, capacity and errors', flush=True)
"#;
