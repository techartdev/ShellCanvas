// SPDX-License-Identifier: MPL-2.0
use anyhow::Result;
use async_trait::async_trait;
use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SettingEditor {
    Text,
    Select,
}

/// Presentation and validation choices belong to the device provider.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostSetting {
    pub id: String,
    pub label: String,
    pub description: String,
    pub value: Option<String>,
    pub revision: Option<String>,
    pub editor: SettingEditor,
    pub choices: Vec<String>,
    pub writable: bool,
    pub reason: Option<String>,
}

#[async_trait]
pub trait HostSettingsService: Send + Sync {
    async fn read(&self) -> Result<Vec<HostSetting>>;
    /// Apply one reviewed field with a precondition, then return verified state.
    /// Failures after dispatch must explain when the remote outcome is uncertain.
    async fn apply(&self, id: &str, value: &str, revision: &str) -> Result<HostSetting>;
}
