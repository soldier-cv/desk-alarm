//! 三个窗口的显隐、置顶、关不掉这些行为。
//! 关掉的行为是这里最要紧的部分：接管窗口是「强提示」的核心，
//! 必须能压在任何程序之上，并且用户点 X 关不掉。

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
#[cfg(desktop)]
use tauri::PhysicalPosition;

/// 接管窗口是否允许被关掉。
/// 平时是 false，只有前端明确处理完（完成/推迟/静音）才置 true 再关。
static TAKEOVER_UNLOCKED: AtomicBool = AtomicBool::new(false);

pub fn get(app: &AppHandle, label: &str) -> Option<WebviewWindow> {
    app.get_webview_window(label)
}

pub fn show(app: &AppHandle, label: &str) {
    if let Some(w) = get(app, label) {
        let _ = w.show();
        #[cfg(desktop)]
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

pub fn hide(app: &AppHandle, label: &str) {
    if let Some(w) = get(app, label) {
        let _ = w.hide();
    }
}

pub fn toggle_main(app: &AppHandle) {
    if let Some(w) = get(app, "main") {
        if w.is_visible().unwrap_or(false) {
            let _ = w.hide();
        } else {
            show(app, "main");
        }
    }
}

/// 亮出接管窗口。payload 是 JSON，前端监听 `takeover:show` 自己渲染。
/// 先置顶再聚焦，抢当前屏幕焦点。
pub fn show_takeover(app: &AppHandle, payload: serde_json::Value) {
    TAKEOVER_UNLOCKED.store(false, Ordering::SeqCst);
    if let Some(w) = get(app, "takeover") {
        let _ = w.emit("takeover:show", payload);
        #[cfg(desktop)]
        let _ = w.set_always_on_top(true);
        let _ = w.show();
        #[cfg(desktop)]
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// 前端处理完了，允许关窗并隐藏
pub fn hide_takeover(app: &AppHandle) {
    TAKEOVER_UNLOCKED.store(true, Ordering::SeqCst);
    if let Some(w) = get(app, "takeover") {
        let _ = w.hide();
    }
}

/// 用户试图关接管窗口时被调用。
/// 返回 true 表示这次关闭被拦下了。
pub fn block_takeover_close(app: &AppHandle, label: &str) -> bool {
    if label != "takeover" {
        return false;
    }
    if TAKEOVER_UNLOCKED.load(Ordering::SeqCst) {
        return false;
    }
    // 拦下关闭，同时告知前端「用户试图关掉」，让前端把升级程度往上抬
    if let Some(w) = get(app, "takeover") {
        let _ = w.emit("takeover:close-blocked", ());
    }
    true
}

/// 快速捕获窗口。贴在最上层，Esc 或失焦就关。
pub fn show_capture(app: &AppHandle) {
    if let Some(w) = get(app, "capture") {
        #[cfg(desktop)]
        {
            // center 只在建窗时生效，拖过一次后每次唤起都停在旧位置
            center_capture_on_main(app, &w);
            let _ = w.set_always_on_top(true);
        }
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// 对齐到主窗口正中。主窗口隐藏时用它的记忆位置，热键在托盘状态下也能落在正确屏幕。
#[cfg(desktop)]
fn center_capture_on_main(app: &AppHandle, capture: &WebviewWindow) {
    let Some(main) = get(app, "main") else {
        let _ = capture.center();
        return;
    };
    let (Ok(pos), Ok(size), Ok(cap_size)) = (
        main.outer_position(),
        main.outer_size(),
        capture.outer_size(),
    ) else {
        let _ = capture.center();
        return;
    };
    let x = pos.x + (size.width as i32 - cap_size.width as i32) / 2;
    let y = pos.y + (size.height as i32 - cap_size.height as i32) / 2;
    let _ = capture.set_position(PhysicalPosition::new(x, y));
}

pub fn hide_capture(app: &AppHandle) {
    hide(app, "capture");
}
