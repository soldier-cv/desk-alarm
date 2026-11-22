mod commands;
mod logging;
mod session;
mod update;
mod windows;

#[cfg(desktop)]
mod tray;

use tauri::Manager;
#[cfg(desktop)]
use tauri::Listener;
#[cfg(desktop)]
use tauri_plugin_autostart::MacosLauncher;
#[cfg(desktop)]
use tauri_plugin_opener::init as opener_init;

/// 开机自启要带的参数。带这个参数启动时不弹主窗口，直接进托盘
#[cfg(desktop)]
const AUTOSTART_ARG: &str = "--minimized";

/// Ctrl+Shift+Space 随手记一条。写死在 Rust 侧，程序刚起来热键就能用。
#[cfg(desktop)]
const CAPTURE_HOTKEY: &str = "Ctrl+Shift+Space";

/// 命令行里有没有 --minimized。开机自启时带这个，只进托盘不弹窗。
#[cfg(desktop)]
fn started_minimized() -> bool {
    std::env::args().any(|a| a == AUTOSTART_ARG)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

    // 桌面专属插件在移动端要么没实现要么行为不对，用 cfg 隔开
    #[cfg(desktop)]
    let builder = builder
        // 再点一次 exe 时只唤出已有窗口，避免多开导致任务栏/托盘一堆图标
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(opener_init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec![AUTOSTART_ARG]),
        ))
        .plugin(tauri_plugin_updater::Builder::new().build());

    // 通知插件桌面和移动端都能用（移动端靠它弹系统通知）
    let builder = builder.plugin(tauri_plugin_notification::init());

    // 安卓端注册 ApkInstallerPlugin 的同名空插件，让前端
    // invoke('plugin:apk-installer|download_and_install') 路由到 Kotlin 实现。
    #[cfg(target_os = "android")]
    let builder = builder.plugin(
        tauri::plugin::Builder::<_, ()>::new("apk-installer")
            .setup(|_app, api| {
                #[cfg(target_os = "android")]
                api.register_android_plugin("io.github.soldier_cv.deskalarm", "ApkInstallerPlugin")?;
                Ok(())
            })
            .build(),
    );

    // 原生常驻 WS + 唤醒锁：把服务端地址与 token 交给 Kotlin 服务
    #[cfg(target_os = "android")]
    let builder = builder.plugin(
        tauri::plugin::Builder::<_, ()>::new("push")
            .setup(|_app, api| {
                api.register_android_plugin("io.github.soldier_cv.deskalarm", "PushPlugin")?;
                Ok(())
            })
            .build(),
    );

    builder
        .setup(|app| {
            let handle = app.handle().clone();

            logging::prune_on_startup(&handle);
            // 上次安装被中断留下的包，启动后清掉
            update::cleanup_installers(&handle);
            session::start(handle.clone());

            #[cfg(desktop)]
            {
                tray::build(&handle)?;
                commands::register_capture_hotkey(&handle, CAPTURE_HOTKEY)
                    .map_err(|e| format!("全局热键注册失败: {e}"))?;

                // 开机自启来的：别弹主窗口，用户点托盘图标再开
                if !started_minimized() {
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.show();
                    }
                }

                // 桌面有三个窗口；移动端只有一个 main，这些 label 不存在时会跳过
                for label in ["main", "takeover", "capture"] {
                    let Some(win) = app.get_webview_window(label) else {
                        continue;
                    };
                    let h = handle.clone();
                    let target = win.clone();
                    win.on_window_event(move |event| {
                        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                            if windows::block_takeover_close(&h, label) {
                                api.prevent_close();
                                return;
                            }
                            if label == "capture" {
                                api.prevent_close();
                                windows::hide_capture(&h);
                                return;
                            }
                            if label == "main" {
                                // 另两个窗口只是隐藏还活着，光关 main 不会触发进程退出
                                if commands::close_behavior(&h) == "quit" {
                                    h.exit(0);
                                    return;
                                }
                            }
                            api.prevent_close();
                            let _ = target.hide();
                        }
                    });
                }

                let h2 = handle.clone();
                handle.listen(tray::EV_TRAY_CAPTURE, move |_| {
                    windows::show_capture(&h2);
                });
            }

            let _ = &handle;
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
            commands::ping,
            commands::machine_id,
            commands::platform,
            #[cfg(desktop)]
            commands::open_external,
            #[cfg(desktop)]
            commands::set_autostart,
            #[cfg(desktop)]
            commands::is_autostart_enabled,
            #[cfg(desktop)]
            commands::set_close_behavior,
            #[cfg(desktop)]
            commands::get_close_behavior,
            logging::log_event,
            logging::get_log_policy,
            logging::set_log_policy,
            update::check_update,
            update::download_update,
            update::install_update,
        ])
        .build(tauri::generate_context!())
        .expect("DeskAlarm 构建失败")
        .run(|app, event| {
            // 最后一个窗口关掉时不要退出，托盘常驻；退出模式下放过
            #[cfg(desktop)]
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                if code.is_none() && commands::close_behavior(app) != "quit" {
                    api.prevent_exit();
                }
            }
            #[cfg(not(desktop))]
            let _ = (app, event);
        });
}
