//! 前端能调的原生能力。都很薄，主要价值是把窗口行为和系统集成
//! 收在 Rust 这边，前端只管发意图。

use serde_json::Value;
use tauri::AppHandle;
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use tauri_plugin_opener::OpenerExt;

use crate::windows;

#[tauri::command]
pub fn show_main(app: AppHandle) {
    windows::show(&app, "main");
}

#[tauri::command]
pub fn hide_main(app: AppHandle) {
    windows::hide(&app, "main");
}

#[tauri::command]
pub fn toggle_main(app: AppHandle) {
    windows::toggle_main(&app);
}

/// 亮出强提醒接管窗口。payload 直接透传给前端
#[tauri::command]
pub fn show_takeover(app: AppHandle, payload: Value) {
    windows::show_takeover(&app, payload);
}

/// 前端处理完之后调用，解锁并收起接管窗口
#[tauri::command]
pub fn hide_takeover(app: AppHandle) {
    windows::hide_takeover(&app);
}

#[tauri::command]
pub fn show_capture(app: AppHandle) {
    windows::show_capture(&app);
}

#[tauri::command]
pub fn hide_capture(app: AppHandle) {
    windows::hide_capture(&app);
}

/// 打开链接。用户在提醒里点了「打开链接」时用，走系统默认浏览器。
#[tauri::command]
pub fn open_external(app: AppHandle, url: String) -> Result<(), String> {
    // 只放行 http/https，挡掉 file: 和 javascript:
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err(format!("不支持的协议: {url}"));
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}

/// 开机自启开关。Windows 下写当前用户的 Run 键，不需要管理员
#[tauri::command]
pub fn set_autostart(app: AppHandle, enable: bool) -> Result<bool, String> {
    let mgr = app.autolaunch();
    let args = vec!["--minimized".to_string()];
    if enable {
        mgr.enable().map_err(|e| e.to_string())?;
    } else {
        mgr.disable().map_err(|e| e.to_string())?;
    }
    let _ = args;
    mgr.is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn is_autostart_enabled(app: AppHandle) -> Result<bool, String> {
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

/// 试响。用系统提示音，让用户确认这台设备能真的出声。
/// dev 模式下通知图标显示成 PowerShell 是正常的，打包后才正常。
#[tauri::command]
pub fn ping(app: AppHandle, title: String, body: String) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|e| e.to_string())
}

/**
 * 注册全局热键。写在 Rust 侧而不是用 JS 插件，是为了让它在
 * 前端 webview 还没加载完时就能工作，程序刚起来就能用。
 */
pub fn register_capture_hotkey(app: &AppHandle, accelerator: &str) -> Result<(), String> {
    let shortcut: Shortcut = accelerator.parse().map_err(|e| format!("{e:?}"))?;
    app.global_shortcut()
        .on_shortcut(shortcut, move |app, _sc, event| {
            if event.state() == ShortcutState::Pressed {
                use tauri::Emitter;
                let _ = app.emit("hotkey:capture", ());
                crate::windows::show_capture(app);
            }
        })
        .map_err(|e| e.to_string())
}

pub fn unregister_all(app: &AppHandle) {
    let _ = app.global_shortcut().unregister_all();
}
