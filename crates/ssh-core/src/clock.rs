// SPDX-License-Identifier: MPL-2.0
use crate::{CommandProbe, HostClock, HostClockSample};
use anyhow::{bail, Context, Result};
use async_trait::async_trait;
use std::sync::Arc;

pub struct SshHostClock {
    commands: Arc<dyn CommandProbe>,
    command: String,
}
impl SshHostClock {
    pub fn for_provider(
        commands: Arc<dyn CommandProbe>,
        provider: &str,
    ) -> Option<Arc<dyn HostClock>> {
        let command = match provider {
            "linux" | "macos" => "LC_ALL=C date '+%s %z'".to_owned(),
            "windows" => crate::volumes::powershell(
                "$t=[DateTimeOffset]::Now; $t.ToUnixTimeSeconds().ToString([Globalization.CultureInfo]::InvariantCulture) + ' ' + $t.ToString('zzz')",
            ),
            _ => return None,
        };
        Some(Arc::new(Self { commands, command }))
    }
}
#[async_trait]
impl HostClock for SshHostClock {
    async fn read(&self) -> Result<HostClockSample> {
        let output = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            self.commands.probe(&self.command),
        )
        .await
        .context("Host clock timed out")??;
        parse_sample(&output)
    }
}
fn parse_sample(output: &str) -> Result<HostClockSample> {
    let fields: Vec<_> = output.split_whitespace().collect();
    if fields.len() != 2 {
        bail!("Invalid host clock response");
    }
    let seconds: i64 = fields[0].parse().context("Invalid host timestamp")?;
    // Keep the value within JavaScript Date's supported range.
    if !(-8_640_000_000_000..=8_640_000_000_000).contains(&seconds) {
        bail!("Host timestamp is out of range");
    }
    let offset = fields[1].replace(':', "");
    let bytes = offset.as_bytes();
    if bytes.len() != 5
        || !matches!(bytes[0], b'+' | b'-')
        || !bytes[1..].iter().all(u8::is_ascii_digit)
    {
        bail!("Invalid host UTC offset");
    }
    let hours: i32 = offset[1..3].parse()?;
    let minutes: i32 = offset[3..5].parse()?;
    if hours > 23 || minutes > 59 {
        bail!("Invalid host UTC offset");
    }
    Ok(HostClockSample {
        unix_ms: seconds * 1000,
        offset_minutes: (hours * 60 + minutes) * if bytes[0] == b'-' { -1 } else { 1 },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reads_unix_and_windows_offsets() {
        for (text, minutes) in [
            ("1789214400 +0300", 180),
            ("1789214400 -07:00", -420),
            ("1789214400 +0545", 345),
            ("1789214400 +0000", 0),
        ] {
            let sample = parse_sample(text).unwrap();
            assert_eq!(sample.unix_ms, 1_789_214_400_000);
            assert_eq!(sample.offset_minutes, minutes);
        }
    }
    #[test]
    fn rejects_malformed_samples() {
        for text in [
            "",
            "banner 1789214400 +0300",
            "1789214400 UTC",
            "1789214400 +2400",
            "1789214400 +0360",
            "999999999999999 +0000",
        ] {
            assert!(parse_sample(text).is_err(), "{text}");
        }
    }
}
