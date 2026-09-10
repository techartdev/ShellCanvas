// SPDX-License-Identifier: MPL-2.0
//! Reproduce focus re-entry while Tao handles a key message. No remote host,
//! clipboard, user input injection or user-visible window is used.
//! Run: cargo run -p shellcanvas --example windows_keyboard_regression

#[cfg(not(windows))]
fn main() {
    println!("Windows-only keyboard reentrancy regression");
}

#[cfg(windows)]
fn main() {
    use std::{
        sync::atomic::{AtomicBool, Ordering},
        thread,
        time::{Duration, Instant},
    };
    use tao::{
        event_loop::{ControlFlow, EventLoop},
        platform::{run_return::EventLoopExtRunReturn, windows::WindowExtWindows},
        window::WindowBuilder,
    };
    use windows::Win32::{
        Foundation::{HWND, LPARAM, LRESULT, WPARAM},
        UI::{
            Shell::{DefSubclassProc, SetWindowSubclass},
            WindowsAndMessaging::{
                GetQueueStatus, PostMessageW, SendMessageW, QS_SENDMESSAGE, WM_KEYDOWN, WM_KEYUP,
                WM_SETFOCUS,
            },
        },
    };

    static IN_KEY: AtomicBool = AtomicBool::new(false);
    static NESTED_FOCUS: AtomicBool = AtomicBool::new(false);
    static KEY_FINISHED: AtomicBool = AtomicBool::new(false);
    static DONE: AtomicBool = AtomicBool::new(false);

    unsafe extern "system" fn subclass(
        hwnd: HWND,
        msg: u32,
        wp: WPARAM,
        lp: LPARAM,
        _id: usize,
        _data: usize,
    ) -> LRESULT {
        if msg == WM_KEYDOWN {
            IN_KEY.store(true, Ordering::SeqCst);
            // Wait without pumping messages until the worker's synchronous focus
            // message is pending. Tao's PeekMessageW must then dispatch it while
            // its keyboard handler is on the stack, matching the captured hang.
            let start = Instant::now();
            while GetQueueStatus(QS_SENDMESSAGE) >> 16 == 0 {
                if start.elapsed() > Duration::from_secs(3) {
                    eprintln!("Focus message did not arrive");
                    std::process::exit(2);
                }
                thread::yield_now();
            }
            let result = DefSubclassProc(hwnd, msg, wp, lp);
            KEY_FINISHED.store(true, Ordering::SeqCst);
            IN_KEY.store(false, Ordering::SeqCst);
            return result;
        }
        if msg == WM_SETFOCUS && IN_KEY.load(Ordering::SeqCst) {
            NESTED_FOCUS.store(true, Ordering::SeqCst);
        }
        DefSubclassProc(hwnd, msg, wp, lp)
    }

    let mut event_loop = EventLoop::new();
    let window = WindowBuilder::new()
        .with_title("ShellCanvas keyboard regression")
        .with_visible(false)
        .build(&event_loop)
        .expect("create hidden test window");
    let hwnd_value = window.hwnd();
    let hwnd = HWND(hwnd_value as _);
    unsafe {
        assert!(SetWindowSubclass(hwnd, Some(subclass), 1, 0).as_bool());
        PostMessageW(Some(hwnd), WM_KEYDOWN, WPARAM(0x41), LPARAM(1)).unwrap();
    }
    let proxy = event_loop.create_proxy();
    let worker = thread::spawn(move || {
        while !IN_KEY.load(Ordering::SeqCst) {
            thread::yield_now();
        }
        unsafe {
            let hwnd = HWND(hwnd_value as _);
            SendMessageW(hwnd, WM_SETFOCUS, Some(WPARAM(0)), Some(LPARAM(0)));
            SendMessageW(hwnd, WM_KEYUP, Some(WPARAM(0x41)), Some(LPARAM(0xc0000001)));
        }
        proxy.send_event(()).unwrap();
    });
    thread::spawn(|| {
        thread::sleep(Duration::from_secs(10));
        if !DONE.load(Ordering::SeqCst) {
            eprintln!("FAIL: keyboard/focus reentrancy deadlocked");
            std::process::exit(1);
        }
    });
    event_loop.run_return(|event, _, flow| {
        *flow = ControlFlow::Wait;
        if matches!(event, tao::event::Event::UserEvent(())) {
            *flow = ControlFlow::Exit;
        }
    });
    worker.join().unwrap();
    assert!(
        NESTED_FOCUS.load(Ordering::SeqCst),
        "must exercise re-entry"
    );
    assert!(KEY_FINISHED.load(Ordering::SeqCst), "key must complete");
    DONE.store(true, Ordering::SeqCst);
    println!("PASS: nested focus and keyboard release completed without deadlock");
}
