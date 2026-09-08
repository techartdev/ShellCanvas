// SPDX-License-Identifier: MPL-2.0
//! Optional independent command probes, not writes into an interactive console.
use crate::Connection;
use anyhow::{anyhow, bail, Result};
use async_trait::async_trait;
pub use shellcanvas_services::{CommandProbe, ProbeContext};
use std::{collections::HashMap, sync::Arc};
use tokio::sync::{Mutex, OnceCell};

const MAX_PROBES: usize = 64;
const MAX_COMMAND_BYTES: usize = 4096;
const MAX_RESULT_BYTES: usize = 64 * 1024;
type ProbeResult = std::result::Result<String, String>;
type ProbeCell = Arc<OnceCell<ProbeResult>>;

/// One inspection attempt only. Caches successes and failures by exact command;
/// never retain this across sessions, reconnects, or administrative operations.
pub(crate) struct CachedProbe<'a> {
    source: &'a dyn CommandProbe,
    entries: Mutex<HashMap<String, ProbeCell>>,
}
impl<'a> CachedProbe<'a> {
    pub fn new(source: &'a dyn CommandProbe) -> Self {
        Self {
            source,
            entries: Mutex::new(HashMap::new()),
        }
    }
}
#[async_trait]
impl CommandProbe for CachedProbe<'_> {
    async fn probe(&self, command: &str) -> Result<String> {
        if command.len() > MAX_COMMAND_BYTES {
            bail!("Device probe command exceeds the size limit");
        }
        let cell = {
            let mut entries = self.entries.lock().await;
            if let Some(entry) = entries.get(command) {
                entry.clone()
            } else {
                if entries.len() >= MAX_PROBES {
                    bail!("Device inspection exceeded its probe limit");
                }
                let cell = Arc::new(OnceCell::new());
                entries.insert(command.to_owned(), cell.clone());
                cell
            }
        };
        // No map lock is held while a remote request is running. Concurrent callers
        // for this command share one result; other commands can progress independently.
        cell.get_or_init(|| async {
            match self.source.probe(command).await {
                Ok(output) if output.len() <= MAX_RESULT_BYTES => Ok(output),
                Ok(_) => Err("Device probe output exceeds the size limit".into()),
                Err(error) => {
                    let mut message = format!("{error:#}");
                    if message.len() > MAX_RESULT_BYTES {
                        let mut end = MAX_RESULT_BYTES;
                        while !message.is_char_boundary(end) {
                            end -= 1;
                        }
                        message.truncate(end);
                    }
                    Err(message)
                }
            }
        })
        .await
        .clone()
        .map_err(|message| anyhow!(message))
    }
}

#[async_trait]
impl CommandProbe for Connection {
    async fn probe(&self, command: &str) -> Result<String> {
        self.exec_readonly(command).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    struct Counted {
        calls: AtomicUsize,
    }
    #[async_trait]
    impl CommandProbe for Counted {
        async fn probe(&self, command: &str) -> Result<String> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            tokio::task::yield_now().await;
            match command {
                "failure" => bail!("Unsupported command"),
                "large" => Ok("x".repeat(MAX_RESULT_BYTES + 1)),
                _ => Ok(command.into()),
            }
        }
    }
    #[tokio::test]
    async fn overlapping_probes_share_success_and_failure_but_not_other_commands() {
        let source = Counted {
            calls: AtomicUsize::new(0),
        };
        let cache = CachedProbe::new(&source);
        let (first, same, other) =
            tokio::join!(cache.probe("os"), cache.probe("os"), cache.probe("name"));
        assert_eq!(first.unwrap(), "os");
        assert_eq!(same.unwrap(), "os");
        assert_eq!(other.unwrap(), "name");
        assert_eq!(source.calls.load(Ordering::SeqCst), 2);
        let (first, same) = tokio::join!(cache.probe("failure"), cache.probe("failure"));
        assert_eq!(first.unwrap_err().to_string(), "Unsupported command");
        assert_eq!(same.unwrap_err().to_string(), "Unsupported command");
        assert_eq!(source.calls.load(Ordering::SeqCst), 3);
    }
    #[tokio::test]
    async fn a_new_inspection_never_reuses_previous_results() {
        let source = Counted {
            calls: AtomicUsize::new(0),
        };
        CachedProbe::new(&source).probe("os").await.unwrap();
        CachedProbe::new(&source).probe("os").await.unwrap();
        assert_eq!(source.calls.load(Ordering::SeqCst), 2);
    }
    #[tokio::test]
    async fn bounds_cache_growth_and_output_without_retrying_oversized_results() {
        let source = Counted {
            calls: AtomicUsize::new(0),
        };
        let cache = CachedProbe::new(&source);
        assert!(cache
            .probe(&"x".repeat(MAX_COMMAND_BYTES + 1))
            .await
            .is_err());
        assert_eq!(source.calls.load(Ordering::SeqCst), 0);
        for _ in 0..2 {
            assert!(cache
                .probe("large")
                .await
                .unwrap_err()
                .to_string()
                .contains("output"));
        }
        for n in 1..MAX_PROBES {
            cache.probe(&n.to_string()).await.unwrap();
        }
        assert_eq!(source.calls.load(Ordering::SeqCst), MAX_PROBES);
        assert!(cache
            .probe("overflow")
            .await
            .unwrap_err()
            .to_string()
            .contains("probe limit"));
        assert_eq!(cache.probe("1").await.unwrap(), "1");
        assert_eq!(source.calls.load(Ordering::SeqCst), MAX_PROBES);
    }
}
