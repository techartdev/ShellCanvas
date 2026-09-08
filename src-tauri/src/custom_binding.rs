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
    pub fn source(&self) -> &Arc<ConnectionResource> {
        &self.source
    }
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
    async fn replacement_retires_only_selected_custom_handles_and_late_calls() {
        let old = source(11);
        let other = source(12);
        let fresh = source(13);
        let mut workspace = WorkspaceServices::new(vec![old.clone(), other.clone()]).unwrap();
        let mut other_service = Service::new();
        Arc::get_mut(&mut other_service).unwrap().descriptor = CustomServiceDescriptor {
            id: "other".into(),
            version: 1,
            methods: vec!["other.echo".into()],
        };
        let old_service = Service::new();
        workspace.bind_custom(&old, old_service.clone()).unwrap();
        workspace.bind_custom(&other, other_service).unwrap();
        let accepted = workspace.custom_sources();
        assert_eq!(workspace.accepted_custom_methods(Some(&accepted)).len(), 2);
        let infos = workspace.custom_methods();
        let original = infos.iter().find(|info| info.service == "acme").unwrap();
        let unaffected = infos.iter().find(|info| info.service == "other").unwrap();
        let retained = workspace
            .custom_method(&original.name, &original.binding)
            .unwrap();
        let pending_handle = retained.clone();
        let pending = tokio::spawn(async move {
            pending_handle
                .call("acme.echo", serde_json::Value::Null)
                .await
        });
        old_service.started.notified().await;
        let mut replacement = WorkspaceServices::new(vec![fresh.clone()]).unwrap();
        let new_service = Service::new();
        replacement
            .bind_custom(&fresh, new_service.clone())
            .unwrap();
        let retired = workspace
            .replace_source(old.identity(), replacement)
            .unwrap();
        // A discovery request accepted before commit must not reveal the new
        // binding while the frontend still displays its previous source.
        let visible = workspace.accepted_custom_methods(Some(&accepted));
        assert_eq!(visible.len(), 1);
        assert_eq!(visible[0].service, "other");
        assert_eq!(workspace.accepted_custom_methods(None).len(), 1);
        let newly_accepted = workspace.custom_sources();
        assert_eq!(
            workspace
                .accepted_custom_methods(Some(&newly_accepted))
                .len(),
            2
        );
        assert!(workspace
            .accepted_custom_methods(Some(&Default::default()))
            .is_empty());
        assert!(workspace
            .custom_method(&original.name, &original.binding)
            .is_none());
        assert!(workspace
            .custom_method(&unaffected.name, &unaffected.binding)
            .is_some());
        old_service.finish.notify_one();
        let error = pending.await.unwrap().unwrap_err();
        assert_eq!(error.code, "closed");
        assert!(error.outcome_uncertain);
        assert!(
            !retained
                .call("acme.echo", serde_json::Value::Null)
                .await
                .unwrap_err()
                .outcome_uncertain
        );
        let info = workspace
            .custom_methods()
            .into_iter()
            .find(|info| info.service == "acme")
            .unwrap();
        assert_ne!(info.binding, original.binding);
        let new_handle = workspace.custom_method(&info.name, &info.binding).unwrap();
        new_service.finish.notify_one();
        assert_eq!(
            new_handle
                .call("acme.echo", serde_json::json!(42))
                .await
                .unwrap(),
            serde_json::json!(42)
        );
        retired.close().await.unwrap();
        workspace.disconnect().await.unwrap();
    }
    #[tokio::test]
    async fn replacement_cannot_steal_a_surviving_custom_method() {
        let old = source(21);
        let other = source(22);
        let fresh = source(23);
        let mut workspace = WorkspaceServices::new(vec![old.clone(), other.clone()]).unwrap();
        workspace.bind_custom(&old, Service::new()).unwrap();
        let mut nested = Service::new();
        Arc::get_mut(&mut nested).unwrap().descriptor = CustomServiceDescriptor {
            id: "acme.nested".into(),
            version: 1,
            methods: vec!["acme.nested.echo".into()],
        };
        workspace.bind_custom(&other, nested).unwrap();
        let original = workspace.custom_methods();
        let mut candidate = WorkspaceServices::new(vec![fresh.clone()]).unwrap();
        let mut conflicting = Service::new();
        Arc::get_mut(&mut conflicting).unwrap().descriptor.methods =
            vec!["acme.nested.echo".into()];
        candidate.bind_custom(&fresh, conflicting).unwrap();
        assert!(workspace.replace_source(old.identity(), candidate).is_err());
        assert_eq!(
            workspace
                .custom_methods()
                .iter()
                .map(|info| &info.binding)
                .collect::<Vec<_>>(),
            original
                .iter()
                .map(|info| &info.binding)
                .collect::<Vec<_>>()
        );
        workspace.disconnect().await.unwrap();
        fresh.disconnect().await.unwrap();
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
