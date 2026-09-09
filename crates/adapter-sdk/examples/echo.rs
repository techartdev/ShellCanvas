// SPDX-License-Identifier: MPL-2.0
//! A synthetic device for SDK development; no network or credentials required.
use shellcanvas_adapter_sdk::{
    async_trait, run, Adapter, CallError, RequestContext, ServiceDescriptor, Value,
};

struct Echo;
#[async_trait]
impl Adapter for Echo {
    async fn initialize(
        &self,
        _: Value,
        _: RequestContext,
    ) -> Result<Vec<ServiceDescriptor>, CallError> {
        Ok(vec![ServiceDescriptor {
            id: "example.device".into(),
            version: 1,
            methods: vec!["example.device.echo".into(), "example.device.wait".into()],
        }])
    }
    async fn call(
        &self,
        method: &str,
        params: Value,
        context: RequestContext,
    ) -> Result<Value, CallError> {
        match method {
            "example.device.echo" => Ok(params),
            "example.device.wait" => {
                context.canceled().await;
                Err(CallError::new("aborted", "Waiting was canceled"))
            }
            _ => Err(CallError::new("unavailable", "Unknown device method")),
        }
    }
}
fn main() -> std::io::Result<()> {
    run(Echo)
}
