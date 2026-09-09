// SPDX-License-Identifier: MPL-2.0
use shellcanvas_adapter_sdk::{json, tools};
use std::{fs, path::Path};
fn starter(root: &Path) -> std::path::PathBuf {
    let project = root.join("device");
    tools::create(
        &project,
        "example.device",
        "Device \"λ\"",
        Path::new(env!("CARGO_MANIFEST_DIR")),
    )
    .unwrap();
    project
}
#[test]
fn unknown_template_does_not_create_a_project() {
    let root = tempfile::tempdir().unwrap();
    let project = root.path().join("unknown");
    assert!(tools::create_template(
        &project,
        "example.device",
        "Device",
        Path::new(env!("CARGO_MANIFEST_DIR")),
        "typo"
    )
    .is_err());
    assert!(!project.exists());
}
#[test]
fn generated_project_packages_binary_assets_and_preserves_existing_outputs() {
    let root = tempfile::tempdir().unwrap();
    let project = starter(root.path());
    let executable = root.path().join("input.exe");
    let bytes: Vec<u8> = (0..200_003).map(|index| index as u8).collect();
    fs::write(&executable, &bytes).unwrap();
    let output = root.path().join("package");
    let manifest = tools::pack(
        &project.join("adapter.json"),
        &executable,
        &output,
        Some("1.2.3"),
    )
    .unwrap();
    let parsed = tools::validate(&manifest).unwrap();
    assert_eq!(parsed.version, "1.2.3");
    assert_eq!(parsed.name, "Device \"λ\"");
    assert_eq!(fs::read(output.join(&parsed.entrypoint)).unwrap(), bytes);
    let previous = fs::read(&manifest).unwrap();
    assert!(tools::pack(&project.join("adapter.json"), &executable, &output, None).is_err());
    assert_eq!(fs::read(&manifest).unwrap(), previous);
    assert!(tools::create(
        &project,
        "example.device",
        "Changed",
        Path::new(env!("CARGO_MANIFEST_DIR"))
    )
    .is_err());
    fs::write(output.join(&parsed.entrypoint), b"tampered").unwrap();
    assert!(tools::validate(&manifest).is_err());
}
#[test]
fn invalid_metadata_secrets_and_asset_paths_fail_before_output_creation() {
    let root = tempfile::tempdir().unwrap();
    let project = starter(root.path());
    let source = project.join("adapter.json");
    let original: serde_json::Value = serde_json::from_slice(&fs::read(&source).unwrap()).unwrap();
    let executable = root.path().join("input.exe");
    fs::write(&executable, b"fixture").unwrap();
    for alteration in 0..8 {
        let mut value = original.clone();
        match alteration {
            0 => value["extra"] = json!(true),
            1 => {
                value["configuration"] = json!([{"id":"password","label":"Password","kind":"password","default":"secret"}])
            }
            2 => value["files"][0]["path"] = json!("../outside"),
            3 => value["files"][0]["path"] = json!("CON.txt"),
            4 => value["version"] = json!("01.2.3"),
            5 => value["files"]
                .as_array_mut()
                .unwrap()
                .push(json!({"path":"adapter.json"})),
            6 => value["files"]
                .as_array_mut()
                .unwrap()
                .push(json!({"path":"bin"})),
            _ => value["files"][0]["executable"] = json!(false),
        }
        fs::write(&source, serde_json::to_vec(&value).unwrap()).unwrap();
        let output = root.path().join(format!("bad-{alteration}"));
        assert!(
            tools::pack(&source, &executable, &output, None).is_err(),
            "case {alteration}"
        );
        assert!(!output.exists(), "case {alteration} created output");
    }
}
#[test]
fn manifest_validation_retains_native_configuration_rules() {
    let root = tempfile::tempdir().unwrap();
    let project = starter(root.path());
    let source = project.join("adapter.json");
    let mut value: serde_json::Value = serde_json::from_slice(&fs::read(&source).unwrap()).unwrap();
    value["configuration"] = json!([{"id":"port","label":"Port","kind":"number","default":22},{"id":"token","label":"Token","kind":"password","required":true}]);
    fs::write(&source, serde_json::to_vec(&value).unwrap()).unwrap();
    let manifest = tools::source_manifest(&source, None).unwrap();
    assert!(manifest.validate_configuration(&json!({})).is_err());
    assert!(manifest
        .validate_configuration(&json!({"token":"secret","unexpected":1}))
        .is_err());
    assert_eq!(
        manifest
            .validate_configuration(&json!({"token":"secret"}))
            .unwrap(),
        json!({"token":"secret","port":22})
    );
}
