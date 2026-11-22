//! 前端能调的原生能力。都很薄，主要价值是把窗口行为和系统集成
//! 收在 Rust 这边，前端只管发意图。

use serde_json::Value;
use tauri::AppHandle;
#[cfg(desktop)]
use tauri::Manager;
#[cfg(desktop)]
use tauri_plugin_autostart::ManagerExt;
#[cfg(desktop)]
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
#[cfg(desktop)]
use tauri_plugin_opener::OpenerExt;

use crate::windows;

#[cfg(desktop)]
fn close_behavior_file(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|p| p.join("close-behavior.txt"))
}

/// 前端没保存过设置前保持 tray，别让老用户升级后按钮行为突然变了
#[cfg(desktop)]
pub fn close_behavior(app: &AppHandle) -> String {
    let Some(path) = close_behavior_file(app) else {
        return "tray".into();
    };
    match std::fs::read_to_string(path) {
        Ok(s) if s.trim() == "quit" => "quit".into(),
        _ => "tray".into(),
    }
}

#[cfg(desktop)]
#[tauri::command]
pub fn get_close_behavior(app: AppHandle) -> String {
    close_behavior(&app)
}

#[cfg(desktop)]
#[tauri::command]
pub fn set_close_behavior(app: AppHandle, behavior: String) -> Result<(), String> {
    if behavior != "quit" && behavior != "tray" {
        return Err(format!("无效的关闭行为: {behavior}"));
    }
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("close-behavior.txt"), behavior.as_bytes())
        .map_err(|e| e.to_string())
}

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
#[cfg(desktop)]
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
#[cfg(desktop)]
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

#[cfg(desktop)]
#[tauri::command]
pub fn is_autostart_enabled(app: AppHandle) -> Result<bool, String> {
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

/// 试响。用系统提示音，让用户确认这台设备能真的出声。
/// dev 模式下通知图标显示成 PowerShell 是正常的，打包后才正常。
#[tauri::command]
pub fn ping(app: AppHandle, title: String, body: String, sound: Option<String>) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    let mut b = app.notification().builder();
    b = b.title(title).body(body);
    // sound='none' 时静音：弱提醒不该抢注意力
    if sound.as_deref() == Some("none") {
        b = b.sound("none");
    }
    b.show().map_err(|e| e.to_string())
}

/**
 * 注册全局热键。写在 Rust 侧而不是用 JS 插件，是为了让它在
 * 前端 webview 还没加载完时就能工作，程序刚起来就能用。
 */
#[cfg(desktop)]
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

#[cfg(desktop)]
#[allow(dead_code)]
pub fn unregister_all(app: &AppHandle) {
    let _ = app.global_shortcut().unregister_all();
}

#[cfg(target_os = "windows")]
fn read_machine_id() -> Option<String> {
    use winreg::enums::HKEY_LOCAL_MACHINE;
    use winreg::RegKey;
    let key = RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey(r"SOFTWARE\Microsoft\Cryptography")
        .ok()?;
    let guid: String = key.get_value("MachineGuid").ok()?;
    let guid = guid.trim();
    (!guid.is_empty()).then(|| guid.to_string())
}

#[cfg(target_os = "linux")]
fn read_machine_id() -> Option<String> {
    let id = std::fs::read_to_string("/etc/machine-id").ok()?;
    let id = id.trim();
    (!id.is_empty()).then(|| id.to_string())
}

#[cfg(target_os = "android")]
fn read_machine_id() -> Option<String> {
    use std::process::Command;
    // Android 没有 /etc/machine-id；用系统属性里的稳定标识
    for key in ["ro.serialno", "ro.boot.serialno", "ro.android_id"] {
        let out = Command::new("getprop").arg(key).output().ok()?;
        if !out.status.success() {
            continue;
        }
        let id = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !id.is_empty() {
            return Some(id);
        }
    }
    None
}

#[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "android")))]
fn read_machine_id() -> Option<String> {
    None
}

/// 取不到真实 id 也得稳定，否则每次登录服务端都当成一台新设备
fn fallback_machine_id() -> String {
    #[cfg(target_os = "windows")]
    let host = std::env::var("COMPUTERNAME").unwrap_or_default();
    #[cfg(target_os = "android")]
    let host = {
        use std::process::Command;
        ["ro.product.brand", "ro.product.model", "ro.build.fingerprint"]
            .iter()
            .filter_map(|k| Command::new("getprop").arg(k).output().ok())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .collect::<Vec<_>>()
            .join("|")
    };
    #[cfg(all(not(target_os = "windows"), not(target_os = "android")))]
    let host = std::env::var("HOSTNAME")
        .or_else(|_| std::fs::read_to_string("/etc/hostname"))
        .unwrap_or_default();

    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in format!("deskalarm-salt-v1:{host}").bytes() {
        hash ^= byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("fallback-{hash:016x}")
}

#[tauri::command]
pub fn machine_id() -> Result<String, String> {
    Ok(read_machine_id().unwrap_or_else(fallback_machine_id))
}

/// 前端按平台决定显示哪些原生按钮。移动端没有托盘和全局热键。
#[tauri::command]
pub fn platform() -> String {
    let os = if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "android") {
        "android"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "web"
    };
    os.to_string()
}
