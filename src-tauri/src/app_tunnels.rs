// SPDX-License-Identifier: MPL-2.0
//! Private desktop transport for app-owned connectors. An iframe never receives
//! a workspace/session identity or a raw socket API.
use crate::{connection_resource::ConnectionResource, DesktopState};
use serde::Serialize;
use shellcanvas_services::ConnectionIdentity;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tauri::State;
use tokio::{
    net::TcpListener,
    task::{JoinHandle, JoinSet},
};

#[derive(Default)]
pub struct TunnelRegistry(HashMap<String, Tunnel>);
pub struct Tunnel {
    task: JoinHandle<()>,
}
impl Drop for Tunnel {
    fn drop(&mut self) {
        self.task.abort();
    }
}
#[derive(Serialize)]
pub struct Endpoint {
    id: String,
    port: u16,
}

fn active(source: &ConnectionResource, alive: &AtomicBool) -> bool {
    alive.load(Ordering::Acquire) && source.is_connected()
}

async fn open(
    source: Arc<ConnectionResource>,
    alive: Arc<AtomicBool>,
    host: String,
    port: u16,
) -> Result<(Tunnel, u16), String> {
    if port == 0
        || host.is_empty()
        || host.len() > 253
        || host.chars().any(|c| c.is_whitespace() || c.is_control())
    {
        return Err("Enter a valid database host and TCP port".into());
    }
    if !active(&source, &alive) {
        return Err("The SSH host disconnected".into());
    }
    let ssh = source
        .ssh
        .as_ref()
        .ok_or("This connection does not provide SSH forwarding")?
        .clone();
    // Open before returning an endpoint so forwarding denial/remote refusal is
    // reported at setup, not hidden behind a database protocol error.
    let first = tokio::time::timeout(Duration::from_secs(10),
        ssh.handle.channel_open_direct_tcpip(host.clone(), u32::from(port), "127.0.0.1", 0))
        .await.map_err(|_| "The SSH host timed out opening the database port")?
        .map_err(|_| "The SSH host could not open the database port. Check the database listener and SSH TCP forwarding permissions.")?;
    // ChannelStream closes the SSH channel on drop, including cancellation
    // before the native connector has opened its first local socket.
    let first = first.into_stream();
    if !active(&source, &alive) {
        return Err("The SSH host connection changed".into());
    }
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .await
        .map_err(crate::error)?;
    let local_port = listener.local_addr().map_err(crate::error)?.port();
    let task = tokio::spawn(async move {
        let mut first = Some(first);
        let mut streams = JoinSet::new();
        let mut check = tokio::time::interval(Duration::from_millis(100));
        loop {
            tokio::select! {
                _ = check.tick() => { if !active(&source, &alive) { break; } }
                Some(_) = streams.join_next(), if !streams.is_empty() => {}
                accepted = listener.accept(), if streams.len() < 8 => {
                    let Ok((mut local, _)) = accepted else { break; };
                    if !active(&source, &alive) { break; }
                    let ssh = ssh.clone();
                    let host = host.clone();
                    let first = first.take();
                    streams.spawn(async move {
                        let mut remote = if let Some(stream) = first { stream } else {
                            match tokio::time::timeout(Duration::from_secs(10),
                                ssh.handle.channel_open_direct_tcpip(host, u32::from(port), "127.0.0.1", 0)).await {
                                Ok(Ok(channel)) => channel.into_stream(),
                                _ => return,
                            }
                        };
                        let _ = local.set_nodelay(true);
                        let _ = tokio::io::copy_bidirectional(&mut local, &mut remote).await;
                    });
                }
            }
        }
        // Dropping JoinSet closes every stream, even if a query is still running.
    });
    Ok((Tunnel { task }, local_port))
}

#[tauri::command]
pub async fn app_tunnel_open(
    session_id: u64,
    source: ConnectionIdentity,
    host: String,
    port: u16,
    state: State<'_, DesktopState>,
) -> Result<Endpoint, String> {
    let (resource, alive) = state
        .registry
        .lock()
        .await
        .sessions
        .get(&session_id)
        .ok_or("The workspace is no longer connected")?
        .ssh_source(&source)?;
    let (tunnel, port) = open(resource, alive, host, port).await?;
    let mut registry = state.tunnels.lock().await;
    registry.0.retain(|_, tunnel| !tunnel.task.is_finished());
    if registry.0.len() >= 32 {
        return Err("Too many database tunnels are open".into());
    }
    let id = uuid::Uuid::new_v4().to_string();
    registry.0.insert(id.clone(), tunnel);
    Ok(Endpoint { id, port })
}

#[tauri::command]
pub async fn app_tunnel_close(id: String, state: State<'_, DesktopState>) -> Result<(), String> {
    state.tunnels.lock().await.0.remove(&id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use russh::{server, Channel};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    struct Echo(Arc<std::sync::atomic::AtomicUsize>);
    impl server::Handler for Echo {
        type Error = russh::Error;
        async fn auth_password(&mut self, _: &str, _: &str) -> Result<server::Auth, Self::Error> {
            Ok(server::Auth::Accept)
        }
        async fn channel_open_direct_tcpip(
            &mut self,
            channel: Channel<server::Msg>,
            host: &str,
            port: u32,
            _: &str,
            _: u32,
            reply: server::ChannelOpenHandle,
            _: &mut server::Session,
        ) -> Result<(), Self::Error> {
            if host != "database.remote.test" {
                return Ok(());
            }
            assert_eq!(port, 1433);
            reply.accept().await;
            let closed = self.0.clone();
            tokio::spawn(async move {
                let (mut read, mut write) = tokio::io::split(channel.into_stream());
                let _ = tokio::io::copy(&mut read, &mut write).await;
                let _ = write.shutdown().await;
                closed.fetch_add(1, Ordering::SeqCst);
            });
            Ok(())
        }
    }
    #[tokio::test]
    async fn ssh_streams_reuse_authenticated_host_and_stop_on_source_replacement() {
        let key =
            russh::keys::PrivateKey::random(&mut rand::rng(), russh::keys::Algorithm::Ed25519)
                .unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let dir = tempfile::tempdir().unwrap();
        let trust = dir.path().join("known_hosts");
        std::fs::write(
            &trust,
            format!(
                "[127.0.0.1]:{port} {}\n",
                key.public_key().to_openssh().unwrap()
            ),
        )
        .unwrap();
        let closed = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let server_closed = closed.clone();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let config = Arc::new(server::Config {
                keys: vec![key],
                auth_rejection_time: Duration::ZERO,
                ..Default::default()
            });
            let _ = server::run_stream(config, stream, Echo(server_closed))
                .await
                .unwrap()
                .await;
        });
        let ssh = shellcanvas_core::Connection::connect_with_trust_store(
            &shellcanvas_core::ConnectOptions {
                host: "127.0.0.1".into(),
                port,
                username: "fixture".into(),
                password: Some("fixture".into()),
                key_path: String::new(),
                passphrase: None,
                allow_legacy_mac: false,
            },
            trust,
        )
        .await
        .unwrap();
        let source = ConnectionResource::with_ssh(
            ConnectionIdentity {
                instance: 1,
                generation: 1,
                adapter: "ssh".into(),
            },
            Arc::new(ssh),
            None,
        );
        let alive = Arc::new(AtomicBool::new(true));
        let error = open(
            source.clone(),
            alive.clone(),
            "denied.remote.test".into(),
            1433,
        )
        .await
        .err()
        .unwrap();
        assert!(error.contains("forwarding permissions"));
        let (unused, _) = open(
            source.clone(),
            alive.clone(),
            "database.remote.test".into(),
            1433,
        )
        .await
        .unwrap();
        drop(unused);
        tokio::time::timeout(Duration::from_secs(2), async {
            while closed.load(Ordering::SeqCst) == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let (tunnel, port) = open(
            source.clone(),
            alive.clone(),
            "database.remote.test".into(),
            1433,
        )
        .await
        .unwrap();
        // An unresolvable remote name works: the PC must not resolve or connect to it.
        for data in [vec![0, 1, 0xff, 0x80], vec![42; 128 * 1024]] {
            let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
                .await
                .unwrap();
            stream.write_all(&data).await.unwrap();
            let mut output = vec![0; data.len()];
            tokio::time::timeout(Duration::from_secs(3), stream.read_exact(&mut output))
                .await
                .unwrap()
                .unwrap();
            assert_eq!(output, data);
        }
        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .unwrap();
        alive.store(false, Ordering::Release);
        tokio::time::timeout(Duration::from_secs(2), async {
            while !tunnel.task.is_finished() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let mut byte = [0];
        assert!(!matches!(stream.read(&mut byte).await, Ok(1)));
        assert!(tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .is_err());
        assert!(
            source.is_connected(),
            "Retiring a tunnel does not disconnect a shared SSH host"
        );
        source.disconnect().await.unwrap();
        server.abort();
    }
}
