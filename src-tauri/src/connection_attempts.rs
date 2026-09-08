// SPDX-License-Identifier: MPL-2.0
use serde::Serialize;
use shellcanvas_core::UnknownHostKey;
use std::{
    collections::HashMap,
    future::Future,
    time::{Duration, Instant},
};
use tokio::sync::{oneshot, watch};

pub const REVIEW_TIMEOUT: Duration = Duration::from_secs(300);
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostKeyChallenge {
    pub token: String,
    pub host: String,
    pub port: u16,
    pub algorithm: String,
    pub fingerprint: String,
}
struct Review {
    token: String,
    expires: Instant,
    decision: oneshot::Sender<bool>,
}

#[derive(Default)]
pub struct ConnectionAttempts {
    entries: HashMap<u64, (watch::Sender<bool>, bool)>,
    reviews: HashMap<u64, Review>,
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
        self.reviews.remove(&id);
        if let Some((sender, _)) = self.entries.remove(&id) {
            sender.send_replace(true);
        }
    }
    pub fn finish(&mut self, id: u64) {
        self.reviews.remove(&id);
        self.entries.remove(&id);
    }
    pub fn review(
        &mut self,
        id: u64,
        key: &UnknownHostKey,
    ) -> Result<(HostKeyChallenge, oneshot::Receiver<bool>), String> {
        if !self.entries.get(&id).is_some_and(|(_, started)| *started)
            || self.reviews.contains_key(&id)
        {
            return Err("Connection attempt is unavailable for host review".into());
        }
        let token = uuid::Uuid::new_v4().to_string();
        let (decision, receiver) = oneshot::channel();
        let challenge = HostKeyChallenge {
            token: token.clone(),
            host: key.host.clone(),
            port: key.port,
            algorithm: key.key.algorithm().to_string(),
            fingerprint: key.fingerprint(),
        };
        self.reviews.insert(
            id,
            Review {
                token,
                expires: Instant::now() + REVIEW_TIMEOUT,
                decision,
            },
        );
        Ok((challenge, receiver))
    }
    pub fn decide(&mut self, id: u64, token: &str, approve: bool) -> Result<(), String> {
        let review = self
            .reviews
            .get(&id)
            .ok_or("Host review was canceled or expired")?;
        if review.token != token {
            return Err("Host review does not belong to this connection attempt".into());
        }
        if Instant::now() >= review.expires {
            self.reviews.remove(&id);
            return Err("Host review expired. Connect again to check the current key.".into());
        }
        self.reviews
            .remove(&id)
            .unwrap()
            .decision
            .send(approve)
            .map_err(|_| "Host review is no longer active".into())
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
    async fn reviews_are_bound_one_use_cancelable_and_expiring() {
        let candidate = UnknownHostKey {
            host: "server".into(),
            port: 2222,
            key: shellcanvas_core::HostPublicKey::from_openssh(
                "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            )
            .unwrap(),
        };
        let mut attempts = ConnectionAttempts::default();
        assert!(attempts.review(1, &candidate).is_err());
        attempts.begin(1).unwrap();
        assert!(attempts.review(1, &candidate).is_err());
        let _cancel = attempts.claim(1).unwrap();
        let (challenge, decision) = attempts.review(1, &candidate).unwrap();
        assert_eq!(challenge.host, "server");
        assert_eq!(challenge.port, 2222);
        assert_eq!(challenge.fingerprint, candidate.fingerprint());
        assert!(attempts.review(1, &candidate).is_err());
        assert!(attempts.decide(2, &challenge.token, true).is_err());
        assert!(attempts.decide(1, "wrong-token", true).is_err());
        attempts.decide(1, &challenge.token, true).unwrap();
        assert!(decision.await.unwrap());
        assert!(attempts.decide(1, &challenge.token, true).is_err());
        attempts.finish(1);
        for id in [2, 3, 4] {
            attempts.begin(id).unwrap();
            let _cancel = attempts.claim(id).unwrap();
            let (challenge, decision) = attempts.review(id, &candidate).unwrap();
            match id {
                2 => attempts.cancel(id),
                3 => {
                    attempts.reviews.get_mut(&id).unwrap().expires =
                        Instant::now() - Duration::from_secs(1);
                }
                _ => attempts.finish(id),
            }
            assert!(attempts.decide(id, &challenge.token, true).is_err());
            assert!(decision.await.is_err());
            attempts.finish(id);
        }
        attempts.begin(5).unwrap();
        let _cancel = attempts.claim(5).unwrap();
        let (challenge, decision) = attempts.review(5, &candidate).unwrap();
        attempts.decide(5, &challenge.token, false).unwrap();
        assert!(!decision.await.unwrap());
    }
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
