// SPDX-License-Identifier: MPL-2.0
use crate::{CommandProbe, HostClock, HostClockSample};
use anyhow::{bail, Context, Result};
use async_trait::async_trait;
use std::sync::Arc;

pub struct SshHostClock {
    commands: Arc<dyn CommandProbe>,
    command: String,
    routeros: bool,
    timeout: std::time::Duration,
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
            "routeros" => "/system clock print".to_owned(),
            _ => return None,
        };
        Some(Arc::new(Self {
            commands,
            command,
            routeros: provider == "routeros",
            // Starting Windows PowerShell can exceed five seconds on a busy
            // host. Keep it bounded by the same budget as other host probes.
            timeout: if provider == "windows" {
                crate::OP_TIMEOUT
            } else {
                std::time::Duration::from_secs(5)
            },
        }))
    }
}
#[async_trait]
impl HostClock for SshHostClock {
    async fn read(&self) -> Result<HostClockSample> {
        let output = tokio::time::timeout(self.timeout, self.commands.probe(&self.command))
            .await
            .context("Host clock timed out")??;
        if self.routeros {
            parse_routeros_sample(&output)
        } else {
            parse_sample(&output)
        }
    }
}
fn parse_routeros_sample(output: &str) -> Result<HostClockSample> {
    let field = |name: &str| -> Result<&str> {
        let mut values = output.lines().filter_map(|line| {
            let (key, value) = line.trim().split_once(':')?;
            (key == name).then_some(value.trim())
        });
        let value = values.next().context("Missing RouterOS clock field")?;
        if values.next().is_some() {
            bail!("Duplicate RouterOS clock field");
        }
        Ok(value)
    };
    let date = field("date")?;
    let date = chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d")
        .or_else(|_| chrono::NaiveDate::parse_from_str(date, "%b/%d/%Y"))
        .context("Invalid RouterOS date")?;
    let time = chrono::NaiveTime::parse_from_str(field("time")?, "%H:%M:%S")
        .context("Invalid RouterOS time")?;
    let offset = parse_sample(&format!("0 {}", field("gmt-offset")?))?.offset_minutes;
    Ok(HostClockSample {
        unix_ms: date.and_time(time).and_utc().timestamp_millis() - i64::from(offset) * 60_000,
        offset_minutes: offset,
    })
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
    struct DelayedProbe(std::time::Duration);
    #[async_trait]
    impl CommandProbe for DelayedProbe {
        async fn probe(&self, _: &str) -> Result<String> {
            tokio::time::sleep(self.0).await;
            Ok("1789214400 +03:00".into())
        }
    }
    #[tokio::test(start_paused = true)]
    async fn windows_clock_allows_slow_startup_but_remains_bounded() {
        let slow = Arc::new(DelayedProbe(std::time::Duration::from_secs(6)));
        assert!(SshHostClock::for_provider(slow.clone(), "windows")
            .unwrap()
            .read()
            .await
            .is_ok());
        assert!(SshHostClock::for_provider(slow, "linux")
            .unwrap()
            .read()
            .await
            .is_err());
        let stalled = Arc::new(DelayedProbe(std::time::Duration::from_secs(60)));
        let started = tokio::time::Instant::now();
        assert!(SshHostClock::for_provider(stalled, "windows")
            .unwrap()
            .read()
            .await
            .is_err());
        assert!(started.elapsed() <= crate::OP_TIMEOUT);
    }
    #[test]
    fn routeros_v6_and_v7_clock_formats() {
        for date in ["sep/12/2026", "2026-09-12"] {
            let sample = parse_routeros_sample(&format!(
                " time: 15:00:00\r\n date: {date}\r\n gmt-offset: +03:00\r\n dst-active: yes"
            ))
            .unwrap();
            assert_eq!(sample.unix_ms, 1_789_214_400_000);
            assert_eq!(sample.offset_minutes, 180);
        }
        for text in [
            "",
            "date: 2026-02-30\ntime: 10:00:00\ngmt-offset: +00:00",
            "date: 2026-09-12\ntime: 25:00:00\ngmt-offset: +03:00",
            "date: 2026-09-12\ntime: 10:00:00\ngmt-offset: +24:00",
            "date: 2026-09-12\ntime: 10:00:00\ntime: 11:00:00\ngmt-offset: +03:00",
        ] {
            assert!(parse_routeros_sample(text).is_err(), "{text}");
        }
    }
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
