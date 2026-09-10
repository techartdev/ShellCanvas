# ShellCanvas filesystem SDK

Optional rooted filesystem handles for native bridge applications. This crate has
no WinFsp, FUSE, SSH, desktop-window or kernel-driver dependency. It is MPL-2.0.

Providers implement `MountedFileSystem` only when they support filesystem-style
access. Sequential download/upload contracts remain separate. `MountPath` is a
validated sequence of relative components, not an arbitrary remote pathname.

`wire::Server` serves one explicitly granted provider/root through inherited
anonymous pipes. `wire::Client` is the blocking counterpart used by native OS
callbacks. Frames are length-prefixed JSON with a 1 MiB bound, protocol version
and monotonic request ID. File I/O uses 32 KiB chunks and directory replies use
pages; those are request bounds, not limits on file or directory totals.

One server instance owns its file/directory handles. Source reconnection creates
a new grant; old handles must never be attached to it. A timed-out operation
retires the transport and is not replayed. The desktop must supervise the native
process and release its grant on teardown; this protocol is not a sandbox for
native executables.

The independent Drive Bridge vendors a snapshot of this crate for standalone
builds. Update that snapshot and validate the protocol whenever changing it.
