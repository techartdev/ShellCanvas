// SPDX-License-Identifier: MPL-2.0
use shellcanvas_adapter_sdk::tools;
use std::path::Path;
fn main() -> anyhow::Result<()> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    match args.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
        ["init", directory, "--id", id, "--name", name, "--sdk-source", sdk] => tools::create(Path::new(directory), id, name, Path::new(sdk))?,
        ["pack", source, executable, output] => println!("{}", tools::pack(Path::new(source), Path::new(executable), Path::new(output), None)?.display()),
        ["pack", source, executable, output, "--version", version] => println!("{}", tools::pack(Path::new(source), Path::new(executable), Path::new(output), Some(version))?.display()),
        ["build", directory, output] => println!("{}", tools::build(Path::new(directory), Path::new(output), false)?.display()),
        ["build", directory, output, "--debug"] => println!("{}", tools::build(Path::new(directory), Path::new(output), true)?.display()),
        ["validate", manifest] => { let manifest = tools::validate(Path::new(manifest))?; println!("Verified {} {} ({} assets)", manifest.id, manifest.version, manifest.files.len()); }
        ["schema", "source"] => println!("{}", tools::SOURCE_SCHEMA),
        ["schema", "package"] => println!("{}", tools::PACKAGE_SCHEMA),
        [] | ["--help"] => println!("shellcanvas-adapter init DIR --id ID --name NAME --sdk-source SDK_DIR\nshellcanvas-adapter build DIR NEW_OUTPUT [--debug]\nshellcanvas-adapter pack SOURCE_JSON EXECUTABLE NEW_OUTPUT\nshellcanvas-adapter validate PACKAGE_JSON\nshellcanvas-adapter schema source|package"),
        _ => anyhow::bail!("Unknown arguments; use --help"),
    }
    Ok(())
}
