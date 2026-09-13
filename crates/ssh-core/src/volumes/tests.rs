// SPDX-License-Identifier: MPL-2.0
use super::*;
use serde_json::json;

struct RecoveringWindowsProbe(std::sync::atomic::AtomicUsize);
#[async_trait]
impl CommandProbe for RecoveringWindowsProbe {
    async fn probe(&self, command: &str) -> Result<String> {
        let attempt = self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        if command == "uname -s" || attempt < 2 {
            bail!("Transient or unsupported command");
        }
        Ok("Windows".into())
    }
}

#[tokio::test]
async fn failed_platform_detection_can_recover_on_refresh() {
    let probe = RecoveringWindowsProbe(std::sync::atomic::AtomicUsize::new(0));
    let cache = OnceCell::new();
    assert_eq!(discover_platform(&cache, &probe).await, Platform::Other);
    assert!(cache.get().is_none());
    assert_eq!(discover_platform(&cache, &probe).await, Platform::Windows);
    assert_eq!(discover_platform(&cache, &probe).await, Platform::Windows);
    assert_eq!(probe.0.load(std::sync::atomic::Ordering::SeqCst), 4);
}

#[tokio::test]
async fn confirmed_host_platform_needs_no_second_probe() {
    for (id, expected) in [
        ("windows", Platform::Windows),
        ("linux", Platform::Linux),
        ("macos", Platform::Mac),
    ] {
        let cache = OnceCell::new_with(known_platform(id));
        let probe = RecoveringWindowsProbe(std::sync::atomic::AtomicUsize::new(0));
        assert_eq!(discover_platform(&cache, &probe).await, expected);
        assert_eq!(probe.0.load(std::sync::atomic::Ordering::SeqCst), 0);
    }
    assert!(known_platform("generic-ssh").is_none());
}

#[test]
fn linux_mounts_preserve_spaces_network_bind_and_system_locations() {
    let mut snapshot = linux_mounts("1 0 8:1 / / rw - ext4 /dev/sda1 rw\n2 1 8:2 / /media/My\\040Disk rw - ext4 /dev/sdb1 rw\n3 1 0:4 / /mnt/team\\134040 rw - nfs server:/share rw\n4 1 0:5 / /proc rw - proc proc rw\n5 1 8:2 /projects /mnt/projects rw - ext4 /dev/sdb1 rw").unwrap();
    linux_blocks(
        &mut snapshot,
        &json!({"blockdevices":[{"name":"/dev/sda1","fstype":"ext4","uuid":"root"},{"name":"/dev/sdb1","fstype":"ext4","label":"Work","uuid":"work"},{"name":"/dev/sdc1","fstype":"ext4","uuid":"new"},{"name":"/dev/sdd1","fstype":"crypto_LUKS"}]}),
        true,
    );
    let root = snapshot
        .volumes
        .iter()
        .find(|v| v.id == "block:/dev/sda1|root")
        .unwrap();
    assert!(root.system);
    assert!(!root.can_unmount);
    let work = snapshot.volumes.iter().find(|v| v.name == "Work").unwrap();
    assert_eq!(work.locations[0].path, "/media/My Disk");
    assert_eq!(work.locations.len(), 2);
    assert!(!work.can_unmount);
    assert!(snapshot
        .volumes
        .iter()
        .any(|v| v.locations.iter().any(|p| p.path == "/mnt/team\\040")));
    assert!(snapshot
        .volumes
        .iter()
        .any(|v| v.can_mount && v.id == "block:/dev/sdc1|new"));
    assert!(!snapshot.volumes.iter().any(|v| v.id.contains("sdd")));
}
#[test]
fn mac_apfs_volumes_and_network_locations_are_distinct() {
    let mut snapshot = mac_volumes(
        &json!({"AllDisksAndPartitions":[{"DeviceIdentifier":"disk1","APFSVolumes":[{"DeviceIdentifier":"disk1s1","VolumeName":"Macintosh HD","MountPoint":"/","VolumeUUID":"root"},{"DeviceIdentifier":"disk1s2","VolumeName":"Data","MountPoint":"/System/Volumes/Data"},{"DeviceIdentifier":"disk1s3","VolumeName":"Recovery"}]},{"Partitions":[{"DeviceIdentifier":"disk2s1","VolumeName":"Photos","MountPoint":"/Volumes/Photos"},{"DeviceIdentifier":"disk2s2","VolumeName":"Archive"}]}]}),
    );
    mac_mounts(&mut snapshot,"/dev/disk2s1 on /Volumes/Photos (hfs, local)\n//user@server/team on /Volumes/Team Files (smbfs, nodev)");
    assert_eq!(snapshot.volumes.len(), 6);
    assert_eq!(snapshot.volumes.iter().filter(|v| v.can_unmount).count(), 1);
    assert_eq!(snapshot.volumes.iter().filter(|v| v.can_mount).count(), 1);
    assert!(snapshot
        .volumes
        .iter()
        .any(|v| v.locations.iter().any(|p| p.path == "/Volumes/Team Files")));
}
#[test]
fn linux_device_aliases_do_not_offer_to_mount_the_system_disk() {
    let mut snapshot = linux_mounts("42 0 179:2 / / rw - ext4 /dev/root rw").unwrap();
    linux_blocks(
        &mut snapshot,
        &json!({"blockdevices":[{"name":"/dev/mmcblk0p2","maj:min":"179:2","fstype":"ext4","uuid":"system"}]}),
        true,
    );
    assert_eq!(snapshot.volumes.len(), 1);
    let volume = &snapshot.volumes[0];
    assert_eq!(volume.locations[0].path, "/");
    assert!(volume.system);
    assert!(!volume.can_mount && !volume.can_unmount);
}
#[test]
fn windows_retains_drive_and_folder_access_paths_without_inventing_mount_actions() {
    let snapshot = windows_volumes(
        &json!({"volumes":[{"id":"volume-guid","name":"Work","fs":"NTFS","paths":["D:/","C:/Mounted/Work/"]},{"id":"offline-guid","paths":[]}],"notices":[]}),
    );
    assert_eq!(snapshot.volumes[0].locations[1].path, "C:/Mounted/Work/");
    assert!(snapshot
        .volumes
        .iter()
        .all(|v| !v.can_mount && !v.can_unmount));
    assert!(snapshot.volumes[1].locations.is_empty());
}
#[test]
fn reviewed_actions_reject_stale_missing_system_and_injected_devices() {
    let mut snapshot = inventory();
    snapshot.revision = "fresh".into();
    snapshot.volumes.push(FileVolume {
        id: "block:/dev/sdb1|uuid".into(),
        name: "Work".into(),
        detail: "".into(),
        locations: vec![],
        system: false,
        can_mount: true,
        can_unmount: false,
    });
    assert!(reviewed_volume(&snapshot, "block:/dev/sdb1|uuid", "stale", true).is_err());
    assert!(reviewed_volume(&snapshot, "missing", "fresh", true).is_err());
    assert!(reviewed_volume(&snapshot, "block:/dev/sdb1|uuid", "fresh", false).is_err());
    let volume = reviewed_volume(&snapshot, "block:/dev/sdb1|uuid", "fresh", true).unwrap();
    assert_eq!(
        mount_command(Platform::Linux, volume, true).unwrap(),
        "udisksctl mount --block-device '/dev/sdb1' --no-user-interaction"
    );
    snapshot.volumes[0].system = true;
    assert!(reviewed_volume(&snapshot, "block:/dev/sdb1|uuid", "fresh", true).is_err());
    snapshot.volumes[0].id = "block:/dev/sdb1'; touch bad|uuid".into();
    assert!(mount_command(Platform::Linux, &snapshot.volumes[0], true).is_err());
    snapshot.volumes[0].id = "disk:disk2s1;reboot|uuid".into();
    assert!(mount_command(Platform::Mac, &snapshot.volumes[0], true).is_err());
}
