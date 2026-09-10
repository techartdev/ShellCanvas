// SPDX-License-Identifier: MPL-2.0
//! Optional storage discovery on the file source. All identities and locations
//! belong to that provider; a console on another source must never implement it.
use crate::FilePlace;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileVolume {
    pub id: String,
    pub name: String,
    pub detail: String,
    pub locations: Vec<FilePlace>,
    pub system: bool,
    pub can_mount: bool,
    pub can_unmount: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileVolumes {
    /// Opaque revision of the reviewed inventory, checked again before changes.
    pub revision: String,
    pub volumes: Vec<FileVolume>,
    pub notices: Vec<String>,
}
impl FileVolumes {
    pub fn unavailable() -> Self {
        Self {
            revision: String::new(),
            volumes: vec![],
            notices: vec!["Drive discovery is unavailable on this file provider. Use its Home and filesystem locations, or enter a known path.".into()],
        }
    }
}
