// SPDX-License-Identifier: MPL-2.0
use super::*;
use russh::{server, ChannelId};
use std::{
    collections::HashMap,
    sync::atomic::{AtomicUsize, Ordering},
};
use tokio::net::TcpListener;

struct DropsSftp {
    auth: Arc<AtomicUsize>,
    sftp: Arc<AtomicUsize>,
    channels: HashMap<ChannelId, Channel<server::Msg>>,
}
impl server::Handler for DropsSftp {
    type Error = russh::Error;
    async fn auth_password(
        &mut self,
        _: &str,
        _: &str,
    ) -> std::result::Result<server::Auth, Self::Error> {
        self.auth.fetch_add(1, Ordering::SeqCst);
        Ok(server::Auth::Accept)
    }
    async fn channel_open_session(
        &mut self,
        channel: Channel<server::Msg>,
        reply: server::ChannelOpenHandle,
        _: &mut server::Session,
    ) -> std::result::Result<(), Self::Error> {
        self.channels.insert(channel.id(), channel);
        reply.accept().await;
        Ok(())
    }
    async fn subsystem_request(
        &mut self,
        _: ChannelId,
        name: &str,
        session: &mut server::Session,
    ) -> std::result::Result<(), Self::Error> {
        assert_eq!(name, "sftp");
        self.sftp.fetch_add(1, Ordering::SeqCst);
        session.disconnect(
            russh::Disconnect::ServiceNotAvailable,
            "SFTP unavailable",
            "en",
        )
    }
    async fn pty_request(
        &mut self,
        id: ChannelId,
        _: &str,
        _: u32,
        _: u32,
        _: u32,
        _: u32,
        _: &[(russh::Pty, u32)],
        session: &mut server::Session,
    ) -> std::result::Result<(), Self::Error> {
        session.channel_success(id)
    }
    async fn shell_request(
        &mut self,
        id: ChannelId,
        session: &mut server::Session,
    ) -> std::result::Result<(), Self::Error> {
        session.channel_success(id)
    }
}

#[tokio::test]
async fn sftp_disconnect_recovers_terminal_but_never_changes_host_identity() {
    for changed_key in [false, true] {
        let first_key =
            keys::PrivateKey::random(&mut rand::rng(), keys::Algorithm::Ed25519).unwrap();
        let second_key = if changed_key {
            keys::PrivateKey::random(&mut rand::rng(), keys::Algorithm::Ed25519).unwrap()
        } else {
            first_key.clone()
        };
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let directory = tempfile::tempdir().unwrap();
        let known_hosts = directory.path().join("known_hosts");
        // Even a second explicitly trusted key cannot replace this session's
        // identity during automatic recovery.
        std::fs::write(
            &known_hosts,
            format!(
                "[127.0.0.1]:{port} {}\n[127.0.0.1]:{port} {}\n",
                first_key.public_key().to_openssh().unwrap(),
                second_key.public_key().to_openssh().unwrap()
            ),
        )
        .unwrap();
        let auth = Arc::new(AtomicUsize::new(0));
        let sftp = Arc::new(AtomicUsize::new(0));
        let (auth_count, sftp_count) = (auth.clone(), sftp.clone());
        let server = tokio::spawn(async move {
            for key in [first_key, second_key] {
                let (stream, _) = listener.accept().await.unwrap();
                let config = Arc::new(server::Config {
                    keys: vec![key],
                    auth_rejection_time: Duration::ZERO,
                    ..Default::default()
                });
                let handler = DropsSftp {
                    auth: auth_count.clone(),
                    sftp: sftp_count.clone(),
                    channels: HashMap::new(),
                };
                if let Ok(session) = server::run_stream(config, stream, handler).await {
                    let _ = session.await;
                }
            }
        });
        let mut options = ConnectOptions {
            host: "127.0.0.1".into(),
            port,
            username: "fixture".into(),
            password: Some("local-test-only".into()),
            key_path: String::new(),
            passphrase: None,
            allow_legacy_mac: false,
        };
        let connection = Connection::connect_using(&options, known_hosts, None, None)
            .await
            .unwrap();
        assert!(connection.text_files().await.is_err());
        timeout(Duration::from_secs(2), async {
            while !connection.handle.is_closed() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        options.username = "another-account".into();
        assert!(connection.reconnect(&options).await.is_err());
        options.username = "fixture".into();
        let recovered = connection.reconnect(&options).await;
        if changed_key {
            let message = recovered.err().expect("changed key must fail").to_string();
            assert!(message.contains("SSH connection failed"));
            assert_eq!(
                auth.load(Ordering::SeqCst),
                1,
                "replacement key received authentication"
            );
        } else {
            let recovered = recovered.unwrap();
            let terminal = recovered.terminal(80, 24).await.unwrap();
            assert!(!recovered.handle.is_closed());
            terminal.close().await.unwrap();
            recovered.disconnect().await.unwrap();
            assert_eq!(auth.load(Ordering::SeqCst), 2);
        }
        assert_eq!(
            sftp.load(Ordering::SeqCst),
            1,
            "recovery must not retry SFTP"
        );
        timeout(Duration::from_secs(5), server)
            .await
            .unwrap()
            .unwrap();
    }
}
