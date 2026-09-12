// SPDX-License-Identifier: MPL-2.0
use russh_sftp::{client::RawSftpSession, protocol::*, server::Handler};
use shellcanvas_core::{SftpTextFiles, TextFileService};
use std::sync::{Arc, Mutex};

struct State {
    bytes: Vec<u8>,
    writes: usize,
    fail_after: Option<usize>,
    handles: usize,
}
struct Server(Arc<Mutex<State>>);
fn ok(id: u32) -> Status {
    Status {
        id,
        status_code: StatusCode::Ok,
        error_message: String::new(),
        language_tag: String::new(),
    }
}
impl Handler for Server {
    type Error = StatusCode;
    fn unimplemented(&self) -> StatusCode {
        StatusCode::OpUnsupported
    }
    async fn realpath(&mut self, id: u32, path: String) -> Result<Name, StatusCode> {
        Ok(Name {
            id,
            files: vec![File::dummy(&path)],
        })
    }
    async fn stat(&mut self, id: u32, _: String) -> Result<Attrs, StatusCode> {
        Ok(Attrs {
            id,
            attrs: FileAttributes {
                size: Some(self.0.lock().unwrap().bytes.len() as u64),
                permissions: Some(0o100640),
                ..FileAttributes::empty()
            },
        })
    }
    async fn fstat(&mut self, id: u32, _: String) -> Result<Attrs, StatusCode> {
        self.stat(id, String::new()).await
    }
    async fn open(
        &mut self,
        id: u32,
        _: String,
        flags: OpenFlags,
        _: FileAttributes,
    ) -> Result<Handle, StatusCode> {
        assert!(!flags.intersects(OpenFlags::TRUNCATE | OpenFlags::CREATE));
        self.0.lock().unwrap().handles += 1;
        Ok(Handle {
            id,
            handle: "fixture".into(),
        })
    }
    async fn close(&mut self, id: u32, _: String) -> Result<Status, StatusCode> {
        self.0.lock().unwrap().handles -= 1;
        Ok(ok(id))
    }
    async fn read(
        &mut self,
        id: u32,
        _: String,
        offset: u64,
        len: u32,
    ) -> Result<Data, StatusCode> {
        let state = self.0.lock().unwrap();
        let offset = offset as usize;
        if offset >= state.bytes.len() {
            return Err(StatusCode::Eof);
        }
        Ok(Data {
            id,
            data: state.bytes[offset..state.bytes.len().min(offset + len as usize)].to_vec(),
        })
    }
    async fn write(
        &mut self,
        id: u32,
        _: String,
        offset: u64,
        data: Vec<u8>,
    ) -> Result<Status, StatusCode> {
        let mut state = self.0.lock().unwrap();
        if state.fail_after == Some(state.writes) {
            return Err(StatusCode::Failure);
        }
        state.writes += 1;
        let end = offset as usize + data.len();
        if end > state.bytes.len() {
            state.bytes.resize(end, 0);
        }
        state.bytes[offset as usize..end].copy_from_slice(&data);
        Ok(ok(id))
    }
    async fn fsetstat(
        &mut self,
        id: u32,
        _: String,
        attrs: FileAttributes,
    ) -> Result<Status, StatusCode> {
        assert!(attrs.permissions.is_none() && attrs.uid.is_none() && attrs.gid.is_none());
        self.0
            .lock()
            .unwrap()
            .bytes
            .resize(attrs.size.unwrap() as usize, 0);
        Ok(ok(id))
    }
}
async fn fixture() -> (SftpTextFiles, Arc<Mutex<State>>) {
    let state = Arc::new(Mutex::new(State {
        bytes: b"original contents".to_vec(),
        writes: 0,
        fail_after: None,
        handles: 0,
    }));
    let (client, server) = tokio::io::duplex(256 * 1024);
    tokio::spawn(russh_sftp::server::run(server, Server(state.clone())));
    (
        SftpTextFiles::new(RawSftpSession::new(client))
            .await
            .unwrap(),
        state,
    )
}
#[tokio::test]
async fn confirmation_and_current_revision_are_required_before_writing() {
    let (service, state) = fixture().await;
    let opened = service.read_text("/note").await.unwrap();
    assert!(opened.writable && opened.save_requires_confirmation);
    assert!(service
        .save_text("/note", "draft", &opened.revision)
        .await
        .is_err());
    assert!(service
        .save_text_confirmed("/note", "draft", &opened.revision, false)
        .await
        .is_err());
    state.lock().unwrap().bytes = b"external changes".to_vec();
    assert!(service
        .save_text_confirmed("/note", "draft", &opened.revision, true)
        .await
        .unwrap_err()
        .to_string()
        .contains("CONFLICT"));
    let state = state.lock().unwrap();
    assert_eq!(state.writes, 0);
    assert_eq!(state.bytes, b"external changes");
    assert_eq!(state.handles, 0);
}
#[tokio::test]
async fn confirmed_saves_handle_growth_shrink_unicode_and_empty_contents() {
    let (service, state) = fixture().await;
    for text in ["a".repeat(70_000), "short ✓".into(), String::new()] {
        let opened = service.read_text("/note").await.unwrap();
        let saved = service
            .save_text_confirmed("/note", &text, &opened.revision, true)
            .await
            .unwrap();
        assert_eq!(saved.text, text);
        assert_eq!(state.lock().unwrap().bytes, text.as_bytes());
        assert_eq!(state.lock().unwrap().handles, 0);
    }
}
#[tokio::test]
async fn interrupted_save_reports_partial_contents_and_closes_handles() {
    let (service, state) = fixture().await;
    let opened = service.read_text("/note").await.unwrap();
    state.lock().unwrap().fail_after = Some(1);
    let draft = "x".repeat(70_000);
    let error = service
        .save_text_confirmed("/note", &draft, &opened.revision, true)
        .await
        .unwrap_err();
    assert!(error.to_string().contains("partial changes"));
    assert_eq!(state.lock().unwrap().bytes, draft.as_bytes()[..32768]);
    assert_eq!(state.lock().unwrap().handles, 0);
}
