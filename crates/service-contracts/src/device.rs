// SPDX-License-Identifier: MPL-2.0
//! Optional device inspection over independent command requests, never console input.
use anyhow::Result;
use async_trait::async_trait;
use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostInfo {
    pub provider: String,
    pub system: String,
    pub hostname: String,
    pub home: Option<String>,
    pub capabilities: Vec<String>,
    pub notices: Vec<String>,
}

#[async_trait]
pub trait CommandProbe: Send + Sync {
    /// A fixed provider-owned command. Implementations must bound time/output.
    /// This interface is not a read-only sandbox: providers are trusted code.
    async fn probe(&self, command: &str) -> Result<String>;
}

/// Console-only and API-only connections need not supply command probes.
pub struct ProbeContext<'a> {
    pub commands: Option<&'a dyn CommandProbe>,
    pub fallback: HostInfo,
}

/// A host clock reading, with the offset in effect at the sampled instant.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostClockSample {
    pub unix_ms: i64,
    pub offset_minutes: i32,
}

#[async_trait]
pub trait HostClock: Send + Sync {
    async fn read(&self) -> Result<HostClockSample>;
}
