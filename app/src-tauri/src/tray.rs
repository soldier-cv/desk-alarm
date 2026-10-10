//! 托盘图标。桌面常驻工具的命根子：
//! 关掉窗口不退出程序，只缩到托盘。

use tauri::{
    menu::{Menu, MenuEvent, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter,
};

pub const EV_TRAY_CAPTURE: &str = "tray:capture";
pub const EV_TRAY_QUIT: &str = "tray:quit";

pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "打开主界面", true, None::<&str>)?;
    let capture = MenuItem::with_id(app, "capture", "快速记一条", true, Some("Ctrl+Shift+Space"))?;
    let sep = tauri::menu::PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "退出提醒器", true, None::<&str>)?;

    let menu = Menu::with_items(app, &[&open, &capture, &sep, &quit])?;

    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| tauri::Error::AssetNotFound("tray icon".into()))?;

    TrayIconBuilder::with_id("main-tray")
        .icon(icon)
        .icon_as_template(false)
        .tooltip("提醒器")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(on_menu)
        .on_tray_icon_event(|tray, event| {
            // 左键单击直接开主界面，菜单留给右键
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                crate::windows::toggle_main(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

fn on_menu(app: &AppHandle, event: MenuEvent) {
    match event.id().as_ref() {
        "open" => crate::windows::show(app, "main"),
        "capture" => {
            let _ = app.emit(EV_TRAY_CAPTURE, ());
            crate::windows::show_capture(app);
        }
        "quit" => {
            // 退出前先广播，让前端把 WS 关掉，服务端才会把设备标离线
            let _ = app.emit(EV_TRAY_QUIT, ());
            app.exit(0);
        }
        _ => {}
    }
}
