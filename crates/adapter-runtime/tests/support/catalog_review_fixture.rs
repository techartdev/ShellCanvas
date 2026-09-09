// SPDX-License-Identifier: MPL-2.0
// Test-only process that retains an actual review until stdin closes or it is killed.
use shellcanvas_adapter_runtime::catalog::Catalog;
use std::{
    io::{self, Write},
    path::PathBuf,
    sync::atomic::AtomicBool,
};
fn main() -> anyhow::Result<()> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    anyhow::ensure!(
        args.len() == 2,
        "Expected catalog and source manifest paths"
    );
    let catalog = Catalog::new(PathBuf::from(&args[0]));
    let review = catalog.review(&PathBuf::from(&args[1]), &AtomicBool::new(false))?;
    println!("ready");
    io::stdout().flush()?;
    let mut line = String::new();
    io::stdin().read_line(&mut line)?;
    drop(review);
    Ok(())
}
