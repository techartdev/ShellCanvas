// SPDX-License-Identifier: MPL-2.0
//! Optional v1 file/settings contracts over the established adapter process.
use crate::AdapterProcess;
use anyhow::{anyhow, bail, Result};
use async_trait::async_trait;
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use shellcanvas_services::*;
use std::{collections::HashSet, sync::Arc, time::Duration};

const MUTATIONS: &[&str] = &["files.makeDirectory", "files.rename", "files.remove"];
impl AdapterProcess {
    /// Reading is the base contract; create/save are optional and advertised separately.
    pub fn text(&self) -> Option<Arc<dyn TextFileService>> {
        self.supports("files", 1, &["files.readText"])
            .then(|| Arc::new(Standard(self.clone())) as Arc<dyn TextFileService>)
    }
    pub fn mutations(&self) -> Option<Arc<dyn FileMutationService>> {
        self.supports("files", 1, MUTATIONS)
            .then(|| Arc::new(Standard(self.clone())) as Arc<dyn FileMutationService>)
    }
    pub fn moves(&self) -> Option<Arc<dyn FileMoveService>> {
        self.supports("files", 1, &["files.move"])
            .then(|| Arc::new(Standard(self.clone())) as Arc<dyn FileMoveService>)
    }
    pub fn settings(&self) -> Option<Arc<dyn HostSettingsService>> {
        self.supports("host", 1, &["host.settings.read"])
            .then(|| Arc::new(Standard(self.clone())) as Arc<dyn HostSettingsService>)
    }
}
struct Standard(AdapterProcess);
impl Standard {
    async fn call<T: DeserializeOwned>(
        &self,
        method: &str,
        params: Value,
        write: bool,
    ) -> Result<T> {
        let value = self
            .0
            .call(method, params, Duration::from_secs(30))
            .await
            .map_err(|error| {
                if write && error.outcome_uncertain {
                    anyhow!(
                        "{}. The remote change may have completed; refresh before retrying.",
                        error.message
                    )
                } else {
                    error.into()
                }
            })?;
        serde_json::from_value(value).map_err(|error| if write {
            anyhow!("Invalid {method} response: {error}. The remote change may have completed; refresh before retrying.")
        } else { anyhow!("Invalid {method} response: {error}") })
    }
    fn document(&self, mut document: TextDocument, write: bool) -> Result<TextDocument> {
        if document.path.is_empty() || document.revision.is_empty() {
            bail!(
                "Adapter returned a document without its location or revision.{}",
                if write {
                    " The remote change may have completed; refresh before retrying."
                } else {
                    ""
                }
            );
        }
        document.writable &= self.0.supports("files", 1, &["files.saveText"]);
        Ok(document)
    }
    fn relocation(result: FileRelocation) -> Result<FileRelocation> {
        let mut previous = HashSet::new();
        if result.path.is_empty()
            || result.locations.iter().any(|item| {
                item.previous.is_empty()
                    || item.location.path.is_empty()
                    || !previous.insert(&item.previous)
            })
        {
            bail!("Adapter returned invalid relocation mappings. The remote change may have completed; refresh before retrying.");
        }
        Ok(result)
    }
    fn setting(&self, mut setting: HostSetting) -> Result<HostSetting> {
        if setting.id.is_empty()
            || setting
                .revision
                .as_ref()
                .is_some_and(|revision| revision.is_empty())
        {
            bail!("Adapter returned a setting without a valid identity or revision");
        }
        if !self.0.supports("host", 1, &["host.settings.apply"]) {
            setting.writable = false;
            setting
                .reason
                .get_or_insert_with(|| "This adapter provides read-only settings.".into());
        }
        if setting.revision.is_none() {
            setting.writable = false;
        }
        Ok(setting)
    }
}
#[async_trait]
impl TextFileService for Standard {
    async fn read_text(&self, path: &str) -> Result<TextDocument> {
        self.document(
            self.call("files.readText", json!({"path":path}), false)
                .await?,
            false,
        )
    }
    async fn create_text(&self, parent: &str, name: &str, text: &str) -> Result<TextDocument> {
        self.document(
            self.call(
                "files.createText",
                json!({"parent":parent,"name":name,"text":text}),
                true,
            )
            .await?,
            true,
        )
    }
    async fn save_text(
        &self,
        path: &str,
        text: &str,
        expected_revision: &str,
    ) -> Result<TextDocument> {
        self.document(
            self.call(
                "files.saveText",
                json!({"path":path,"text":text,"revision":expected_revision}),
                true,
            )
            .await?,
            true,
        )
    }
}
#[async_trait]
impl FileMutationService for Standard {
    async fn make_directory(&self, parent: &str, name: &str) -> Result<String> {
        let path: String = self
            .call(
                "files.makeDirectory",
                json!({"parent":parent,"name":name}),
                true,
            )
            .await?;
        if path.is_empty() {
            bail!("Adapter returned an empty folder location. The remote change may have completed; refresh before retrying.");
        }
        Ok(path)
    }
    async fn rename_tracked(
        &self,
        path: &str,
        name: &str,
        revision: &str,
        tracked: &[String],
    ) -> Result<FileRelocation> {
        Self::relocation(
            self.call(
                "files.rename",
                json!({"path":path,"name":name,"revision":revision,"tracked":tracked}),
                true,
            )
            .await?,
        )
    }
    async fn remove_entry(&self, path: &str, revision: &str) -> Result<()> {
        self.call(
            "files.remove",
            json!({"path":path,"revision":revision}),
            true,
        )
        .await
    }
}
#[async_trait]
impl FileMoveService for Standard {
    async fn move_tracked(
        &self,
        path: &str,
        parent: &str,
        revision: &str,
        tracked: &[String],
    ) -> Result<FileRelocation> {
        Self::relocation(
            self.call(
                "files.move",
                json!({"path":path,"parent":parent,"revision":revision,"tracked":tracked}),
                true,
            )
            .await?,
        )
    }
}
#[async_trait]
impl HostSettingsService for Standard {
    async fn read(&self) -> Result<Vec<HostSetting>> {
        let fields: Vec<HostSetting> = self.call("host.settings.read", Value::Null, false).await?;
        let mut ids = HashSet::new();
        fields
            .into_iter()
            .map(|field| {
                if !ids.insert(field.id.clone()) {
                    bail!("Adapter returned duplicate setting identities");
                }
                self.setting(field)
            })
            .collect()
    }
    async fn apply(&self, id: &str, value: &str, revision: &str) -> Result<HostSetting> {
        let field = self
            .setting(
                self.call(
                    "host.settings.apply",
                    json!({"id":id,"value":value,"revision":revision}),
                    true,
                )
                .await?,
            )
            .map_err(|error| {
                anyhow!("{error}. The remote change may have completed; refresh before retrying.")
            })?;
        if field.id != id || field.value.is_none() || field.revision.is_none() {
            bail!("Adapter did not confirm the requested setting with a value and revision. The remote change may have completed; refresh before retrying.");
        }
        Ok(field)
    }
}
