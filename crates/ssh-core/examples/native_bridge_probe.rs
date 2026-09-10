// SPDX-License-Identifier: MPL-2.0
//! Linux native mount acceptance. SSH carries only the inherited-pipe protocol
//! to a separately built bridge; the selected filesystem remains the core SFTP provider.
use anyhow::{ensure, Context, Result};
use shellcanvas_core::*;
use shellcanvas_filesystem_sdk::bridge_control::{BridgeControl, BridgePhase};
use shellcanvas_filesystem_sdk::wire::Server;
use std::{path::PathBuf, process::Stdio, sync::{Arc, atomic::{AtomicBool, Ordering}}, time::Duration};
use tokio::io::{AsyncBufReadExt, AsyncReadExt};

// Fault injection for this probe's dedicated SFTP channel only. SSH keepalives,
// other channels and the separate native-test control connection stay healthy.
struct StalledSftp<S> {
    stream: S,
    stalled: Arc<AtomicBool>,
}
impl<S: tokio::io::AsyncRead + Unpin> tokio::io::AsyncRead for StalledSftp<S> {
    fn poll_read(mut self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>, buf: &mut tokio::io::ReadBuf<'_>) -> std::task::Poll<std::io::Result<()>> {
        if self.stalled.load(Ordering::Acquire) { return std::task::Poll::Pending; }
        std::pin::Pin::new(&mut self.stream).poll_read(cx, buf)
    }
}
impl<S: tokio::io::AsyncWrite + Unpin> tokio::io::AsyncWrite for StalledSftp<S> {
    fn poll_write(mut self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>, buf: &[u8]) -> std::task::Poll<std::io::Result<usize>> {
        if self.stalled.load(Ordering::Acquire) { return std::task::Poll::Ready(Ok(buf.len())); }
        std::pin::Pin::new(&mut self.stream).poll_write(cx, buf)
    }
    fn poll_flush(mut self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.stream).poll_flush(cx)
    }
    fn poll_shutdown(mut self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.stream).poll_shutdown(cx)
    }
}
fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}
fn local_command(command: &str, unprivileged: bool) -> String {
    if unprivileged {
        format!(
            "exec /usr/sbin/runuser -u nobody -- sh -c {}",
            quote(command)
        )
    } else {
        command.to_owned()
    }
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
    let transport_loss = std::env::var("SHELLCANVAS_PROBE_TRANSPORT_LOSS").as_deref() == Ok("1");
    let ssh_loss = std::env::var("SHELLCANVAS_PROBE_SSH_LOSS").as_deref() == Ok("1");
    let sftp_stall = std::env::var("SHELLCANVAS_PROBE_SFTP_STALL").as_deref() == Ok("1");
    let stalled = Arc::new(AtomicBool::new(false));
    let unprivileged = std::env::var("SHELLCANVAS_PROBE_UNPRIVILEGED").as_deref() == Ok("1");
    if unprivileged {
        let uid = run(&args, "/usr/sbin/runuser -u nobody -- id -u").await?;
        ensure!(
            uid.trim().parse::<u32>()? != 0,
            "Fixture account must be unprivileged"
        );
        println!("UNPRIVILEGED_LOCAL_UID: {}", uid.trim());
    }
    ensure!(
        [transport_loss, ssh_loss, sftp_stall].into_iter().filter(|mode| *mode).count() <= 1,
        "Select one connection-loss mode"
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
    println!("NATIVE_FIXTURE: {root}");
    if unprivileged {
        run(
            &args,
            &format!(
                "chmod 711 -- {} && chown nobody -- {} && chmod 700 -- {}",
                quote(&root),
                quote(&target),
                quote(&target)
            ),
        )
        .await?;
    }
    let browser = SshFileBrowser::new(Arc::new(SftpBrowser(service.clone())), connection.clone());
    let fs: Arc<dyn MountedFileSystem> = if sftp_stall {
        let channel = connection.handle.channel_open_session().await?;
        channel.request_subsystem(true, "sftp").await?;
        let raw = russh_sftp::client::RawSftpSession::new(StalledSftp {
            stream: channel.into_stream(), stalled: stalled.clone(),
        });
        let isolated = Arc::new(SftpTextFiles::new(raw).await?);
        mounted::SftpMount::new(isolated, &source, true).await?
    } else {
        browser.mount_root(&source, true).await?
    };
    let remote = local_command(
        &format!("exec {} --mount {}", quote(&args[5]), quote(&target)),
        unprivileged,
    );
    let mut child = ssh(&args, &remote)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()?;
    let reader = child.stdout.take().context("Missing child stdout")?;
    let writer = child.stdin.take().context("Missing child stdin")?;
    let control = Arc::new(BridgeControl::default());
    let serving = tokio::spawn(Server::with_control(fs, control.clone()).serve(reader, writer));
    let result: Result<()> = async {
        run(
            &args,
            &format!(
                "for i in $(seq 1 50); do grep -F -- {} /proc/self/mountinfo >/dev/null && exit 0; sleep .1; done; exit 1",
                quote(&target)
            ),
        )
        .await?;
        tokio::time::timeout(Duration::from_secs(10), async {
            while control.snapshot()?.phase != BridgePhase::Attached {
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            anyhow::Ok(())
        }).await??;
        if transport_loss || ssh_loss || sftp_stall {
            let script = r#"import os,sys,errno,time
f=os.open(sys.argv[1]+'/loss.bin',os.O_CREAT|os.O_EXCL|os.O_RDWR|os.O_SYNC,0o600)
os.pwrite(f,b'confirmed',0)
os.fsync(f)
print('HELD',flush=True)
sys.stdin.read()
started=time.monotonic()
try:
    os.pwrite(f,b'unconfirmed',0)
    raise AssertionError('write succeeded after loss of provider')
except OSError as e:
    assert e.errno in (errno.EIO,errno.ENOTCONN,errno.ENODEV,errno.ETIMEDOUT), e
    assert time.monotonic()-started < 25, 'lost write exceeded the deadline'
    print('LINUX_LOST_WRITE_PASS: errno='+str(e.errno),flush=True)
finally:
    try:
        os.close(f)
    except OSError as e:
        assert e.errno in (errno.EIO,errno.ENOTCONN,errno.ENODEV,errno.ETIMEDOUT), e
        print('LINUX_LOST_CLOSE_ERROR: errno='+str(e.errno),flush=True)
"#;
            let mut holder = ssh(&args, &local_command(&format!("exec timeout 70s python3 -u -c {} {}", quote(script), quote(&target)), unprivileged))
                .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit()).spawn()?;
            let mut output = tokio::io::BufReader::new(holder.stdout.take().unwrap());
            let mut line = String::new();
            tokio::time::timeout(Duration::from_secs(15), output.read_line(&mut line)).await??;
            ensure!(line.trim() == "HELD", "Loss fixture did not open its file");
            // Drop the bridge's real transport endpoints, while the separate
            // SSH connection driving the local application remains available.
            if sftp_stall {
                stalled.store(true, Ordering::Release);
                println!("SFTP_STALLED: bridge pipes and other SSH channels remain connected");
            } else if ssh_loss {
                connection.disconnect().await?;
                tokio::time::timeout(Duration::from_secs(5), async {
                    while connection.is_connected() { tokio::task::yield_now().await; }
                }).await?;
                println!("SSH_SOURCE_CLOSED: bridge pipes remain connected");
            } else {
                serving.abort();
                while !serving.is_finished() { tokio::task::yield_now().await; }
            }
            drop(holder.stdin.take());
            line.clear();
            tokio::time::timeout(Duration::from_secs(if sftp_stall { 45 } else { 15 }), output.read_to_string(&mut line)).await??;
            print!("{line}");
            ensure!(tokio::time::timeout(Duration::from_secs(5), holder.wait()).await??.success(), "Lost-write fixture failed");
            let status = tokio::time::timeout(Duration::from_secs(15), child.wait()).await??;
            ensure!(!status.success(), "Transport loss reported a successful exit");
            let verify = "import sys; from pathlib import Path; assert Path(sys.argv[1]+'/loss.bin').read_bytes()==b'confirmed'; mounted=any(l.split()[4]==sys.argv[2] for l in open('/proc/self/mountinfo')); print('LINUX_LOSS_MOUNT_STATE: '+('retained' if mounted else 'removed')); print('LINUX_TRANSPORT_LOSS_PASS: failed write, preserved source, failure exit')";
            print!("{}",run(&args, &format!("python3 -c {} {} {}",quote(verify),quote(&source),quote(&target))).await?);
            if sftp_stall {
                ensure!(connection.is_connected(), "SFTP retirement disconnected the shared SSH connection");
                browser.list(Some(&source)).await?;
                println!("SFTP_STALL_ISOLATION_PASS: unrelated SFTP channel remains usable after mounted-channel timeout");
            }
            return Ok(());
        }
        let hold = "import os,sys; f=os.open(sys.argv[1]+'/held',os.O_CREAT|os.O_RDWR,0o600); print('HELD',flush=True); sys.stdin.read(); os.close(f)";
        let mut holder = ssh(&args, &local_command(&format!("exec timeout 60s python3 -u -c {} {}", quote(hold), quote(&target)), unprivileged))
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit()).spawn()?;
        let mut ready = tokio::io::BufReader::new(holder.stdout.take().unwrap());
        let mut line = String::new();
        tokio::time::timeout(Duration::from_secs(15), ready.read_line(&mut line)).await??;
        ensure!(line.trim() == "HELD", "Busy-file fixture did not open");
        control.request_detach()?;
        tokio::time::timeout(Duration::from_secs(25), async {
            loop {
                let snapshot = control.snapshot()?;
                if snapshot.phase == BridgePhase::Attached && snapshot.message.is_some() { break; }
                ensure!(snapshot.phase != BridgePhase::Detached && snapshot.phase != BridgePhase::Failed, "Busy drive was detached or failed");
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            anyhow::Ok(())
        }).await??;
        run(&args, &local_command(&format!("mountpoint -q {}", quote(&target)), unprivileged)).await?;
        drop(holder.stdin.take());
        let status = tokio::time::timeout(Duration::from_secs(10), holder.wait()).await??;
        ensure!(status.success(), "Busy-file fixture did not close cleanly");
        println!("BUSY_DETACH_PASS: held file prevented unmount; attachment stayed available");
        let script = service.create_text(&root, "test.py", TEST).await?;
        if unprivileged {
            run(&args, &format!("chmod 644 -- {}", quote(&script.path))).await?;
        }
        print!(
            "{}",
            run(
                &args,
                &local_command(&format!(
                    "timeout 240s python3 {} {} {}",
                    quote(&script.path),
                    quote(&target),
                    quote(if unprivileged { "-" } else { &source })
                ), unprivileged)
            )
            .await?
        );
        if unprivileged {
            // Inspect backing bytes as the source owner, without making the
            // remote files directly readable by the local mount account.
            let verify = "import sys; from pathlib import Path; p=Path(sys.argv[1]); payload=bytes(range(256))*49; expected=payload[:4093]+b'cross-page'+payload[4103:]; assert (p/'mapped.bin').read_bytes()==expected; assert (p/'seek.bin').read_bytes()==b'replacement'; assert (p/'reused.bin').read_bytes()==b'new-object'; assert (p/'renamed'/'item-000').read_bytes()==b'changed'; print('UNPRIVILEGED_SOURCE_PASS: independent source bytes verified by source owner')";
            print!("{}",run(&args,&format!("python3 -c {} {}",quote(verify),quote(&source))).await?);
        }
        control.request_detach()?;
        tokio::time::timeout(Duration::from_secs(25), async {
            loop {
                let snapshot = control.snapshot()?;
                if snapshot.phase == BridgePhase::Detached { break; }
                ensure!(snapshot.phase == BridgePhase::Detaching, "Graceful detach failed: {:?}", snapshot.message);
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            anyhow::Ok(())
        }).await??;
        Ok(())
    }
    .await;
    // Query mountinfo even for a disconnected FUSE mount whose stat() fails.
    // Recovery is an ordinary unmount after the fixture's descriptors close.
    let present = "import sys; sys.exit(0 if any(l.split()[4]==sys.argv[1] for l in open('/proc/self/mountinfo')) else 1)";
    let detached = run(
        &args,
        &format!(
            "if python3 -c {} {}; then fusermount3 -u -- {}; fi",
            quote(present),
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
    let cleanup = "import os,shutil,sys; p=sys.argv[1]; assert p.startswith('/tmp/shellcanvas-native-') and os.path.dirname(p)=='/tmp' and not os.path.islink(p) and not any(l.split()[4]==p+'/mount' for l in open('/proc/self/mountinfo')); shutil.rmtree(p)";
    run(
        &args,
        &format!("python3 -c {} {}", quote(cleanup), quote(&root)),
    )
    .await?;
    if connection.is_connected() {
        connection.disconnect().await?;
    }
    result?;
    println!("PASS: native Linux filesystem -> FUSE bridge -> core root grant -> real SFTP; detached and disposable tree removed");
    Ok(())
}
const TEST: &str = r#"import os, sys, errno, mmap
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
(p/'reused.bin').write_bytes(b'old-object')
old = os.open(p/'reused.bin', os.O_RDWR)
try:
    old_inode = os.fstat(old).st_ino
    os.unlink(p/'reused.bin')
    (p/'reused.bin').write_bytes(b'new-object')
    assert os.stat(p/'reused.bin').st_ino != old_inode, 'recreated path reused a live inode'
    assert os.pread(old, 30, 0) == b'old-object', 'old descriptor migrated to replacement'
    os.pwrite(old, b'OLD', 0)
    os.fsync(old)
    assert os.pread(old, 30, 0) == b'OLD-object'
    assert (p/'reused.bin').read_bytes() == b'new-object', 'old descriptor overwrote replacement'
finally:
    os.close(old)
assert (p/'reused.bin').read_bytes() == b'new-object', 'old close retired replacement path'
print('LINUX_UNLINKED_HANDLE_PASS: recreated path has distinct inode; old descriptor reads/writes its original object and closes without affecting replacement', flush=True)
(p/'directory').mkdir()
for i in range(70):
    (p/'directory'/f'item-{i:03}').write_bytes(bytes([i]))
assert len(list((p/'directory').iterdir())) == 70
assert len(list((p/'directory').iterdir())) == 70
directory_fd = os.open(p/'directory', os.O_RDONLY | os.O_DIRECTORY)
expected_names = {f'item-{i:03}' for i in range(70)}
for _ in range(2):
    os.lseek(directory_fd, 0, os.SEEK_SET)
    with os.scandir(directory_fd) as entries:
        assert {entry.name for entry in entries} == expected_names, 'rewind lost directory entries'
fd = os.open(p/'directory'/'item-000', os.O_RDWR)
os.rename(p/'directory', p/'renamed')
try:
    os.pwrite(fd, b'changed', 0)
    assert (p/'renamed'/'item-000').read_bytes() == b'changed'
    os.lseek(directory_fd, 0, os.SEEK_SET)
    with os.scandir(directory_fd) as entries:
        assert {entry.name for entry in entries} == expected_names, 'open directory rewind failed after rename'
finally:
    os.close(fd)
    os.close(directory_fd)
print('LINUX_DIRECTORY_REWIND_PASS: same open directory descriptor enumerates exact pages after rewinding and renaming', flush=True)
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
payload = bytes(range(256)) * 49
(p/'mapped.bin').write_bytes(payload)
fd = os.open(p/'mapped.bin', os.O_RDWR)
mapped = mmap.mmap(fd, len(payload), access=mmap.ACCESS_WRITE)
os.close(fd) # The mapping must retain the open object after its descriptor closes.
try:
    assert mapped[:] == payload
    mapped[4093:4103] = b'cross-page'
    mapped.flush()
finally:
    mapped.close()
expected = payload[:4093] + b'cross-page' + payload[4103:]
if sys.argv[2] != '-':
    assert (Path(sys.argv[2])/'mapped.bin').read_bytes() == expected, 'mapped write did not reach SFTP source'
fd = os.open(p/'mapped.bin', os.O_RDONLY)
try:
    with mmap.mmap(fd, len(expected), access=mmap.ACCESS_READ) as readonly:
        assert readonly[:] == expected
    with mmap.mmap(fd, len(expected), access=mmap.ACCESS_COPY) as private:
        private[:7] = b'private'
        private.flush()
finally:
    os.close(fd)
if sys.argv[2] != '-':
    assert (Path(sys.argv[2])/'mapped.bin').read_bytes() == expected, 'private mapping modified source'
print('LINUX_MMAP_PASS: shared cross-page writes flushed to source, descriptor-close lifetime, read-only and private mappings', flush=True)
print('LINUX_NATIVE_MOUNT_PASS: sparse offset, truncate, atomic editor save, old handle identity, paged enumeration, directory rename with open file, capacity and errors', flush=True)
"#;
