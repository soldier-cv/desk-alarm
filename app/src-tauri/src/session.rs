//! 会话锁定检测。Windows 轮询输入桌面；其它平台交给前端生命周期事件。

#[cfg(target_os = "windows")]
use tauri::{AppHandle, Emitter};
#[cfg(not(target_os = "windows"))]
use tauri::AppHandle;

#[cfg(target_os = "windows")]
pub fn start(app: AppHandle) {
    std::thread::Builder::new()
        .name("session-watch".into())
        .spawn(move || {
            // 锁屏时拿不到输入桌面句柄；轮询比消息窗口少依赖，2 秒一次不会空转
            let mut locked = false;
            loop {
                let now = input_desktop_locked();
                if now != locked {
                    locked = now;
                    let ev = if locked { "session:locked" } else { "session:unlocked" };
                    let _ = app.emit(ev, ());
                }
                std::thread::sleep(std::time::Duration::from_secs(2));
            }
        })
        .ok();
}

#[cfg(not(target_os = "windows"))]
pub fn start(_app: AppHandle) {}

#[cfg(target_os = "windows")]
fn input_desktop_locked() -> bool {
    const DESKTOP_READOBJECTS: u32 = 0x0001;
    unsafe {
        let desktop = OpenInputDesktop(0, 0, DESKTOP_READOBJECTS);
        if desktop.is_null() {
            return true;
        }
        CloseDesktop(desktop);
        false
    }
}

#[cfg(target_os = "windows")]
extern "system" {
    fn OpenInputDesktop(dw_flags: u32, inherit: i32, desired_access: u32) -> *mut std::ffi::c_void;
    fn CloseDesktop(desktop: *mut std::ffi::c_void) -> i32;
}
