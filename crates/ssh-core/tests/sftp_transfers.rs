// SPDX-License-Identifier: MPL-2.0
use russh_sftp::{client::RawSftpSession, protocol::*, server::Handler};
use shellcanvas_core::{entry_revision, FileTransferService, SftpTextFiles};
use std::sync::{Arc, Mutex};

struct State {
    path: FileAttributes,
    handle: FileAttributes,
    handles: usize,
}
struct Server(Arc<Mutex<State>>);
impl Handler for Server {
    type Error = StatusCode;
    fn unimplemented(&self) -> StatusCode {
        StatusCode::OpUnsupported
    }
    async fn lstat(&mut self, id: u32, _: String) -> Result<Attrs, StatusCode> {
        Ok(Attrs {
            id,
            attrs: self.0.lock().unwrap().path.clone(),
        })
    }
    async fn fstat(&mut self, id: u32, _: String) -> Result<Attrs, StatusCode> {
        Ok(Attrs {
            id,
            attrs: self.0.lock().unwrap().handle.clone(),
        })
    }
    async fn open(
        &mut self,
        id: u32,
        _: String,
        flags: OpenFlags,
        _: FileAttributes,
    ) -> Result<Handle, StatusCode> {
        assert_eq!(flags.bits(), OpenFlags::READ.bits());
        self.0.lock().unwrap().handles += 1;
        Ok(Handle {
            id,
            handle: "file".into(),
        })
    }
    async fn close(&mut self, id: u32, _: String) -> Result<Status, StatusCode> {
        self.0.lock().unwrap().handles -= 1;
        Ok(Status {
            id,
            status_code: StatusCode::Ok,
            error_message: String::new(),
            language_tag: String::new(),
        })
    }
    async fn read(
        &mut self,
        id: u32,
        _: String,
        offset: u64,
        len: u32,
    ) -> Result<Data, StatusCode> {
        let bytes = b"contents";
        if offset >= bytes.len() as u64 {
            return Err(StatusCode::Eof);
        }
        Ok(Data {
            id,
            data: bytes[offset as usize..bytes.len().min(offset as usize + len as usize)].to_vec(),
        })
    }
}
async fn fixture(provider: &str) -> (Arc<SftpTextFiles>, Arc<Mutex<State>>, String) {
    let path = FileAttributes {
        size: Some(8),
        uid: Some(0),
        gid: Some(0),
        permissions: Some(0o100600),
        mtime: Some(12),
        ..FileAttributes::empty()
    };
    let mut handle = path.clone();
    handle.permissions = Some(0o100666);
    let revision = entry_revision(&path);
    let state = Arc::new(Mutex::new(State {
        path,
        handle,
        handles: 0,
    }));
    let (client, server) = tokio::io::duplex(256 * 1024);
    tokio::spawn(russh_sftp::server::run(server, Server(state.clone())));
    let service = SftpTextFiles::new(RawSftpSession::new(client))
        .await
        .unwrap()
        .with_identified_provider(provider);
    (Arc::new(service), state, revision)
}

#[tokio::test]
async fn windows_download_accepts_synthetic_handle_mode_and_closes_after_exact_bytes() {
    let (service, state, revision) = fixture("windows").await;
    let mut reader = service.download("/file", &revision).await.unwrap();
    assert_eq!(reader.read().await.unwrap(), b"contents");
    assert!(reader.read().await.unwrap().is_empty());
    reader.finish().await.unwrap();
    assert_eq!(state.lock().unwrap().handles, 0);
}

#[tokio::test]
async fn unix_still_requires_matching_modes_at_open() {
    let (service, state, revision) = fixture("linux").await;
    assert!(service.download("/file", &revision).await.is_err());
    assert_eq!(state.lock().unwrap().handles, 0);
}

#[tokio::test]
async fn windows_open_still_rejects_changed_size_time_owner_and_file_type() {
    for field in ["size", "time", "owner", "type", "stale"] {
        let (service, state, revision) = fixture("windows").await;
        {
            let mut state = state.lock().unwrap();
            match field {
                "size" => state.handle.size = Some(9),
                "time" => state.handle.mtime = Some(13),
                "owner" => state.handle.uid = Some(1),
                "type" => state.handle.permissions = Some(0o120666),
                _ => state.path.mtime = Some(13),
            }
        }
        assert!(
            service.download("/file", &revision).await.is_err(),
            "{field}"
        );
        assert_eq!(state.lock().unwrap().handles, 0);
    }
}

#[tokio::test]
async fn finish_checks_path_and_handle_revisions_independently_including_permissions() {
    for field in ["path_mode", "handle_mode", "path_time", "handle_time"] {
        let (service, state, revision) = fixture("windows").await;
        let mut reader = service.download("/file", &revision).await.unwrap();
        assert_eq!(reader.read().await.unwrap(), b"contents");
        {
            let mut state = state.lock().unwrap();
            match field {
                "path_mode" => state.path.permissions = Some(0o100400),
                "handle_mode" => state.handle.permissions = Some(0o100444),
                "path_time" => state.path.mtime = Some(13),
                _ => state.handle.mtime = Some(13),
            }
        }
        assert!(reader.finish().await.is_err(), "{field}");
        reader.abort().await.unwrap();
        assert_eq!(state.lock().unwrap().handles, 0);
    }
}
