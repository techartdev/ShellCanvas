// SPDX-License-Identifier: MPL-2.0
use anyhow::Result;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};

/// A process-local connection instance, distinct from a logical workspace.
/// A reconnect must use a fresh instance or increment generation. This carries
/// no endpoint, credential or trust claim; those remain adapter-owned.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionIdentity {
    pub instance: u64,
    pub generation: u64,
    pub adapter: String,
}

/// Established-resource lifecycle, independent of how the connector authenticates
/// or which services it supplies. Does not imply a socket, shell, host or port.
#[async_trait]
pub trait ConnectionLifecycle: Send + Sync {
    /// Local health snapshot; must not block or perform network I/O.
    fn is_connected(&self) -> bool;
    /// Release the established resource. The workspace owner coordinates this
    /// once across shared services; adapters must also bound their own teardown.
    async fn disconnect(&self) -> Result<()>;
}
