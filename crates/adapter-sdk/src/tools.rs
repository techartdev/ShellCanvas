// SPDX-License-Identifier: MPL-2.0
//! Standalone project generation and package tooling. Never installs or connects.
use crate::package::{relative, Manifest, PackageFile};
use anyhow::{bail, Context, Result};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    process::Command,
};

pub const SOURCE_SCHEMA: &str = include_str!("../schemas/adapter-source.schema.json");
pub const PACKAGE_SCHEMA: &str = include_str!("../schemas/adapter-package.schema.json");

fn read_json(path: &Path) -> Result<Value> {
    let mut bytes = vec![];
    File::open(path)?
        .take(1024 * 1024 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > 1024 * 1024 {
        bail!("Adapter manifest exceeds 1 MiB");
    }
    serde_json::from_slice(&bytes).context("Invalid adapter manifest JSON")
}
pub fn platform() -> String {
    format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SourceFile {
    path: String,
    #[serde(default)]
    executable: bool,
}
/// Expand source placeholders and validate through the same model as the host.
pub fn source_manifest(path: &Path, version: Option<&str>) -> Result<Manifest> {
    let mut value = read_json(path)?;
    let object = value
        .as_object_mut()
        .context("Source manifest must be an object")?;
    let expand = |name: &str| name.replace("{exe}", std::env::consts::EXE_SUFFIX);
    let files: Vec<SourceFile> =
        serde_json::from_value(object.get("files").context("Missing files")?.clone())?;
    object.insert(
        "files".into(),
        serde_json::to_value(
            files
                .into_iter()
                .map(|file| PackageFile {
                    path: expand(&file.path),
                    size: 0,
                    sha256: "0".repeat(64),
                    executable: file.executable,
                })
                .collect::<Vec<_>>(),
        )?,
    );
    let entrypoint = expand(
        object
            .get("entrypoint")
            .and_then(Value::as_str)
            .context("Missing entrypoint")?,
    );
    object.insert("entrypoint".into(), json!(entrypoint));
    if object.get("platform").and_then(Value::as_str) == Some("current") {
        object.insert("platform".into(), json!(platform()));
    }
    if let Some(version) = version {
        object.insert("version".into(), json!(version));
    }
    let manifest: Manifest = serde_json::from_value(value)?;
    manifest.validate()?;
    tool_paths(&manifest)?;
    Ok(manifest)
}
fn tool_paths(manifest: &Manifest) -> Result<()> {
    let paths: Vec<_> = manifest
        .files
        .iter()
        .map(|file| file.path.to_lowercase())
        .collect();
    for path in &paths {
        if path == "adapter.json"
            || path.starts_with("adapter.json/")
            || paths
                .iter()
                .any(|other| other != path && other.starts_with(&format!("{path}/")))
        {
            bail!("Package assets conflict with a directory or reserved manifest path");
        }
    }
    Ok(())
}
fn asset(root: &Path, name: &str) -> Result<PathBuf> {
    relative(name)?;
    let mut path = root.to_path_buf();
    for part in name.split('/') {
        path.push(part);
        if fs::symlink_metadata(&path)?.file_type().is_symlink() {
            bail!("Package assets cannot be symbolic links");
        }
    }
    let canonical = path.canonicalize()?;
    if !canonical.starts_with(root.canonicalize()?) || !fs::metadata(&canonical)?.is_file() {
        bail!("Package asset escapes its directory");
    }
    Ok(canonical)
}
fn copy_hash(input: &Path, mut output: impl Write) -> Result<(u64, String)> {
    if !fs::symlink_metadata(input)?.is_file() {
        bail!("Package assets must be regular files");
    }
    let mut file = File::open(input)?;
    let mut digest = Sha256::new();
    let mut size = 0u64;
    let mut chunk = [0; 65536];
    loop {
        let count = file.read(&mut chunk)?;
        if count == 0 {
            break;
        }
        output.write_all(&chunk[..count])?;
        digest.update(&chunk[..count]);
        size = size
            .checked_add(count as u64)
            .context("Asset size overflow")?;
    }
    Ok((size, format!("{:x}", digest.finalize())))
}
/// Write a new package directory; existing output is never overwritten.
/// The manifest is published last. A failed pack may leave an incomplete output
/// directory, which must not be installed. Choose a fresh output for a retry.
pub fn pack(
    source: &Path,
    executable: &Path,
    output: &Path,
    version: Option<&str>,
) -> Result<PathBuf> {
    let source = source.canonicalize()?;
    let root = source.parent().context("Missing source parent")?;
    let mut manifest = source_manifest(&source, version)?;
    let mut inputs = vec![];
    for file in &manifest.files {
        let input = if file.path == manifest.entrypoint {
            executable.to_path_buf()
        } else {
            asset(root, &file.path)?
        };
        if !fs::symlink_metadata(&input)?.is_file() {
            bail!("Package assets must be regular files");
        }
        inputs.push(input);
    }
    // Reserve this new output directory; no rename-over-existing behavior.
    fs::create_dir(output).context("Choose a new package output directory")?;
    for (file, input) in manifest.files.iter_mut().zip(inputs) {
        let destination = output.join(&file.path);
        fs::create_dir_all(destination.parent().context("Missing asset parent")?)?;
        let mut target = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&destination)?;
        let (size, sha256) = copy_hash(&input, &mut target)?;
        target.sync_all()?;
        file.size = size;
        file.sha256 = sha256;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(
                destination,
                fs::Permissions::from_mode(if file.executable { 0o700 } else { 0o600 }),
            )?;
        }
    }
    manifest.validate()?;
    let bytes = serde_json::to_vec_pretty(&manifest)?;
    if bytes.len() > 1024 * 1024 {
        bail!("Packed manifest exceeds 1 MiB");
    }
    let path = output.join("adapter.json");
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&path)?;
    file.write_all(&bytes)?;
    file.sync_all()?;
    Ok(path)
}
/// Verify manifest and all declared hashes, without executing the package.
pub fn validate(path: &Path) -> Result<Manifest> {
    let manifest: Manifest = serde_json::from_value(read_json(path)?)?;
    manifest.validate()?;
    tool_paths(&manifest)?;
    let root = path.parent().context("Missing package parent")?;
    for file in &manifest.files {
        let (size, hash) = copy_hash(&asset(root, &file.path)?, std::io::sink())?;
        if size != file.size || hash != file.sha256 {
            bail!("Package asset does not match its manifest: {}", file.path);
        }
    }
    Ok(manifest)
}

/// Generate a new Rust adapter project which consumes an independently supplied SDK.
pub fn create(directory: &Path, id: &str, name: &str, sdk_source: &Path) -> Result<()> {
    if !crate::wire::name(id)
        || !id.contains('.')
        || id.starts_with("system.")
        || name.trim().is_empty()
        || name.len() > 200
    {
        bail!("Choose a namespaced adapter ID and a nonempty name of at most 200 bytes");
    }
    let sdk = sdk_source.canonicalize()?;
    if !sdk.join("Cargo.toml").is_file() {
        bail!("SDK source directory needs Cargo.toml");
    }
    let sdk_path = sdk.to_str().context("SDK source path must be UTF-8")?;
    let cargo = format!("[package]\nname = \"shellcanvas-device\"\nversion = \"0.1.0\"\nedition = \"2021\"\nlicense = \"MPL-2.0\"\n\n[workspace]\n\n[dependencies]\nshellcanvas-adapter-sdk = {{ version = \"0.1.0\", path = {} }}\n", serde_json::to_string(sdk_path)?);
    let code =
        include_str!("../templates/main.rs.txt").replace("__SERVICE_LITERAL__", &format!("{id:?}"));
    let manifest = json!({"schemaVersion":1,"id":id,"name":name,"version":"0.1.0","description":"A generated synthetic adapter. Replace its services with your device implementation.","platform":"current","entrypoint":"bin/shellcanvas-device{exe}","files":[{"path":"bin/shellcanvas-device{exe}","executable":true}],"configuration":[]});
    fs::create_dir(directory).context("Starter generation requires a new directory")?;
    fs::create_dir(directory.join("src"))?;
    fs::write(directory.join("Cargo.toml"), cargo)?;
    fs::write(directory.join("src/main.rs"), code)?;
    fs::write(
        directory.join("adapter.json"),
        serde_json::to_vec_pretty(&manifest)?,
    )?;
    fs::write(
        directory.join("README.md"),
        include_str!("../templates/README.md"),
    )?;
    fs::write(directory.join(".gitignore"), "/target/\n/packages/\n")?;
    Ok(())
}
/// Build a generated project, then package its executable. Other languages can
/// use pack directly after compiling their adapter.
pub fn build(directory: &Path, output: &Path, debug: bool) -> Result<PathBuf> {
    if output.exists() {
        bail!("Choose a new package output directory");
    }
    let directory = directory.canonicalize()?;
    source_manifest(&directory.join("adapter.json"), None)?;
    let mut command = Command::new("cargo");
    command
        .current_dir(&directory)
        .args(["build", "--bin", "shellcanvas-device", "--target-dir"])
        .arg(directory.join("target"));
    if !debug {
        command.arg("--release");
    }
    if directory.join("Cargo.lock").exists() {
        command.arg("--locked");
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    if !command.status()?.success() {
        bail!("Adapter build failed");
    }
    let executable = directory
        .join("target")
        .join(if debug { "debug" } else { "release" })
        .join(format!(
            "shellcanvas-device{}",
            std::env::consts::EXE_SUFFIX
        ));
    pack(&directory.join("adapter.json"), &executable, output, None)
}
