// SPDX-License-Identifier: MPL-2.0
// Read-only SSH/PTY probe for appliances without SFTP or a POSIX shell.
// Uses normal known-host verification; never prints keys or remote output.
use shellcanvas_core::{ConnectOptions, Connection};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    anyhow::ensure!(
        args.len() == 4 || (args.len() == 5 && args[4] == "--legacy"),
        "Usage: terminal_probe HOST USER KEY_PATH [--legacy]"
    );
    let connection = Connection::connect(ConnectOptions {
        host: args[1].clone(),
        port: 22,
        username: args[2].clone(),
        key_path: args[3].clone(),
        password: None,
        passphrase: None,
        allow_legacy_mac: args.len() == 5,
    })
    .await?;
    println!("SSH authentication and known-host verification: OK");
    let mut terminal = connection.terminal(80, 24).await?;
    println!("PTY allocation and interactive shell: OK");
    let result = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        while let Some(message) = terminal.wait().await {
            if let russh::ChannelMsg::Data { data } = message {
                if !data.is_empty() {
                    return Ok(());
                }
            }
        }
        anyhow::bail!("Terminal closed before receiving output")
    })
    .await;
    terminal.close().await?;
    connection.disconnect().await?;
    result??;
    println!("Interactive terminal output received: OK");
    Ok(())
}
