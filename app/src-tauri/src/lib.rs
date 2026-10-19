mod commands;
mod tray;
mod update;
mod windows;

use tauri::{Listener, Manager};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_opener::init as opener_init;

/// 开机自启要带的参数。带这个参数启动时不弹主窗口，直接进托盘
const AUTOSTART_ARG: &str = "--minimized";

/// Ctrl+Shift+Space 随手记一条。
/// 写死在 Rust 侧，前端不参与，这样程序刚起来热键就能用。
const CAPTURE_HOTKEY: &str = "Ctrl+Shift+Space";

/// 命令行里有没有 --minimized。开机自启时带这个，只进托盘不弹窗。
fn started_minimized() -> bool {
    std::env::args().any(|a| a == AUTOSTART_ARG)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(opener_init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec![AUTOSTART_ARG]),
        ))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let handle = app.handle().clone();

            tray::build(&handle)?;
            commands::register_capture_hotkey(&handle, CAPTURE_HOTKEY)
                .map_err(|e| format!("全局热键注册失败: {e}"))?;

            // 开机自启来的：别弹主窗口，用户点托盘图标再开
            if !started_minimized() {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                }
            }

            for label in ["main", "takeover", "capture"] {
                let Some(win) = app.get_webview_window(label) else {
                    continue;
                };
                let h = handle.clone();
                // 闭包要用 win 的话得先 clone 一份，
                // 直接 move 进去会因为 on_window_event 还借用着它而报错
                let target = win.clone();
                win.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        // 接管窗口：关不掉，除非前端已经解锁
                        if windows::block_takeover_close(&h, label) {
                            api.prevent_close();
                            return;
                        }
                        // 捕获窗口：关掉等于收起
                        if label == "capture" {
                            api.prevent_close();
                            windows::hide_capture(&h);
                            return;
                        }
                        // 主窗口：缩回托盘，程序继续在后台跑
                        api.prevent_close();
                        let _ = target.hide();
                    }
                });
            }

            // 托盘菜单点「快速记一条」时，前端也要知道，好把焦点收进输入框
            let h2 = handle.clone();
            handle.listen(tray::EV_TRAY_CAPTURE, move |_| {
                windows::show_capture(&h2);
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::show_main,
            commands::hide_main,
            commands::toggle_main,
            commands::show_takeover,
            commands::hide_takeover,
            commands::show_capture,
            commands::hide_capture,
            commands::open_external,
            commands::set_autostart,
            commands::is_autostart_enabled,
            commands::ping,
            update::check_update,
            update::install_update,
        ])
        .build(tauri::generate_context!())
        .expect("DeskAlarm 构建失败")
        .run(|app, event| {
            // 最后一个窗口关掉时不要退出，托盘常驻
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                if code.is_none() {
                    api.prevent_exit();
                }
            }
            let _ = app;
        });
}
