// SPDX-License-Identifier: MPL-2.0
use crate::AdapterProcess;
use async_trait::async_trait;
use shellcanvas_services::{
    custom_service_id, CustomService, CustomServiceDescriptor, ServiceCallError,
};
use std::{sync::Arc, time::Duration};
struct Service {
    process: AdapterProcess,
    descriptor: CustomServiceDescriptor,
}
impl AdapterProcess {
    pub fn custom(&self, id: &str) -> Option<Arc<dyn CustomService>> {
        if !custom_service_id(id) {
            return None;
        }
        let item = self.services().iter().find(|item| item.id == id)?;
        Some(Arc::new(Service {
            process: self.clone(),
            descriptor: CustomServiceDescriptor {
                id: item.id.clone(),
                version: item.version,
                methods: item.methods.clone(),
            },
        }))
    }
}
#[async_trait]
impl CustomService for Service {
    fn descriptor(&self) -> CustomServiceDescriptor {
        self.descriptor.clone()
    }
    async fn call(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, ServiceCallError> {
        if !self.descriptor.methods.iter().any(|name| name == method) {
            return Err(ServiceCallError::new(
                "unavailable",
                "Method is not part of this service",
                false,
            ));
        }
        self.process
            .call(method, params, Duration::from_secs(30))
            .await
            .map_err(|error| {
                ServiceCallError::new(&error.code, &error.message, error.outcome_uncertain)
            })
    }
}
