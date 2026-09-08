// SPDX-License-Identifier: MPL-2.0
use anyhow::{bail, Context, Result};
use russh::{
    client,
    keys::{self, PrivateKeyWithHashAlg, PublicKeyOrCertificate},
    Channel, ChannelMsg,
};
use russh_sftp::client::SftpSession;
use serde::Deserialize;
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::time::timeout;

pub const OP_TIMEOUT: Duration = Duration::from_secs(15);

// Never derives Debug or Serialize: authentication material must not enter logs.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectOptions {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub key_path: String,
    pub password: Option<String>,
    pub passphrase: Option<String>,
}

pub struct VerifiedHost {
    host: String,
    port: u16,
    known_hosts: PathBuf,
}

pub fn verify_host_key(host: &str, port: u16, key: &keys::PublicKey, path: &Path) -> Result<()> {
    if crate::assess_host_key(host, port, key, path)? == crate::HostKeyStatus::Unknown {
        bail!("Unknown host key for {host}:{port}. Verify the host with OpenSSH before connecting. No key was accepted or saved.");
    }
    Ok(())
}

impl client::Handler for VerifiedHost {
    type Error = anyhow::Error;
    async fn check_server_key(&mut self, key: &PublicKeyOrCertificate) -> Result<bool> {
        if key.certificate().is_some() {
            bail!("Host certificates are not supported in this prototype.");
        }
        verify_host_key(&self.host, self.port, &key.public_key(), &self.known_hosts)?;
        Ok(true)
    }
}

pub struct Connection {
    pub handle: client::Handle<VerifiedHost>,
}

impl Connection {
    pub async fn connect(options: ConnectOptions) -> Result<Self> {
        let known_hosts = dirs::home_dir()
            .context("Cannot locate your home directory")?
            .join(".ssh/known_hosts");
        Self::connect_at(options, known_hosts).await
    }

    // Private seam for isolated handshake tests; never supplied by frontend IPC.
    async fn connect_at(options: ConnectOptions, known_hosts: PathBuf) -> Result<Self> {
        crate::validate_ssh_endpoint(&options.host, options.port)?;
        if options.host.trim().is_empty() || options.username.trim().is_empty() || options.port == 0
        {
            bail!("A host, username, and valid port are required.");
        }
        let handler = VerifiedHost {
            host: options.host.clone(),
            port: options.port,
            known_hosts,
        };
        let config = client::Config {
            keepalive_interval: Some(Duration::from_secs(20)),
            keepalive_max: 3,
            ..Default::default()
        };
        timeout(Duration::from_secs(30), async move {
            let mut handle = client::connect(
                Arc::new(config),
                (options.host.as_str(), options.port),
                handler,
            )
            .await
            .context("SSH connection failed")?;
            let auth = if !options.key_path.trim().is_empty() {
                let key = keys::load_secret_key(
                    crate::expand_home(&options.key_path),
                    options.passphrase.as_deref().filter(|s| !s.is_empty()),
                )
                .context("Cannot load private key (check path and passphrase)")?;
                let hash = handle.best_supported_rsa_hash().await?.flatten();
                handle
                    .authenticate_publickey(
                        &options.username,
                        PrivateKeyWithHashAlg::new(Arc::new(key), hash),
                    )
                    .await?
            } else {
                handle
                    .authenticate_password(
                        &options.username,
                        options.password.as_deref().unwrap_or_default(),
                    )
                    .await?
            };
            if !auth.success() {
                bail!("Authentication rejected. Check the username and authentication method.");
            }
            Ok(Self { handle })
        })
        .await
        .context("Connection timed out after 30 seconds")?
    }

    pub async fn exec_readonly(&self, command: &str) -> Result<String> {
        self.exec_bounded(command).await
    }

    /// Trusted provider command execution, never exposed as a desktop IPC command.
    pub(crate) async fn exec_bounded(&self, command: &str) -> Result<String> {
        timeout(OP_TIMEOUT, async {
            let mut channel = self.handle.channel_open_session().await?;
            channel.exec(true, command).await?;
            let mut bytes = Vec::new();
            let mut stderr = Vec::new();
            let mut status = None;
            while let Some(msg) = channel.wait().await {
                match msg {
                    ChannelMsg::Data { data } => {
                        if bytes.len() + stderr.len() + data.len() > 65536 {
                            bail!("Host command exceeded the output limit");
                        }
                        bytes.extend_from_slice(&data);
                    }
                    ChannelMsg::ExtendedData { data, .. } => {
                        if bytes.len() + stderr.len() + data.len() > 65536 {
                            bail!("Host command exceeded the output limit");
                        }
                        stderr.extend_from_slice(&data);
                    }
                    ChannelMsg::ExitStatus { exit_status } => status = Some(exit_status),
                    _ => {}
                }
            }
            if status != Some(0) {
                bail!(
                    "Host command failed: {}",
                    String::from_utf8_lossy(&stderr).trim()
                );
            }
            Ok(String::from_utf8_lossy(&bytes).trim().to_owned())
        })
        .await
        .context("Host command timed out")?
    }

    pub async fn sftp(&self) -> Result<SftpSession> {
        timeout(OP_TIMEOUT, async {
            let mut channel = self.handle.channel_open_session().await?;
            channel.request_subsystem(true, "sftp").await?;
            wait_for_acceptance(&mut channel, "SFTP subsystem").await?;
            Ok(SftpSession::new(channel.into_stream()).await?)
        })
        .await
        .context("SFTP negotiation timed out")?
    }

    pub async fn text_files(&self) -> Result<crate::SftpTextFiles> {
        timeout(OP_TIMEOUT, async {
            let mut channel = self.handle.channel_open_session().await?;
            channel.request_subsystem(true, "sftp").await?;
            wait_for_acceptance(&mut channel, "Text file subsystem").await?;
            crate::SftpTextFiles::new(russh_sftp::client::RawSftpSession::new(
                channel.into_stream(),
            ))
            .await
        })
        .await
        .context("Text file negotiation timed out")?
    }

    pub async fn terminal(&self, cols: u32, rows: u32) -> Result<Channel<client::Msg>> {
        timeout(OP_TIMEOUT, async {
            let mut channel = self.handle.channel_open_session().await?;
            channel
                .request_pty(
                    true,
                    "xterm-256color",
                    cols.clamp(2, 500),
                    rows.clamp(2, 300),
                    0,
                    0,
                    &[],
                )
                .await?;
            wait_for_acceptance(&mut channel, "PTY allocation").await?;
            channel.request_shell(true).await?;
            wait_for_acceptance(&mut channel, "interactive shell").await?;
            Ok(channel)
        })
        .await
        .context("Terminal negotiation timed out")?
    }

    pub async fn disconnect(&self) -> Result<()> {
        timeout(
            Duration::from_secs(3),
            self.handle.disconnect(
                russh::Disconnect::ByApplication,
                "Client disconnected",
                "en",
            ),
        )
        .await??;
        Ok(())
    }
}

async fn wait_for_acceptance(channel: &mut Channel<client::Msg>, request: &str) -> Result<()> {
    while let Some(message) = channel.wait().await {
        match message {
            ChannelMsg::Success => return Ok(()),
            ChannelMsg::Failure | ChannelMsg::Close => bail!("The host rejected {request}"),
            _ => {}
        }
    }
    bail!("SSH channel closed while requesting {request}")
}

#[cfg(test)]
mod tests {
    use super::*;
    const KEY: &str = "AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    #[test]
    fn rejects_unknown_changed_and_marked_hosts() {
        let file = tempfile::NamedTempFile::new().unwrap();
        let key = keys::parse_public_key_base64(KEY).unwrap();
        std::fs::write(file.path(), format!("server ssh-ed25519 {KEY}\n")).unwrap();
        assert!(verify_host_key("server", 22, &key, file.path()).is_ok());
        assert!(verify_host_key("other", 22, &key, file.path()).is_err());
        assert!(verify_host_key("server", 2222, &key, file.path()).is_err());
        // A distinct valid Ed25519 public key.
        let changed = keys::parse_public_key_base64(
            "AAAAC3NzaC1lZDI1NTE5AAAAIAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB",
        )
        .unwrap();
        assert!(verify_host_key("server", 22, &changed, file.path()).is_err());
        std::fs::write(
            file.path(),
            format!("@revoked server ssh-ed25519 {KEY}\nserver ssh-ed25519 {KEY}\n"),
        )
        .unwrap();
        assert!(verify_host_key("server", 22, &key, file.path()).is_err());
    }

    #[tokio::test]
    async fn host_verification_precedes_authentication_over_real_ssh() {
        use russh::server;
        use std::sync::atomic::{AtomicUsize, Ordering};
        use tokio::net::TcpListener;

        struct CountAuth(Arc<AtomicUsize>);
        impl server::Handler for CountAuth {
            type Error = russh::Error;
            async fn auth_none(
                &mut self,
                _: &str,
            ) -> std::result::Result<server::Auth, Self::Error> {
                self.0.fetch_add(1, Ordering::SeqCst);
                Ok(server::Auth::reject())
            }
            async fn auth_password(
                &mut self,
                user: &str,
                password: &str,
            ) -> std::result::Result<server::Auth, Self::Error> {
                self.0.fetch_add(1, Ordering::SeqCst);
                assert_eq!(user, "fixture");
                assert_eq!(password, "local-test-only");
                Ok(server::Auth::Accept)
            }
        }
        let key = keys::PrivateKey::random(&mut rand::rng(), keys::Algorithm::Ed25519).unwrap();
        let public = key.public_key().to_openssh().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("known_hosts");
        for case in [
            "unknown",
            "changed",
            "revoked",
            "malformed",
            "trusted",
            "unrelated-markers",
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let record = format!("[127.0.0.1]:{port} {public}\n");
            let content = match case {
                "unknown" => String::new(),
                "changed" => format!("[127.0.0.1]:{port} ssh-ed25519 {KEY}\n"),
                "revoked" => format!("{record}@revoked [127.0.0.1]:{port} {public}\n"),
                "malformed" => format!("{record}not-a-key\n"),
                "unrelated-markers" => format!(
                    "@revoked another-host {public}\n@cert-authority *.example {public}\n{record}"
                ),
                _ => record,
            };
            std::fs::write(&path, content).unwrap();
            let calls = Arc::new(AtomicUsize::new(0));
            let handler = CountAuth(calls.clone());
            let config = Arc::new(server::Config {
                keys: vec![key.clone()],
                auth_rejection_time: Duration::ZERO,
                auth_rejection_time_initial: Some(Duration::ZERO),
                inactivity_timeout: Some(Duration::from_secs(5)),
                ..Default::default()
            });
            let task = tokio::spawn(async move {
                let (stream, _) = listener.accept().await.unwrap();
                if let Ok(session) = server::run_stream(config, stream, handler).await {
                    let _ = session.await; // Peer closure is expected for rejected keys.
                }
            });
            let result = timeout(
                Duration::from_secs(8),
                Connection::connect_at(
                    ConnectOptions {
                        host: "127.0.0.1".into(),
                        port,
                        username: "fixture".into(),
                        key_path: String::new(),
                        password: Some("local-test-only".into()),
                        passphrase: None,
                    },
                    path.clone(),
                ),
            )
            .await
            .expect("SSH fixture timed out");
            if matches!(case, "trusted" | "unrelated-markers") {
                let connection = result.unwrap_or_else(|e| panic!("{case}: {e:#}"));
                assert!(
                    calls.load(Ordering::SeqCst) > 0,
                    "Trusted connection did not authenticate"
                );
                connection.disconnect().await.unwrap();
            } else {
                let error = match result {
                    Ok(_) => panic!("{case} unexpectedly authenticated"),
                    Err(error) => error,
                };
                let text = format!("{error:#}");
                let expected = match case {
                    "unknown" => "Unknown host key",
                    "changed" => "MISMATCH",
                    "revoked" => "REVOKED",
                    _ => "Malformed",
                };
                assert!(text.contains(expected), "{case}: {text}");
                assert_eq!(
                    calls.load(Ordering::SeqCst),
                    0,
                    "{case} sent authentication before key verification"
                );
            }
            timeout(Duration::from_secs(8), task)
                .await
                .expect("SSH fixture did not close")
                .unwrap();
        }
    }
}
