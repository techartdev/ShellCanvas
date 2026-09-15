// SPDX-License-Identifier: MPL-2.0
use super::*;
use crate::ConnectOptions;
use russh::{keys, server, ChannelId};
use std::{collections::HashMap, path::PathBuf, process::Stdio, time::Duration};
use tokio::{io::AsyncReadExt, net::TcpListener};

#[test]
fn filenames_and_metadata_are_not_shell_code() {
    assert_eq!(
        quote("a'$(touch /bad)\nb").unwrap(),
        "'a'\\''$(touch /bad)\nb'"
    );
    for name in ["", ".", "..", "a/b", "a\0b"] {
        assert!(child("/tmp", name).is_err());
    }
    assert!(quote("a\0b").is_err());
    assert!(absolute("relative").is_err());
    let item = entry("/tmp/a\nb".into(), "81a4|12|123|1|2|date|date").unwrap();
    assert_eq!(item.name, "a\nb");
    assert_eq!(item.kind, "file");
    assert_eq!(item.size, 12);
    for metadata in [
        "banner",
        "81a4|12|123|1|2|date",
        "81a4|bad|123|1|2|date|date",
    ] {
        assert!(entry("/tmp/x".into(), metadata).is_err());
    }
}

// A loopback SSH server rejecting SFTP and executing commands only inside a
// fresh test directory. No user host, credential, or interactive UI is used.
struct ShellServer {
    channels: HashMap<ChannelId, Channel<server::Msg>>,
    directory: PathBuf,
    restricted: bool,
}
impl server::Handler for ShellServer {
    type Error = anyhow::Error;
    async fn auth_password(&mut self, _: &str, _: &str) -> Result<server::Auth> {
        Ok(server::Auth::Accept)
    }
    async fn channel_open_session(
        &mut self,
        channel: Channel<server::Msg>,
        reply: server::ChannelOpenHandle,
        _: &mut server::Session,
    ) -> Result<()> {
        self.channels.insert(channel.id(), channel);
        reply.accept().await;
        Ok(())
    }
    async fn subsystem_request(
        &mut self,
        id: ChannelId,
        _: &str,
        session: &mut server::Session,
    ) -> Result<()> {
        session.channel_failure(id)?;
        session.close(id)?;
        self.channels.remove(&id);
        Ok(())
    }
    async fn exec_request(
        &mut self,
        id: ChannelId,
        data: &[u8],
        session: &mut server::Session,
    ) -> Result<()> {
        let channel = self.channels.remove(&id).unwrap();
        if self.restricted {
            session.channel_failure(id)?;
            session.close(id)?;
            return Ok(());
        }
        session.channel_success(id)?;
        let shell = if cfg!(windows) {
            "C:\\Program Files\\Git\\bin\\bash.exe"
        } else {
            "/bin/sh"
        };
        let mut child = tokio::process::Command::new(shell)
            .arg("-c")
            .arg(std::str::from_utf8(data)?)
            .current_dir(&self.directory)
            .env("LC_ALL", "C")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()?;
        let handle = session.handle();
        tokio::spawn(async move {
            let (mut input, mut output) = tokio::io::split(channel.into_stream());
            let mut stdin = child.stdin.take().unwrap();
            let mut stdout = child.stdout.take().unwrap();
            let mut stderr = child.stderr.take().unwrap();
            let input_task = tokio::spawn(async move {
                let _ = tokio::io::copy(&mut input, &mut stdin).await;
            });
            let output_task = tokio::spawn(async move {
                let _ = tokio::io::copy(&mut stdout, &mut output).await;
            });
            let error_task = tokio::spawn(async move {
                let mut bytes = vec![];
                let _ = stderr.read_to_end(&mut bytes).await;
                bytes
            });
            let status = child.wait().await.unwrap();
            input_task.abort();
            output_task.await.unwrap();
            let errors = error_task.await.unwrap();
            if !errors.is_empty() {
                let _ = handle.extended_data(id, 1, errors).await;
            }
            let _ = handle
                .exit_status_request(id, status.code().unwrap_or(1) as u32)
                .await;
            let _ = handle.eof(id).await;
            let _ = handle.close(id).await;
        });
        Ok(())
    }
}
struct Fixture {
    connection: Arc<Connection>,
    directory: tempfile::TempDir,
    server: tokio::task::JoinHandle<()>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.server.abort();
    }
}
impl Fixture {
    async fn new(restricted: bool) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let key = keys::PrivateKey::random(&mut rand::rng(), keys::Algorithm::Ed25519).unwrap();
        let known_hosts = directory.path().join("known_hosts");
        std::fs::write(
            &known_hosts,
            format!(
                "[127.0.0.1]:{port} {}\n",
                key.public_key().to_openssh().unwrap()
            ),
        )
        .unwrap();
        let handler = ShellServer {
            channels: HashMap::new(),
            directory: directory.path().into(),
            restricted,
        };
        let config = Arc::new(server::Config {
            keys: vec![key],
            auth_rejection_time: Duration::ZERO,
            ..Default::default()
        });
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let session = server::run_stream(config, stream, handler).await.unwrap();
            let _ = session.await;
        });
        let connection = Connection::connect_using(
            &ConnectOptions {
                host: "127.0.0.1".into(),
                port,
                username: "fixture".into(),
                password: Some("local-test-only".into()),
                key_path: String::new(),
                passphrase: None,
                allow_legacy_mac: false,
            },
            known_hosts,
            None,
            None,
        )
        .await
        .unwrap();
        Self {
            connection: Arc::new(connection),
            directory,
            server,
        }
    }
}

#[tokio::test]
async fn rejected_sftp_keeps_shell_browsing_and_transfers_usable() {
    let fixture = Fixture::new(false).await;
    let bytes: Vec<u8> = (0..100_001).map(|i| (i % 256) as u8).collect();
    std::fs::write(fixture.directory.path().join("binary"), &bytes).unwrap();
    std::fs::create_dir(fixture.directory.path().join("folder")).unwrap();
    for n in 0..140 {
        std::fs::write(fixture.directory.path().join(format!("item {n}")), b"x").unwrap();
    }
    assert!(fixture.connection.text_files().await.is_err());
    let service = Arc::new(ShellFiles::probe(fixture.connection.clone()).await.unwrap());
    assert!(service.can_upload());
    #[cfg(target_os = "linux")]
    assert!(
        service.can_download(),
        "Linux downloads should be available"
    );
    let mut reader = service.clone().open_directory(None).await.unwrap();
    let first = reader.next().await.unwrap();
    assert_eq!(first.directory.entries.len(), DIRECTORY_PAGE);
    assert!(!first.done);
    let second = reader.next().await.unwrap();
    assert!(second.done);
    assert_eq!(second.directory.entries.len(), 15);
    reader.close().await.unwrap();
    let folder = service
        .list(Some(&child(service.home(), "folder").unwrap()))
        .await
        .unwrap();
    assert!(folder.entries.is_empty());
    assert_eq!(folder.parent.as_deref(), Some(service.home()));

    let name = "-quoted ' $(touch INJECTED) file";
    let mut upload = service
        .clone()
        .upload(service.home(), name, bytes.len() as u64)
        .await
        .unwrap();
    for chunk in bytes.chunks(TRANSFER_CHUNK) {
        upload.write(chunk).await.unwrap();
    }
    let uploaded = upload.finish().await.unwrap();
    assert_eq!(
        std::fs::read(fixture.directory.path().join(name)).unwrap(),
        bytes
    );
    assert!(!fixture.directory.path().join("INJECTED").exists());
    let mut duplicate = service
        .clone()
        .upload(service.home(), name, 1)
        .await
        .unwrap();
    duplicate.write(b"x").await.unwrap();
    assert!(duplicate.finish().await.is_err());
    assert_eq!(
        std::fs::read(fixture.directory.path().join(name)).unwrap(),
        bytes
    );
    let mut directory_collision = service
        .clone()
        .upload(service.home(), "folder", 0)
        .await
        .unwrap();
    assert!(directory_collision.finish().await.is_err());
    assert_eq!(
        std::fs::read_dir(fixture.directory.path().join("folder"))
            .unwrap()
            .count(),
        0
    );

    if service.can_download() {
        let item = service.stat(&uploaded.path).await.unwrap();
        let mut download = service
            .clone()
            .download(&item.path, &item.revision)
            .await
            .unwrap();
        let mut received = vec![];
        loop {
            let chunk = download.read().await.unwrap();
            if chunk.is_empty() {
                break;
            }
            assert!(chunk.len() <= TRANSFER_CHUNK);
            received.extend(chunk);
        }
        download.finish().await.unwrap();
        assert_eq!(received, bytes);
        std::fs::write(fixture.directory.path().join(name), b"changed").unwrap();
        assert!(service
            .clone()
            .download(&item.path, &item.revision)
            .await
            .is_err());
    }
    let mut cancelled = service
        .clone()
        .upload(service.home(), "cancelled", 10)
        .await
        .unwrap();
    cancelled.write(b"partial").await.unwrap();
    assert!(cancelled.finish().await.is_err());
    cancelled.abort().await.unwrap();
    assert!(!fixture.directory.path().join("cancelled").exists());
    let mut abandoned = service
        .clone()
        .upload(service.home(), "abandoned", 3)
        .await
        .unwrap();
    abandoned.write(b"all").await.unwrap();
    drop(abandoned); // All bytes without COMMIT must never publish.
    timeout(Duration::from_secs(5), async {
        loop {
            if std::fs::read_dir(fixture.directory.path())
                .unwrap()
                .all(|e| {
                    !e.unwrap()
                        .file_name()
                        .to_string_lossy()
                        .starts_with(".shellcanvas-upload.")
                })
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("cancelled upload must clean its temporary file");
    assert!(!fixture.directory.path().join("abandoned").exists());
    assert_eq!(
        fixture
            .connection
            .exec_readonly("printf terminal-still-works")
            .await
            .unwrap(),
        "terminal-still-works"
    );
}

#[tokio::test]
async fn restricted_shell_and_command_failures_fail_closed() {
    let fixture = Fixture::new(true).await;
    assert!(fixture.connection.text_files().await.is_err());
    assert!(ShellFiles::probe(fixture.connection.clone()).await.is_err());
    assert!(!fixture.connection.handle.is_closed());
    let fixture = Fixture::new(false).await;
    for provider in ["routeros", "windows"] {
        let result = ShellFiles::probe_for_host(fixture.connection.clone(), provider).await;
        assert!(result
            .err()
            .unwrap()
            .to_string()
            .contains("POSIX shell file access is unavailable"));
        assert!(!fixture.connection.handle.is_closed());
    }
    assert!(collect(&fixture.connection, "printf partial; exit 1", 100)
        .await
        .is_err());
    assert!(collect(&fixture.connection, "printf oversized", 2)
        .await
        .is_err());
    assert_eq!(
        collect(&fixture.connection, "printf '\\000\\377\\012 '", 100)
            .await
            .unwrap(),
        vec![0, 255, 10, 32]
    );
    let mut directory = ShellDirectory {
        command: Command::start(&fixture.connection, "printf 'name\\000truncated'")
            .await
            .unwrap(),
        metadata: Directory {
            path: "/".into(),
            name: "/".into(),
            parent: None,
            home: None,
            roots: vec![],
            entries: vec![],
        },
        buffer: vec![],
        active: true,
    };
    assert!(directory.next().await.is_err());
    assert!(directory.next().await.is_err());
    for (script, size, succeeds) in [
        ("printf abc", 3, true),
        ("printf abc", 4, false),
        ("printf abc; exit 1", 3, false),
    ] {
        let mut download = Download {
            command: Command::start(&fixture.connection, script).await.unwrap(),
            file: TransferFile {
                location: location("/fixture".into()),
                size,
            },
            read: 0,
            eof: false,
        };
        assert_eq!(download.read().await.unwrap(), b"abc");
        assert_eq!(download.finish().await.is_ok(), succeeds);
        download.abort().await.unwrap();
        assert!(download.read().await.is_err());
    }
}
