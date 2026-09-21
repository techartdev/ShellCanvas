// SPDX-License-Identifier: MPL-2.0
//! Read-only RouterOS `/file` metadata browsing. The command is fixed: paths are
//! interpreted locally and are never inserted into RouterOS source text.
use crate::Connection;
use anyhow::{bail, Context, Result};
use async_trait::async_trait;
use shellcanvas_services::{Directory, FileEntry, FileLocation, FilePlace, FileSystemProvider};
use std::{
    collections::{BTreeMap, HashSet},
    sync::Arc,
};

const HEADER: &str = "ShellCanvas-Files-1";
const MAX_ENTRIES: usize = 4096;
const MAX_FIELD: usize = 16 * 1024;

/// RouterOS 6 compatible: only `find`, `get`, `:len`, `:foreach`, and `:put`.
/// Each variable field follows an ASCII byte-length header, so embedded line
/// breaks and quotes cannot alter record boundaries.
pub const ROUTEROS_FILES_PROBE: &str = r#":put "ShellCanvas-Files-1"; :local c 0; :foreach f in=[/file find] do={:local n [/file get $f name]; :local t [/file get $f type]; :local s [/file get $f size]; :put ("SCF1|" . [:len $n] . "|" . [:len $t] . "|" . $s); :put $n; :put $t; :set c ($c + 1)}; :put ("SCEND|" . $c)"#;

#[derive(Clone, Debug)]
struct Item {
    name: String,
    kind: String,
    size: u64,
}

fn take_line<'a>(bytes: &mut &'a [u8]) -> Result<&'a [u8]> {
    let end = bytes
        .iter()
        .position(|byte| *byte == b'\n')
        .context("Truncated RouterOS file response")?;
    let mut line = &bytes[..end];
    if line.last() == Some(&b'\r') {
        line = &line[..line.len() - 1];
    }
    *bytes = &bytes[end + 1..];
    Ok(line)
}

fn take_field<'a>(bytes: &mut &'a [u8], len: usize) -> Result<&'a [u8]> {
    if len > MAX_FIELD || bytes.len() < len {
        bail!("Invalid RouterOS file field length");
    }
    let field = &bytes[..len];
    *bytes = &bytes[len..];
    if bytes.starts_with(b"\r\n") {
        *bytes = &bytes[2..];
    } else if bytes.starts_with(b"\n") {
        *bytes = &bytes[1..];
    } else {
        bail!("Malformed RouterOS file field terminator");
    }
    Ok(field)
}

fn parse_snapshot(bytes: &[u8]) -> Result<Vec<Item>> {
    let mut bytes = bytes;
    if take_line(&mut bytes)? != HEADER.as_bytes() {
        bail!("Invalid RouterOS file response header");
    }
    let mut items = Vec::new();
    let mut names = HashSet::new();
    loop {
        let header = std::str::from_utf8(take_line(&mut bytes)?)
            .context("RouterOS file header is not UTF-8")?;
        if let Some(count) = header.strip_prefix("SCEND|") {
            let count: usize = count
                .parse()
                .context("Invalid RouterOS file record count")?;
            if count != items.len() || !bytes.is_empty() {
                bail!("Invalid RouterOS file response end marker");
            }
            break;
        }
        let fields: Vec<_> = header.split('|').collect();
        if fields.len() != 4 || fields[0] != "SCF1" {
            bail!("Malformed RouterOS file record");
        }
        let name_len: usize = fields[1]
            .parse()
            .context("Invalid RouterOS file name length")?;
        let type_len: usize = fields[2]
            .parse()
            .context("Invalid RouterOS file type length")?;
        let size = if fields[3].is_empty() {
            0
        } else {
            fields[3].parse().context("Invalid RouterOS file size")?
        };
        let name = std::str::from_utf8(take_field(&mut bytes, name_len)?)
            .context("RouterOS file name is not UTF-8")?
            .to_owned();
        let kind = std::str::from_utf8(take_field(&mut bytes, type_len)?)
            .context("RouterOS file type is not UTF-8")?
            .to_owned();
        if name.is_empty()
            || name.starts_with('/')
            || name.ends_with('/')
            || name.contains('\0')
            || name
                .split('/')
                .any(|part| part.is_empty() || matches!(part, "." | ".."))
        {
            bail!("Invalid RouterOS file name");
        }
        if !names.insert(name.clone()) {
            bail!("Duplicate RouterOS file name");
        }
        if items.len() == MAX_ENTRIES {
            bail!("RouterOS file response has too many entries");
        }
        items.push(Item { name, kind, size });
    }
    Ok(items)
}

fn validate_path(path: &str) -> Result<&str> {
    if path == "/" {
        return Ok("");
    }
    let relative = path
        .strip_prefix('/')
        .context("RouterOS file paths must be absolute")?;
    if relative.ends_with('/')
        || relative.contains('\0')
        || relative
            .split('/')
            .any(|part| part.is_empty() || matches!(part, "." | ".."))
    {
        bail!("Invalid RouterOS file path");
    }
    Ok(relative)
}

fn location(path: &str) -> Result<FileLocation> {
    let relative = validate_path(path)?;
    if relative.is_empty() {
        return Ok(FileLocation {
            path: "/".into(),
            name: "Files".into(),
            parent: None,
        });
    }
    let (parent, name) = relative.rsplit_once('/').unwrap_or(("", relative));
    Ok(FileLocation {
        path: path.into(),
        name: name.into(),
        parent: Some(if parent.is_empty() {
            "/".into()
        } else {
            format!("/{parent}")
        }),
    })
}

fn locate(items: &[Item], path: &str) -> Result<FileLocation> {
    let relative = validate_path(path)?;
    if relative.is_empty()
        || items.iter().any(|item| item.name == relative)
        || items.iter().any(|item| {
            item.name
                .strip_prefix(relative)
                .is_some_and(|tail| tail.starts_with('/'))
        })
    {
        location(path)
    } else {
        bail!("RouterOS file does not exist")
    }
}

fn is_directory(kind: &str) -> bool {
    matches!(kind, "directory" | "disk")
}

fn directory(items: &[Item], path: &str) -> Result<Directory> {
    let relative = validate_path(path)?;
    if !relative.is_empty() {
        let explicit = items.iter().find(|item| item.name == relative);
        let has_children = items.iter().any(|item| {
            item.name
                .strip_prefix(relative)
                .is_some_and(|tail| tail.starts_with('/'))
        });
        if !has_children && !explicit.is_some_and(|item| is_directory(&item.kind)) {
            bail!("RouterOS directory does not exist");
        }
    }
    let prefix = if relative.is_empty() {
        String::new()
    } else {
        format!("{relative}/")
    };
    let mut children: BTreeMap<&str, (&Item, bool)> = BTreeMap::new();
    for item in items {
        let Some(tail) = item.name.strip_prefix(&prefix) else {
            continue;
        };
        if tail.is_empty() {
            continue;
        }
        let (child, nested) = tail
            .split_once('/')
            .map_or((tail, false), |(head, _)| (head, true));
        children
            .entry(child)
            .and_modify(|value| value.1 |= nested)
            .or_insert((item, nested));
    }
    let entries = children
        .into_iter()
        .map(|(name, (item, nested))| {
            let child_path = if relative.is_empty() {
                format!("/{name}")
            } else {
                format!("/{relative}/{name}")
            };
            let child_relative = child_path.trim_start_matches('/');
            let exact = item.name == child_relative;
            let directory = nested || (exact && is_directory(&item.kind));
            FileEntry {
                name: name.into(),
                path: child_path,
                kind: if directory { "directory" } else { "file" }.into(),
                size: if exact && !directory { item.size } else { 0 },
                modified: None,
                revision: format!("routeros:{}:{}:{}", item.kind, item.size, item.name),
            }
        })
        .collect();
    let current = location(path)?;
    let roots = items
        .iter()
        .filter(|item| item.kind == "disk" && !item.name.contains('/'))
        .map(|item| FilePlace {
            path: format!("/{}", item.name),
            name: item.name.clone(),
        })
        .collect();
    Ok(Directory {
        path: current.path,
        name: current.name,
        parent: current.parent,
        home: Some(FilePlace {
            path: "/".into(),
            name: "Files".into(),
        }),
        roots,
        entries,
    })
}

pub struct RouterOsFiles {
    connection: Arc<Connection>,
}
impl RouterOsFiles {
    pub async fn probe(connection: Arc<Connection>) -> Result<Self> {
        parse_snapshot(&connection.exec_bounded_bytes(ROUTEROS_FILES_PROBE).await?)?;
        Ok(Self { connection })
    }
    async fn snapshot(&self) -> Result<Vec<Item>> {
        parse_snapshot(
            &self
                .connection
                .exec_bounded_bytes(ROUTEROS_FILES_PROBE)
                .await?,
        )
    }
}

#[async_trait]
impl FileSystemProvider for RouterOsFiles {
    async fn list(&self, path: Option<&str>) -> Result<Directory> {
        directory(&self.snapshot().await?, path.unwrap_or("/"))
    }
    async fn locate(&self, path: &str) -> Result<FileLocation> {
        let items = self.snapshot().await?;
        locate(&items, path)
    }
    async fn preview(&self, _path: &str) -> Result<String> {
        bail!("File-content preview is unavailable through RouterOS metadata browsing")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn record(name: &[u8], kind: &[u8], size: &str) -> Vec<u8> {
        let mut value = format!("SCF1|{}|{}|{}\r\n", name.len(), kind.len(), size).into_bytes();
        value.extend(name);
        value.extend(b"\r\n");
        value.extend(kind);
        value.extend(b"\r\n");
        value
    }
    fn snapshot(records: Vec<Vec<u8>>) -> Vec<u8> {
        let count = records.len();
        let mut value = b"ShellCanvas-Files-1\r\n".to_vec();
        for record in records {
            value.extend(record);
        }
        value.extend(format!("SCEND|{count}\r\n").as_bytes());
        value
    }
    #[test]
    fn parses_framed_names_with_quotes_and_controls() {
        let bytes = snapshot(vec![record(b"flash/a\n'b\t", b"file", "12")]);
        let items = parse_snapshot(&bytes).unwrap();
        assert_eq!(items[0].name, "flash/a\n'b\t");
        assert_eq!(items[0].size, 12);
    }
    #[test]
    fn rejects_truncated_malformed_duplicate_and_non_utf8_records() {
        let valid = record(b"flash/a", b"file", "1");
        for bytes in [
            b"wrong\n".to_vec(),
            snapshot(vec![b"SCF1|9|4|1\na".to_vec()]),
            snapshot(vec![b"bad\n".to_vec()]),
            snapshot(vec![valid.clone(), valid.clone()]),
            snapshot(vec![record(&[0xff], b"file", "1")]),
            b"ShellCanvas-Files-1\n".to_vec(),
            [b"ShellCanvas-Files-1\n".as_slice(), valid.as_slice()].concat(),
        ] {
            assert!(parse_snapshot(&bytes).is_err());
        }
        assert!(parse_snapshot(&snapshot(vec![])).unwrap().is_empty());
    }

    #[test]
    fn requires_an_exact_counted_end_marker_without_trailing_output() {
        let valid = record(b"flash/a", b"file", "1");
        let mut wrong_count = b"ShellCanvas-Files-1\n".to_vec();
        wrong_count.extend(&valid);
        wrong_count.extend(b"SCEND|2\n");
        let mut trailing = snapshot(vec![valid]);
        trailing.extend(b"unexpected\n");
        let mut oversized =
            format!("ShellCanvas-Files-1\nSCF1|{}|4|1\n", MAX_FIELD + 1).into_bytes();
        oversized.extend(std::iter::repeat_n(b'a', MAX_FIELD + 1));
        oversized.extend(b"\nfile\nSCEND|1\n");

        for bytes in [wrong_count, trailing, oversized] {
            assert!(parse_snapshot(&bytes).is_err());
        }
    }

    #[test]
    fn rejects_names_that_escape_or_alias_the_router_namespace() {
        for name in [
            b"/absolute".as_slice(),
            b"flash/".as_slice(),
            b"flash//file".as_slice(),
            b"flash/../file".as_slice(),
            b"flash/./file".as_slice(),
            b"flash/a\0b".as_slice(),
        ] {
            assert!(parse_snapshot(&snapshot(vec![record(name, b"file", "1")])).is_err());
        }
    }
    #[test]
    fn builds_safe_nested_directories_and_disk_roots() {
        let items = parse_snapshot(&snapshot(vec![
            record(b"flash", b"disk", "0"),
            record(b"flash/empty", b"directory", "0"),
            record(b"flash/dir/file.txt", b"file", "9"),
            record(b"root.txt", b"file", "3"),
            record(b"flash2/not-in-flash", b"file", "4"),
        ]))
        .unwrap();
        let root = directory(&items, "/").unwrap();
        assert_eq!(root.roots[0].path, "/flash");
        assert_eq!(
            root.entries
                .iter()
                .find(|e| e.name == "flash")
                .unwrap()
                .kind,
            "directory"
        );
        let flash = directory(&items, "/flash").unwrap();
        assert!(flash
            .entries
            .iter()
            .any(|e| e.name == "empty" && e.kind == "directory"));
        assert!(flash
            .entries
            .iter()
            .any(|e| e.name == "dir" && e.kind == "directory"));
        assert!(!flash
            .entries
            .iter()
            .any(|e| e.name == "flash2" || e.name == "not-in-flash"));
        assert!(directory(&items, "/flash/empty")
            .unwrap()
            .entries
            .is_empty());
        for path in ["flash", "//flash", "/flash/../root.txt", "/flash/"] {
            assert!(directory(&items, path).is_err());
        }
    }

    #[test]
    fn locates_exact_files_and_implicit_directories_without_prefix_confusion() {
        let items = parse_snapshot(&snapshot(vec![
            record(b"flash/dir/file.txt", b"file", "9"),
            record(b"flash2/other.txt", b"file", "4"),
        ]))
        .unwrap();
        assert_eq!(locate(&items, "/").unwrap().parent, None);
        assert_eq!(locate(&items, "/flash/dir").unwrap().name, "dir");
        let file = locate(&items, "/flash/dir/file.txt").unwrap();
        assert_eq!(file.path, "/flash/dir/file.txt");
        assert_eq!(file.name, "file.txt");
        assert_eq!(file.parent.as_deref(), Some("/flash/dir"));
        assert!(locate(&items, "/flash2-other").is_err());
        assert!(locate(&items, "/missing").is_err());
    }

    #[tokio::test]
    async fn snapshot_directory_pages_large_router_listing() {
        use shellcanvas_services::{DirectoryReader, SnapshotDirectory, DIRECTORY_PAGE};
        let records = (0..(DIRECTORY_PAGE + 5))
            .map(|i| record(format!("file-{i:03}").as_bytes(), b"file", "1"))
            .collect();
        let items = parse_snapshot(&snapshot(records)).unwrap();
        let mut reader = SnapshotDirectory::new(directory(&items, "/").unwrap());
        let first = reader.next().await.unwrap();
        assert_eq!(first.directory.entries.len(), DIRECTORY_PAGE);
        assert!(!first.done);
        let second = reader.next().await.unwrap();
        assert_eq!(second.directory.entries.len(), 5);
        assert!(second.done);
    }
}
