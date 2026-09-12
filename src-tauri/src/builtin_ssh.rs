// SPDX-License-Identifier: MPL-2.0
use crate::adapters::AdapterSource;
use shellcanvas_adapter_runtime::catalog::AdapterInfo;
pub const ID: &str = "builtin:ssh";
pub const REVISION: &str = "builtin-1";
pub fn info() -> AdapterInfo {
    serde_json::from_value(serde_json::json!({
        "id":ID,"name":"SSH (built in)","version":"1.0.0","description":"Built-in SSH with host-key verification.","platform":"builtin","entrypoint":"","configuration":[
            {"id":"host","label":"Host","kind":"text","required":true},
            {"id":"port","label":"Port","kind":"number","default":22,"required":true},
            {"id":"username","label":"Username","kind":"text","required":true},
            {"id":"keyPath","label":"Private key path","kind":"text","default":""},
            {"id":"allowLegacyMac","label":"Allow legacy SSH: HMAC-SHA1, RSA/SHA1, 2048-bit groups","kind":"boolean","default":false},
            {"id":"password","label":"Password","kind":"password"},
            {"id":"passphrase","label":"Key passphrase","kind":"password"}
        ],"generation":"builtin","revision":REVISION,"enabled":true,"fileCount":0,"bytes":0
    })).expect("Built-in SSH descriptor")
}
pub fn options(source: &AdapterSource) -> Result<shellcanvas_core::ConnectOptions, String> {
    if source.revision != REVISION {
        return Err("Built-in SSH configuration changed; reopen the connection form".into());
    }
    let mut values = source
        .configuration
        .as_object()
        .ok_or("SSH configuration must be an object")?
        .clone();
    let descriptor = info();
    if values.keys().any(|key| {
        !descriptor
            .configuration
            .iter()
            .any(|field| &field.id == key)
    }) {
        return Err("Unknown SSH configuration field".into());
    }
    for field in descriptor.configuration {
        if let Some(value) = field.default {
            values.entry(field.id).or_insert(value);
        }
    }
    let options: shellcanvas_core::ConnectOptions =
        serde_json::from_value(serde_json::Value::Object(values))
            .map_err(|_| "Invalid SSH connection settings")?;
    if options.host.trim().is_empty() || options.username.trim().is_empty() || options.port == 0 {
        return Err("SSH requires a host, username and valid port".into());
    }
    Ok(options)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn builtin_descriptor_cannot_collide_with_a_package_and_configuration_is_strict() {
        let descriptor = info();
        assert!(descriptor.id.contains(':'));
        let mut source = AdapterSource {
            key: "ssh".into(),
            id: ID.into(),
            revision: REVISION.into(),
            configuration: serde_json::json!({"host":"device","username":"root"}),
        };
        let parsed = options(&source).unwrap();
        assert_eq!(parsed.port, 22);
        assert_eq!(parsed.key_path, "");
        assert!(parsed.password.is_none());
        source.configuration["port"] = serde_json::json!(0);
        assert!(options(&source).is_err());
        source.configuration["port"] = serde_json::json!(22);
        source.configuration["command"] = serde_json::json!("ignored");
        assert!(options(&source).is_err());
        source
            .configuration
            .as_object_mut()
            .unwrap()
            .remove("command");
        source.revision = "old".into();
        assert!(options(&source).is_err());
    }
}
