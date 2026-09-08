// SPDX-License-Identifier: MPL-2.0
use std::{collections::HashMap, future::Future};
use tokio::sync::watch;

#[derive(Default)]
pub struct ConnectionAttempts {
    entries: HashMap<u64, (watch::Sender<bool>, bool)>,
}
impl ConnectionAttempts {
    pub fn begin(&mut self, id: u64) -> Result<(), String> {
        if self.entries.len() >= 32 {
            return Err("Too many pending connections".into());
        }
        let (sender, _) = watch::channel(false);
        self.entries.insert(id, (sender, false));
        Ok(())
    }
    pub fn claim(&mut self, id: u64) -> Result<watch::Receiver<bool>, String> {
        let (sender, started) = self
            .entries
            .get_mut(&id)
            .ok_or("Connection attempt was canceled or expired")?;
        if *started {
            return Err("Connection attempt already started".into());
        }
        *started = true;
        Ok(sender.subscribe())
    }
    pub fn cancel(&mut self, id: u64) {
        if let Some((sender, _)) = self.entries.remove(&id) {
            sender.send_replace(true);
        }
    }
    pub fn finish(&mut self, id: u64) {
        self.entries.remove(&id);
    }
}
pub async fn cancellable<T>(
    mut canceled: watch::Receiver<bool>,
    work: impl Future<Output = Result<T, String>>,
) -> Result<T, String> {
    if *canceled.borrow() {
        return Err("Connection canceled".into());
    }
    tokio::select! {
        biased;
        _ = canceled.changed() => Err("Connection canceled".into()),
        result = work => result,
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn cancellation_drops_a_pending_ssh_handshake() {
        use tokio::{
            io::AsyncReadExt,
            net::TcpListener,
            sync::oneshot,
            time::{timeout, Duration},
        };
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (accepted, waiting) = oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let _ = accepted.send(());
            timeout(Duration::from_secs(3), async {
                let mut bytes = [0; 1024];
                while stream.read(&mut bytes).await.unwrap() != 0 {}
            })
            .await
            .expect("Canceled handshake left its socket open");
        });
        let (cancel, receiver) = watch::channel(false);
        let work = async {
            shellcanvas_core::Connection::connect(shellcanvas_core::ConnectOptions {
                host: "127.0.0.1".into(),
                port,
                username: "fixture".into(),
                key_path: String::new(),
                password: None,
                passphrase: None,
            })
            .await
            .map(|_| ())
            .map_err(|e| e.to_string())
        };
        let (result, _) = tokio::join!(cancellable(receiver, work), async {
            waiting.await.unwrap();
            cancel.send_replace(true);
        });
        assert_eq!(result.unwrap_err(), "Connection canceled");
        server.await.unwrap();
    }
    #[tokio::test]
    async fn cancels_before_start_and_during_work_without_touching_other_attempts() {
        let mut attempts = ConnectionAttempts::default();
        attempts.begin(1).unwrap();
        attempts.cancel(1);
        assert!(attempts.claim(1).is_err());
        attempts.begin(2).unwrap();
        attempts.begin(3).unwrap();
        let receiver = attempts.claim(2).unwrap();
        assert!(attempts.claim(2).is_err());
        attempts.cancel(2);
        let result = cancellable(receiver, async { Ok::<_, String>("must not run") }).await;
        assert_eq!(result.unwrap_err(), "Connection canceled");
        let receiver = attempts.claim(3).unwrap();
        assert_eq!(
            cancellable(receiver, async { Ok::<_, String>("connected") })
                .await
                .unwrap(),
            "connected"
        );
        attempts.finish(3);
        assert!(attempts.entries.is_empty());
        let (sender, receiver) = watch::channel(false);
        let work = async {
            sender.send_replace(true);
            std::future::pending::<Result<(), String>>().await
        };
        assert_eq!(
            cancellable(receiver, work).await.unwrap_err(),
            "Connection canceled"
        );
    }
}
