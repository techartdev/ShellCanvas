// SPDX-License-Identifier: MPL-2.0
use super::*;
use std::sync::Mutex as StdMutex;
struct Fake {
    hostname: StdMutex<String>,
    zone: StdMutex<String>,
    calls: StdMutex<Vec<String>>,
    root: bool,
    timezone_missing: bool,
    fail_change: bool,
    fail_verify: bool,
}
impl Fake {
    fn new() -> Self {
        Self {
            hostname: StdMutex::new("atlas".into()),
            zone: StdMutex::new("Etc/UTC".into()),
            calls: StdMutex::new(vec![]),
            root: true,
            timezone_missing: false,
            fail_change: false,
            fail_verify: false,
        }
    }
}
#[async_trait]
impl SettingsCommands for Fake {
    async fn run(&self, command: &str) -> Result<String> {
        self.calls.lock().unwrap().push(command.into());
        match command {
            "id -u" => Ok(if self.root { "0" } else { "1000" }.into()),
            READ_HOSTNAME => {
                if self.fail_verify
                    && self
                        .calls
                        .lock()
                        .unwrap()
                        .iter()
                        .any(|c| c.contains("set-hostname"))
                {
                    bail!("Readback unavailable");
                }
                Ok(self.hostname.lock().unwrap().clone())
            }
            READ_TIMEZONE if !self.timezone_missing => Ok(self.zone.lock().unwrap().clone()),
            READ_ZONES if !self.timezone_missing => {
                Ok("Etc/UTC\nEurope/Sofia\n../../invalid\nBad'Zone".into())
            }
            _ if command.contains("set-hostname '") || command.contains("set-timezone '") => {
                if self.fail_change {
                    bail!("connection lost");
                }
                let value = command.split('\'').nth(1).unwrap();
                if command.contains("set-hostname") {
                    *self.hostname.lock().unwrap() = value.into();
                } else {
                    *self.zone.lock().unwrap() = value.into();
                }
                Ok(String::new())
            }
            _ => bail!("Unavailable command"),
        }
    }
}
#[tokio::test]
async fn partial_and_readonly_fields_still_report_available_values() {
    let service = LinuxSettings::new(Arc::new(Fake {
        root: false,
        timezone_missing: true,
        ..Fake::new()
    }));
    let fields = service.read().await.unwrap();
    assert_eq!(fields[0].value.as_deref(), Some("atlas"));
    assert!(!fields[0].writable);
    assert!(fields[0].reason.as_ref().unwrap().contains("root"));
    assert!(fields[1].value.is_none());
    assert!(!fields[1].writable);
    assert!(service
        .apply(HOSTNAME, "new-host", fields[0].revision.as_ref().unwrap())
        .await
        .is_err());
}
#[tokio::test]
async fn rejects_unknown_fields_shell_syntax_and_stale_values_before_changing_anything() {
    let commands = Arc::new(Fake::new());
    let service = LinuxSettings::new(commands.clone());
    for value in [
        "host;id", "$(id)", "a'b", "--help", "a..b", "bad-", "UPPER", "a\nb",
    ] {
        assert!(service.apply(HOSTNAME, value, "revision").await.is_err());
    }
    assert!(service
        .apply(TIMEZONE, "../../etc/shadow", "revision")
        .await
        .is_err());
    assert!(service
        .apply("untrusted.command", "value", "revision")
        .await
        .is_err());
    assert!(commands.calls.lock().unwrap().is_empty());
    let fields = service.read().await.unwrap();
    *commands.hostname.lock().unwrap() = "external-change".into();
    assert!(service
        .apply(HOSTNAME, "wanted", fields[0].revision.as_ref().unwrap())
        .await
        .unwrap_err()
        .to_string()
        .contains("changed"));
    assert!(service
        .apply(
            TIMEZONE,
            "Unknown/Zone",
            fields[1].revision.as_ref().unwrap()
        )
        .await
        .is_err());
    assert!(!commands
        .calls
        .lock()
        .unwrap()
        .iter()
        .any(|c| c.contains("set-hostname") || c.contains("set-timezone")));
}
#[tokio::test]
async fn applies_one_field_and_verifies_it_without_repeating_noop_writes() {
    let commands = Arc::new(Fake::new());
    let service = LinuxSettings::new(commands.clone());
    let fields = service.read().await.unwrap();
    assert_eq!(fields[1].choices, ["Etc/UTC", "Europe/Sofia"]);
    let result = service
        .apply(
            HOSTNAME,
            "new-host.example",
            fields[0].revision.as_ref().unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(result.value.as_deref(), Some("new-host.example"));
    assert_ne!(result.revision, fields[0].revision);
    service
        .apply(
            HOSTNAME,
            "new-host.example",
            result.revision.as_ref().unwrap(),
        )
        .await
        .unwrap();
    let zone = service
        .apply(
            TIMEZONE,
            "Europe/Sofia",
            fields[1].revision.as_ref().unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(zone.value.as_deref(), Some("Europe/Sofia"));
    let calls = commands.calls.lock().unwrap();
    assert_eq!(
        calls.iter().filter(|c| c.contains("set-hostname")).count(),
        1
    );
    assert_eq!(
        calls.iter().filter(|c| c.contains("set-timezone")).count(),
        1
    );
}
#[tokio::test]
async fn a_failed_mutation_reports_uncertainty() {
    let service = LinuxSettings::new(Arc::new(Fake {
        fail_change: true,
        ..Fake::new()
    }));
    let fields = service.read().await.unwrap();
    let error = service
        .apply(HOSTNAME, "new-host", fields[0].revision.as_ref().unwrap())
        .await
        .unwrap_err();
    assert!(format!("{error:#}").contains("may already have applied"));
}

#[tokio::test]
async fn successful_command_without_readback_is_not_reported_as_success() {
    let service = LinuxSettings::new(Arc::new(Fake {
        fail_verify: true,
        ..Fake::new()
    }));
    let fields = service.read().await.unwrap();
    let error = service
        .apply(HOSTNAME, "new-host", fields[0].revision.as_ref().unwrap())
        .await
        .unwrap_err();
    assert!(error.to_string().contains("could not be verified"));
}

#[tokio::test]
async fn serializes_changes_with_the_same_revision_and_does_not_supply_settings_to_unknown_providers(
) {
    let commands = Arc::new(Fake::new());
    assert!(crate::settings_for_host("generic-ssh", Some(commands.clone())).is_none());
    assert!(crate::settings_for_host("linux", None).is_none());
    let service = crate::settings_for_host("linux", Some(commands)).unwrap();
    let fields = service.read().await.unwrap();
    let expected = fields[0].revision.as_ref().unwrap();
    let (first, second) = tokio::join!(
        service.apply(HOSTNAME, "first", expected),
        service.apply(HOSTNAME, "second", expected)
    );
    assert_ne!(first.is_ok(), second.is_ok());
}
