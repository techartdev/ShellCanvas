// SPDX-License-Identifier: MPL-2.0
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomServiceDescriptor {
    pub id: String,
    pub version: u32,
    pub methods: Vec<String>,
}
/// Custom services own a lowercase namespace; standard desktop roles are reserved.
pub fn custom_service_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 180
        && !["system", "files", "console", "host", "terminal", "services"]
            .contains(&id.split('.').next().unwrap_or(""))
        && id.split('.').all(|part| {
            part.as_bytes().first().is_some_and(u8::is_ascii_lowercase)
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        })
}
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ServiceCallError {
    pub code: String,
    pub message: String,
    pub outcome_uncertain: bool,
}
impl ServiceCallError {
    pub fn new(code: &str, message: &str, outcome_uncertain: bool) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            outcome_uncertain,
        }
    }
}
impl std::fmt::Display for ServiceCallError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}
impl std::error::Error for ServiceCallError {}
#[async_trait]
pub trait CustomService: Send + Sync {
    fn descriptor(&self) -> CustomServiceDescriptor;
    /// Dropping the future requests cancellation. Never automatically retry a dispatched call.
    async fn call(&self, method: &str, params: Value) -> Result<Value, ServiceCallError>;
}
