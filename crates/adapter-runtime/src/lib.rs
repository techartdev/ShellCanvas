// SPDX-License-Identifier: MPL-2.0
//! Trusted native adapters, launched without a shell and pinned to one process generation.
//! This is a native-code trust boundary, not a sandbox or a package installer.
pub mod catalog;
mod catalog_staging;
mod custom;
mod diagnostics;
mod process;
mod process_tree;
mod services;
mod standard;
mod transfers;
pub mod wire;
pub use diagnostics::{
    DiagnosticCode, DiagnosticEvent, DiagnosticKind, DiagnosticSnapshot, DiagnosticStatus,
    Diagnostics,
};
pub use process::{AdapterError, AdapterProcess, Launch};
