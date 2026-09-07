// SPDX-License-Identifier: MPL-2.0
use anyhow::{bail, Context, Result};
use russh::{
    client,
    keys::{self, PrivateKeyWithHashAlg, PublicKeyOrCertificate},
    Channel, ChannelMsg,
};
use russh_sftp::client::SftpSession;
use serde::{Deserialize, Serialize};
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
    let contents = std::fs::read_to_string(path)
        .context("Cannot read ~/.ssh/known_hosts. Verify this host with OpenSSH first.")?;
    // russh's simple known_hosts parser does not enforce revocation/CA markers.
    // Fail closed rather than silently ignoring these security directives.
    if contents
        .lines()
        .any(|line| line.trim_start().starts_with('@'))
    {
        bail!("This known_hosts file uses certificate or revocation markers, which this prototype does not yet support.");
    }
    let matched = keys::check_known_hosts_path(host, port, key, path).context(
        "HOST KEY MISMATCH: the server identity differs from known_hosts. Connection refused.",
    )?;
    if !matched {
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
        if options.host.trim().is_empty() || options.username.trim().is_empty() || options.port == 0
        {
            bail!("A host, username, and valid port are required.");
        }
        let known_hosts = dirs::home_dir()
            .context("Cannot locate your home directory")?
            .join(".ssh/known_hosts");
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
        timeout(OP_TIMEOUT, async {
            let mut channel = self.handle.channel_open_session().await?;
            channel.exec(true, command).await?;
            let mut bytes = Vec::new();
            let mut status = None;
            while let Some(msg) = channel.wait().await {
                match msg {
                    ChannelMsg::Data { data } => {
                        if bytes.len() + data.len() > 65536 {
                            bail!("Host information exceeded the output limit");
                        }
                        bytes.extend_from_slice(&data);
                    }
                    ChannelMsg::ExitStatus { exit_status } => status = Some(exit_status),
                    _ => {}
                }
            }
            if status != Some(0) {
                bail!("Host information command failed");
            }
            Ok(String::from_utf8_lossy(&bytes).trim().to_owned())
        })
        .await
        .context("Host information timed out")?
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

#[derive(Clone, Serialize)]
#[serde(tag = "type", content = "data", rename_all = "camelCase")]
pub enum TerminalEvent {
    Output(Vec<u8>),
    Closed,
    Error(String),
}
pub enum TerminalInput {
    Data(Vec<u8>),
    Resize(u32, u32),
}

pub async fn run_terminal(
    mut channel: Channel<client::Msg>,
    mut input: tokio::sync::mpsc::Receiver<TerminalInput>,
    output: impl Fn(TerminalEvent) -> bool,
) {
    loop {
        tokio::select! {
            message = channel.wait() => match message {
                Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
                    if !output(TerminalEvent::Output(data.to_vec())) { break; }
                }
                Some(ChannelMsg::Close) | None => break,
                _ => {}
            },
            message = input.recv() => {
                let result = match message {
                    Some(TerminalInput::Data(data)) => channel.data(&data[..]).await,
                    Some(TerminalInput::Resize(cols, rows)) => channel.window_change(cols.clamp(2,500), rows.clamp(2,300), 0, 0).await,
                    None => break,
                };
                if let Err(error) = result { output(TerminalEvent::Error(error.to_string())); break; }
            }
        }
    }
    let _ = channel.close().await;
    output(TerminalEvent::Closed);
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
}
