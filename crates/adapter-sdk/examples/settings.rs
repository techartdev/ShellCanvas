// SPDX-License-Identifier: MPL-2.0
// In-memory device setting; replace this state with verified device operations.
use shellcanvas_adapter_sdk::{
    async_trait, json, run, Adapter, CallError, RequestContext, ServiceDescriptor, Value,
};
use std::sync::Mutex;

struct Setting {
    value: String,
    revision: u64,
}
impl Setting {
    fn field(&self) -> Value {
        json!({"id":"mode","label":"Demo mode","description":"Synthetic device operating mode",
            "value":self.value,"revision":self.revision.to_string(),"editor":"select",
            "choices":["normal","quiet"],"writable":true,"reason":null})
    }
}
struct Device(Mutex<Setting>);
#[async_trait]
impl Adapter for Device {
    async fn initialize(
        &self,
        _: Value,
        _: RequestContext,
    ) -> Result<Vec<ServiceDescriptor>, CallError> {
        Ok(vec![ServiceDescriptor {
            id: "host".into(),
            version: 1,
            methods: vec!["host.settings.read".into(), "host.settings.apply".into()],
        }])
    }
    async fn call(
        &self,
        method: &str,
        params: Value,
        context: RequestContext,
    ) -> Result<Value, CallError> {
        let mut state = self
            .0
            .lock()
            .map_err(|_| CallError::new("failed", "Device state unavailable"))?;
        if context.is_canceled() {
            return Err(CallError::new("aborted", "Settings request canceled"));
        }
        match method {
            "host.settings.read" => Ok(json!([state.field()])),
            "host.settings.apply" => {
                if params["id"] != "mode"
                    || params["revision"].as_str() != Some(&state.revision.to_string())
                {
                    return Err(CallError::new(
                        "invalid",
                        "Setting changed; read it again before applying",
                    ));
                }
                let value = params["value"]
                    .as_str()
                    .filter(|s| matches!(*s, "normal" | "quiet"))
                    .ok_or_else(|| CallError::new("invalid", "Choose normal or quiet"))?;
                let revision = state
                    .revision
                    .checked_add(1)
                    .ok_or_else(|| CallError::new("failed", "Revision exhausted"))?;
                // The lock covers compare and commit. Real devices need their own atomic
                // revision contract and readback; do not pretend a write is confirmed.
                state.value = value.into();
                state.revision = revision;
                // Return committed state even if cancellation arrived after the mutation.
                Ok(state.field())
            }
            _ => Err(CallError::new(
                "unavailable",
                "Unsupported settings operation",
            )),
        }
    }
}
fn main() -> std::io::Result<()> {
    run(Device(Mutex::new(Setting {
        value: "normal".into(),
        revision: 1,
    })))
}
