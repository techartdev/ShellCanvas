// SPDX-License-Identifier: MPL-2.0
use std::io;
use tokio::process::{Child, Command};

pub(crate) struct ProcessTree {
    #[cfg(windows)]
    job: windows::Job,
}
impl ProcessTree {
    pub async fn spawn(command: &mut Command) -> io::Result<(Child, Self)> {
        #[cfg(windows)]
        {
            use windows_sys::Win32::System::Threading::{CREATE_NO_WINDOW, CREATE_SUSPENDED};
            let job = windows::Job::new()?;
            // No adapter code can spawn a helper before assignment to the job.
            command.creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED);
            let mut child = command.spawn()?;
            if let Err(error) = job.attach_and_resume(&child) {
                let _ = job.terminate();
                let _ = tokio::time::timeout(std::time::Duration::from_secs(2), child.kill()).await;
                return Err(error);
            }
            Ok((child, Self { job }))
        }
        #[cfg(not(windows))]
        {
            // Other platforms retain their existing direct-child behavior until
            // their process-group lifecycle has equivalent implementation/evidence.
            Ok((command.spawn()?, Self {}))
        }
    }

    /// Call under a deadline. Success requires both root reaping and no live job members.
    pub async fn cleanup(&self, child: &mut Child) -> io::Result<()> {
        #[cfg(windows)]
        let members = {
            let members = self.job.members();
            // Still stop the job if enumeration fails; report unconfirmed cleanup.
            self.job.terminate()?;
            members?
        };
        if let Err(error) = child.kill().await {
            if child.try_wait()?.is_none() {
                return Err(error);
            }
        }
        #[cfg(windows)]
        while self.job.active()? != 0 || !windows::members_exited(&members)? {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        Ok(())
    }
}

#[cfg(windows)]
mod windows {
    use std::{
        io,
        mem::size_of,
        os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
        ptr,
    };
    use tokio::process::Child;
    use windows_sys::Win32::{
        Foundation::{
            ERROR_INVALID_PARAMETER, ERROR_MORE_DATA, ERROR_NO_MORE_FILES, INVALID_HANDLE_VALUE,
            WAIT_OBJECT_0, WAIT_TIMEOUT,
        },
        System::{
            Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD,
                THREADENTRY32,
            },
            JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, IsProcessInJob,
                JobObjectBasicAccountingInformation, JobObjectBasicProcessIdList,
                JobObjectExtendedLimitInformation, QueryInformationJobObject,
                SetInformationJobObject, TerminateJobObject,
                JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JOBOBJECT_BASIC_PROCESS_ID_LIST,
                JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            },
            Threading::{
                GetProcessIdOfThread, OpenProcess, OpenThread, ResumeThread, WaitForSingleObject,
                PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
                THREAD_QUERY_LIMITED_INFORMATION, THREAD_SUSPEND_RESUME,
            },
        },
    };

    pub(super) struct Job(OwnedHandle);
    impl Job {
        pub fn new() -> io::Result<Self> {
            // Unnamed and non-inheritable: only this owner can keep the job alive.
            let handle = unsafe { CreateJobObjectW(ptr::null(), ptr::null()) };
            if handle.is_null() {
                return Err(io::Error::last_os_error());
            }
            // SAFETY: CreateJobObjectW returned a fresh, owned handle.
            let job = Self(unsafe { OwnedHandle::from_raw_handle(handle) });
            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            // No breakaway flags: ordinary descendants stay associated with this job.
            if unsafe {
                SetInformationJobObject(
                    job.0.as_raw_handle(),
                    JobObjectExtendedLimitInformation,
                    (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
            } == 0
            {
                return Err(io::Error::last_os_error());
            }
            Ok(job)
        }
        pub fn attach_and_resume(&self, child: &Child) -> io::Result<()> {
            let process = child
                .raw_handle()
                .ok_or_else(|| io::Error::other("Adapter exited before job assignment"))?;
            let pid = child
                .id()
                .ok_or_else(|| io::Error::other("Adapter process identity unavailable"))?;
            // SAFETY: Both handles remain owned for this call; the child is suspended.
            if unsafe { AssignProcessToJobObject(self.0.as_raw_handle(), process) } == 0 {
                return Err(io::Error::last_os_error());
            }
            let thread = primary_thread(pid)?;
            // SAFETY: The owned thread was checked against the still-owned child PID.
            // Refuse unexpected suspension state rather than resuming arbitrary threads.
            match unsafe { ResumeThread(thread.as_raw_handle()) } {
                1 => Ok(()),
                u32::MAX => Err(io::Error::last_os_error()),
                _ => Err(io::Error::other("Unexpected adapter startup thread state")),
            }
        }
        pub fn terminate(&self) -> io::Result<()> {
            // SAFETY: The job handle is owned, private and valid.
            if unsafe { TerminateJobObject(self.0.as_raw_handle(), 1) } == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        }
        pub fn members(&self) -> io::Result<Vec<OwnedHandle>> {
            let mut capacity = 16usize;
            // A changing process tree may require a larger snapshot, never an entry cap.
            // Bound retries so an adapter that continuously forks cannot stall cleanup.
            for _ in 0..8 {
                let bytes = 8usize
                    .checked_add(
                        capacity
                            .checked_mul(size_of::<usize>())
                            .ok_or_else(|| io::Error::other("Adapter process list overflow"))?,
                    )
                    .ok_or_else(|| io::Error::other("Adapter process list overflow"))?;
                let length = u32::try_from(bytes).map_err(|_| {
                    io::Error::other("Adapter process list exceeds the Windows buffer range")
                })?;
                let words = bytes.div_ceil(size_of::<usize>());
                let mut buffer = Vec::<usize>::new();
                buffer
                    .try_reserve_exact(words)
                    .map_err(|_| io::Error::other("Unable to allocate adapter process list"))?;
                buffer.resize(words, 0);
                // usize alignment is sufficient for the native variable-length structure.
                let info = buffer
                    .as_mut_ptr()
                    .cast::<JOBOBJECT_BASIC_PROCESS_ID_LIST>();
                let result = unsafe {
                    QueryInformationJobObject(
                        self.0.as_raw_handle(),
                        JobObjectBasicProcessIdList,
                        info.cast(),
                        length,
                        ptr::null_mut(),
                    )
                };
                let failure = if result == 0 {
                    Some(io::Error::last_os_error())
                } else {
                    None
                };
                let assigned = unsafe { (*info).NumberOfAssignedProcesses as usize };
                let count = unsafe { (*info).NumberOfProcessIdsInList as usize };
                if failure
                    .as_ref()
                    .is_some_and(|error| error.raw_os_error() != Some(ERROR_MORE_DATA as i32))
                {
                    return Err(failure.unwrap());
                }
                if failure.is_some() || assigned > count {
                    capacity = assigned.max(capacity.saturating_mul(2));
                    continue;
                }
                if count > capacity {
                    return Err(io::Error::other("Invalid adapter process list"));
                }
                let mut members = Vec::new();
                members
                    .try_reserve_exact(count)
                    .map_err(|_| io::Error::other("Unable to retain adapter process handles"))?;
                let ids = unsafe {
                    std::slice::from_raw_parts(
                        buffer.as_ptr().cast::<u8>().add(8).cast::<usize>(),
                        count,
                    )
                };
                for pid in ids {
                    let pid = u32::try_from(*pid)
                        .map_err(|_| io::Error::other("Invalid adapter process identity"))?;
                    let handle = unsafe {
                        OpenProcess(
                            PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION,
                            0,
                            pid,
                        )
                    };
                    if handle.is_null() {
                        let error = io::Error::last_os_error();
                        if error.raw_os_error() == Some(ERROR_INVALID_PARAMETER as i32) {
                            continue;
                        }
                        return Err(error);
                    }
                    let process = unsafe { OwnedHandle::from_raw_handle(handle) };
                    let mut associated = 0;
                    if unsafe {
                        IsProcessInJob(
                            process.as_raw_handle(),
                            self.0.as_raw_handle(),
                            &mut associated,
                        )
                    } == 0
                    {
                        return Err(io::Error::last_os_error());
                    }
                    // A PID may exit and be reused between enumeration and OpenProcess.
                    if associated != 0 {
                        members.push(process);
                    }
                }
                return Ok(members);
            }
            Err(io::Error::other(
                "Adapter process tree changed during cleanup",
            ))
        }
        pub fn active(&self) -> io::Result<u32> {
            let mut info = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
            // SAFETY: The output pointer/size match the requested information class.
            if unsafe {
                QueryInformationJobObject(
                    self.0.as_raw_handle(),
                    JobObjectBasicAccountingInformation,
                    (&mut info as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
                    size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                    ptr::null_mut(),
                )
            } == 0
            {
                return Err(io::Error::last_os_error());
            }
            Ok(info.ActiveProcesses)
        }
    }

    pub(super) fn members_exited(members: &[OwnedHandle]) -> io::Result<bool> {
        for member in members {
            match unsafe { WaitForSingleObject(member.as_raw_handle(), 0) } {
                WAIT_OBJECT_0 => {}
                WAIT_TIMEOUT => return Ok(false),
                _ => return Err(io::Error::last_os_error()),
            }
        }
        Ok(true)
    }

    fn primary_thread(pid: u32) -> io::Result<OwnedHandle> {
        // Stable Rust does not expose the primary thread handle from Command.
        // Enumerate the fresh suspended process and require one unambiguous thread.
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
        if snapshot == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: Snapshot ownership is transferred exactly once.
        let snapshot = unsafe { OwnedHandle::from_raw_handle(snapshot) };
        let mut entry = THREADENTRY32 {
            dwSize: size_of::<THREADENTRY32>() as u32,
            ..Default::default()
        };
        let mut found = None;
        let mut present = unsafe { Thread32First(snapshot.as_raw_handle(), &mut entry) };
        loop {
            if present == 0 {
                let error = io::Error::last_os_error();
                if error.raw_os_error() != Some(ERROR_NO_MORE_FILES as i32) {
                    return Err(error);
                }
                break;
            }
            if entry.th32OwnerProcessID == pid {
                if found.is_some() {
                    return Err(io::Error::other("Adapter startup thread is ambiguous"));
                }
                let handle = unsafe {
                    OpenThread(
                        THREAD_SUSPEND_RESUME | THREAD_QUERY_LIMITED_INFORMATION,
                        0,
                        entry.th32ThreadID,
                    )
                };
                if handle.is_null() {
                    return Err(io::Error::last_os_error());
                }
                // SAFETY: OpenThread returned a fresh owned handle, pinned against ID reuse.
                let thread = unsafe { OwnedHandle::from_raw_handle(handle) };
                if unsafe { GetProcessIdOfThread(thread.as_raw_handle()) } != pid {
                    return Err(io::Error::other("Adapter startup thread identity changed"));
                }
                found = Some(thread);
            }
            entry.dwSize = size_of::<THREADENTRY32>() as u32;
            present = unsafe { Thread32Next(snapshot.as_raw_handle(), &mut entry) };
        }
        found.ok_or_else(|| io::Error::other("Adapter startup thread unavailable"))
    }
}
