// SPDX-License-Identifier: MPL-2.0
// Device inspection is read-only. --save-test writes/removes one unique test file.
use shellcanvas_core::{clock::SshHostClock, *};
use std::sync::Arc;
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<_> = std::env::args().collect();
    anyhow::ensure!(
        args.len() == 4 || (args.len() == 5 && args[4] == "--save-test"),
        "Usage: routeros_probe HOST USER KEY_PATH [--save-test]"
    );
    let connection = Arc::new(
        Connection::connect(ConnectOptions {
            host: args[1].clone(),
            port: 22,
            username: args[2].clone(),
            key_path: args[3].clone(),
            password: None,
            passphrase: None,
            allow_legacy_mac: true,
        })
        .await?,
    );
    let info = inspect_host(&connection).await;
    anyhow::ensure!(info.provider == "routeros", "RouterOS was not detected");
    println!(
        "Provider: {}; system: {}; identity detected: {}",
        info.provider,
        info.system,
        !info.hostname.is_empty()
    );
    let sample = SshHostClock::for_provider(connection.clone(), &info.provider)
        .unwrap()
        .read()
        .await?;
    println!(
        "Remote clock: unix_ms={}, offset_minutes={}",
        sample.unix_ms, sample.offset_minutes
    );
    if args.len() == 5 {
        let service = connection.text_files().await?;
        let name = format!("shellcanvas-save-test-{}.txt", uuid::Uuid::new_v4());
        let original = service
            .create_text("/", &name, "ShellCanvas disposable save test\n")
            .await?;
        let path = original.path.clone();
        let result: anyhow::Result<()> = async {
            anyhow::ensure!(
                original.save_requires_confirmation,
                "Expected a non-atomic server"
            );
            anyhow::ensure!(
                service
                    .save_text(&path, "not permitted", &original.revision)
                    .await
                    .is_err(),
                "Unconfirmed write succeeded"
            );
            anyhow::ensure!(
                service.read_text(&path).await?.text == original.text,
                "Unconfirmed write changed data"
            );
            let saved = service
                .save_text_confirmed(&path, "Verified ✓\n", &original.revision, true)
                .await?;
            anyhow::ensure!(saved.text == "Verified ✓\n", "Save readback mismatch");
            let empty = service
                .save_text_confirmed(&path, "", &saved.revision, true)
                .await?;
            anyhow::ensure!(empty.text.is_empty(), "Empty save mismatch");
            Ok(())
        }
        .await;
        // Remove only the unique file whose creation this probe confirmed.
        connection.sftp().await?.remove_file(&path).await?;
        result?;
        println!(
            "Unconfirmed refusal, confirmed replacement, empty save and test-file cleanup: OK"
        );
    }
    connection.disconnect().await?;
    Ok(())
}
