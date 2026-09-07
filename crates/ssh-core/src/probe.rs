// SPDX-License-Identifier: MPL-2.0
//! Optional independent command probes, not writes into an interactive console.
use crate::{Connection, HostInfo};
use anyhow::Result;
use async_trait::async_trait;

#[async_trait]
pub trait CommandProbe: Send + Sync {
    /// A fixed provider-owned command. Implementations must bound time/output.
    /// The name does not enforce read-only behavior; providers are trusted code.
    async fn probe(&self, command: &str) -> Result<String>;
}

/// Device detection consumes optional services, never a concrete SSH handle.
/// A console-only or API-only connection need not provide command probes.
pub struct ProbeContext<'a> {
    pub commands: Option<&'a dyn CommandProbe>,
    pub fallback: HostInfo,
}

#[async_trait]
impl CommandProbe for Connection {
    async fn probe(&self, command: &str) -> Result<String> {
        self.exec_readonly(command).await
    }
}
