// SPDX-License-Identifier: MPL-2.0
//! Build a native connection adapter without linking the ShellCanvas desktop.
//! Standard input/output are reserved for the versioned protocol.
mod server;
pub mod wire;
pub use async_trait::async_trait;
pub use serde_json::{self, json, Value};
pub use server::{run, serve, Adapter, CallError, RequestContext};
pub use wire::ServiceDescriptor;
