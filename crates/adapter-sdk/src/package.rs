// SPDX-License-Identifier: MPL-2.0
//! Shared package identity, configuration and asset-path validation.
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PackageFile {
    pub path: String,
    pub size: u64,
    pub sha256: String,
    #[serde(default)]
    pub executable: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FieldKind {
    Text,
    Password,
    Number,
    Boolean,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConfigField {
    pub id: String,
    pub label: String,
    pub kind: FieldKind,
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub default: Option<Value>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub schema_version: u32,
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub platform: String,
    pub entrypoint: String,
    #[serde(default)]
    pub arguments: Vec<String>,
    pub files: Vec<PackageFile>,
    #[serde(default)]
    pub configuration: Vec<ConfigField>,
}
pub fn relative(path: &str) -> Result<()> {
    if path.is_empty()
        || path
            .chars()
            .any(|c| c.is_control() || "\\:<>\"|?*".contains(c))
    {
        bail!("Invalid adapter asset path");
    }
    for part in path.split('/') {
        let stem = part
            .split('.')
            .next()
            .unwrap_or("")
            .trim_end_matches(' ')
            .to_uppercase();
        let reserved_port = stem
            .strip_prefix("COM")
            .or_else(|| stem.strip_prefix("LPT"))
            .is_some_and(|suffix| {
                ["1", "2", "3", "4", "5", "6", "7", "8", "9", "¹", "²", "³"].contains(&suffix)
            });
        if part.is_empty()
            || part == "."
            || part == ".."
            || part.ends_with(['.', ' '])
            || ["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"].contains(&stem.as_str())
            || reserved_port
        {
            bail!("Invalid or reserved adapter asset path");
        }
    }
    Ok(())
}
impl Manifest {
    pub fn validate(&self) -> Result<()> {
        if self.schema_version != 1
            || !crate::wire::name(&self.id)
            || !self.id.contains('.')
            || self.id.starts_with("system.")
            || self.name.trim().is_empty()
            || self.name.len() > 200
            || self.description.len() > 4000
            || self.version.len() > 100
            || semver::Version::parse(&self.version).is_err()
        {
            bail!("Unsupported or invalid adapter package identity");
        }
        relative(&self.entrypoint)?;
        if self.arguments.iter().any(|arg| arg.contains('\0')) {
            bail!("Invalid adapter launch argument");
        }
        let mut paths = HashSet::new();
        let mut size = 0u64;
        for entry in &self.files {
            relative(&entry.path)?;
            if !paths.insert(entry.path.to_lowercase())
                || entry.sha256.len() != 64
                || !entry
                    .sha256
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            {
                bail!("Duplicate asset paths or invalid file hashes");
            }
            size = size
                .checked_add(entry.size)
                .context("Adapter package size overflow")?;
        }
        if !self
            .files
            .iter()
            .any(|file| file.path == self.entrypoint && file.executable)
        {
            bail!("Adapter entrypoint must be a declared executable file");
        }
        if self.platform.starts_with("windows-")
            && !self.entrypoint.to_lowercase().ends_with(".exe")
        {
            bail!("Windows adapter entrypoints must be explicit .exe files");
        }
        let mut fields = HashSet::new();
        for field in &self.configuration {
            if !crate::wire::name(&field.id)
                || field.id.contains('.')
                || !fields.insert(&field.id)
                || field.label.trim().is_empty()
                || field.label.len() > 200
            {
                bail!("Invalid or duplicate adapter configuration fields");
            }
            if let Some(value) = &field.default {
                if matches!(field.kind, FieldKind::Password) || !field.accepts(value) {
                    bail!("Invalid adapter field default; passwords cannot have packaged defaults");
                }
            }
        }
        Ok(())
    }
    pub fn validate_configuration(&self, value: &Value) -> Result<Value> {
        let input = value
            .as_object()
            .context("Adapter configuration must be an object")?;
        if input
            .keys()
            .any(|key| !self.configuration.iter().any(|field| field.id == *key))
        {
            bail!("Unknown adapter configuration field");
        }
        let mut output = serde_json::Map::new();
        for field in &self.configuration {
            if let Some(value) = input.get(&field.id).or(field.default.as_ref()) {
                if !field.accepts(value)
                    || (field.required && value.as_str().is_some_and(str::is_empty))
                {
                    bail!("Invalid value for {}", field.label);
                }
                output.insert(field.id.clone(), value.clone());
            } else if field.required {
                bail!("{} is required", field.label);
            }
        }
        Ok(Value::Object(output))
    }
}
impl ConfigField {
    fn accepts(&self, value: &Value) -> bool {
        match self.kind {
            FieldKind::Text | FieldKind::Password => value.is_string(),
            FieldKind::Number => value.is_number(),
            FieldKind::Boolean => value.is_boolean(),
        }
    }
}
