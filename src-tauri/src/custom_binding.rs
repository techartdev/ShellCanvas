// SPDX-License-Identifier: MPL-2.0
use crate::connection_resource::ConnectionResource;
use shellcanvas_services::{custom_service_id, CustomService, ServiceCallError};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomMethodInfo {
    pub name: String,
    pub service: String,
    pub version: u32,
    pub binding: String,
    pub available: bool,
}
pub struct CustomBinding {
    alive: Arc<AtomicBool>,
    source: Arc<ConnectionResource>,
    service: Arc<dyn CustomService>,
    methods: Vec<CustomMethodInfo>,
}
impl CustomBinding {
    pub fn new(
        alive: Arc<AtomicBool>,
        source: Arc<ConnectionResource>,
        service: Arc<dyn CustomService>,
    ) -> Result<Self, String> {
        let descriptor = service.descriptor();
        let mut seen = std::collections::HashSet::new();
        if !custom_service_id(&descriptor.id)
            || descriptor.version == 0
            || descriptor.methods.is_empty()
            || descriptor.methods.iter().any(|name| {
                !name.starts_with(&format!("{}.", descriptor.id))
                    || name.len() > 200
                    || !seen.insert(name)
                    || !name.split('.').all(|part| {
                        part.as_bytes().first().is_some_and(u8::is_ascii_alphabetic)
                            && part.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
                    })
            })
        {
            return Err("Invalid custom service descriptor".into());
        }
        let binding = uuid::Uuid::new_v4().to_string();
        let methods = descriptor
            .methods
            .into_iter()
            .map(|name| CustomMethodInfo {
                name,
                service: descriptor.id.clone(),
                version: descriptor.version,
                binding: binding.clone(),
                available: true,
            })
            .collect();
        Ok(Self {
            alive,
            source,
            service,
            methods,
        })
    }
    fn available(&self) -> bool {
        self.alive.load(Ordering::Acquire) && self.source.is_connected()
    }
    pub fn methods(&self) -> Vec<CustomMethodInfo> {
        self.methods
            .iter()
            .map(|method| CustomMethodInfo {
                available: self.available(),
                ..method.clone()
            })
            .collect()
    }
    pub fn owns(&self, method: &str, binding: &str) -> bool {
        self.methods
            .iter()
            .any(|item| item.name == method && item.binding == binding)
    }
    pub async fn call(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, ServiceCallError> {
        if !self.available() {
            return Err(ServiceCallError::new(
                "closed",
                "The service connection is closed",
                false,
            ));
        }
        if !self.methods.iter().any(|item| item.name == method) {
            return Err(ServiceCallError::new(
                "unavailable",
                "Unknown service method",
                false,
            ));
        }
        let result = self.service.call(method, params).await;
        if !self.available() {
            return Err(ServiceCallError::new(
                "closed",
                "The original service connection closed before completion",
                true,
            ));
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace_services::WorkspaceServices;
    use async_trait::async_trait;
    use shellcanvas_services::{ConnectionIdentity, ConnectionLifecycle, CustomServiceDescriptor};
    use tokio::sync::Notify;
    struct Lifecycle(AtomicBool);
    #[async_trait]
    impl ConnectionLifecycle for Lifecycle {
        fn is_connected(&self) -> bool {
            self.0.load(Ordering::Acquire)
        }
        async fn disconnect(&self) -> anyhow::Result<()> {
            self.0.store(false, Ordering::Release);
            Ok(())
        }
    }
    fn source(id: u64) -> Arc<ConnectionResource> {
        ConnectionResource::new(
            ConnectionIdentity {
                instance: id,
                generation: 1,
                adapter: "test".into(),
            },
            Arc::new(Lifecycle(AtomicBool::new(true))),
        )
    }
    struct Service {
        descriptor: CustomServiceDescriptor,
        started: Notify,
        finish: Notify,
    }
    impl Service {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                descriptor: CustomServiceDescriptor {
                    id: "acme".into(),
                    version: 2,
                    methods: vec!["acme.echo".into()],
                },
                started: Notify::new(),
                finish: Notify::new(),
            })
        }
    }
    #[async_trait]
    impl CustomService for Service {
        fn descriptor(&self) -> CustomServiceDescriptor {
            self.descriptor.clone()
        }
        async fn call(
            &self,
            _: &str,
            params: serde_json::Value,
        ) -> Result<serde_json::Value, ServiceCallError> {
            self.started.notify_one();
            self.finish.notified().await;
            Ok(params)
        }
    }
    #[tokio::test]
    async fn bindings_are_unique_owned_and_do_not_outlive_their_workspace() {
        let a = source(1);
        let b = source(2);
        let service = Service::new();
        let mut first = WorkspaceServices::new(vec![a.clone()]).unwrap();
        let mut second = WorkspaceServices::new(vec![a.clone(), b.clone()]).unwrap();
        assert!(first.bind_custom(&b, service.clone()).is_err());
        first.bind_custom(&a, service.clone()).unwrap();
        second.bind_custom(&b, Service::new()).unwrap();
        assert!(first.bind_custom(&a, service.clone()).is_err());
        let info = first.custom_methods().pop().unwrap();
        assert_eq!(info.version, 2);
        assert!(second.custom_method(&info.name, &info.binding).is_none());
        assert!(first
            .custom_method("system.private", &info.binding)
            .is_none());
        let retained = first.custom_method(&info.name, &info.binding).unwrap();
        let task_binding = retained.clone();
        let call = tokio::spawn(async move {
            task_binding
                .call("acme.echo", serde_json::json!({"ok":true}))
                .await
        });
        service.started.notified().await;
        drop(first);
        assert!(
            a.is_connected(),
            "The second workspace still owns this connection"
        );
        service.finish.notify_one();
        let error = call.await.unwrap().unwrap_err();
        assert_eq!(error.code, "closed");
        assert!(error.outcome_uncertain);
        let error = retained
            .call("acme.echo", serde_json::Value::Null)
            .await
            .unwrap_err();
        assert!(
            !error.outcome_uncertain,
            "A retired handle must refuse before dispatch"
        );
        assert!(second
            .custom_methods()
            .iter()
            .all(|method| method.available));
        b.disconnect().await.unwrap();
        assert!(second
            .custom_methods()
            .iter()
            .all(|method| !method.available));
    }
    #[tokio::test]
    async fn custom_namespaces_cannot_impersonate_kernel_methods() {
        let connection = source(3);
        let mut workspace = WorkspaceServices::new(vec![connection.clone()]).unwrap();
        for (id, methods) in [
            ("system", vec!["system.echo"]),
            ("files.acme", vec!["files.acme.echo"]),
            ("acme", vec!["other.echo"]),
            ("acme", vec!["acme.echo", "acme.echo"]),
            ("acme", vec!["acme..echo"]),
        ] {
            let mut service = Service::new();
            Arc::get_mut(&mut service).unwrap().descriptor = CustomServiceDescriptor {
                id: id.into(),
                version: 1,
                methods: methods.into_iter().map(String::from).collect(),
            };
            assert!(workspace.bind_custom(&connection, service).is_err(), "{id}");
        }
        assert!(workspace.custom_methods().is_empty());
    }
}
