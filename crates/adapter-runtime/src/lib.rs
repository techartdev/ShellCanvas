// SPDX-License-Identifier: MPL-2.0
//! Trusted native adapters, launched without a shell and pinned to one process generation.
//! This is a native-code trust boundary, not a sandbox or a package installer.
pub mod catalog;
mod custom;
mod process;
mod services;
pub mod wire;
pub use process::{AdapterError, AdapterProcess, Launch};
