//! 三个窗口的显隐、置顶、关不掉这些行为。
//! 关掉的行为是这里最要紧的部分：接管窗口是「强提示」的核心，
//! 必须能压在任何程序之上，并且用户点 X 关不掉。

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

/// 接管窗口是否允许被关掉。
/// 平时是 false，只有前端明确处理完（完成/推迟/静音）才置 true 再关。
static TAKEOVER_UNLOCKED: AtomicBool = AtomicBool::new(false);

pub fn get(app: &AppHandle, label: &str) -> Option<WebviewWindow> {
    app.get_webview_window(label)
}

pub fn show(app: &AppHandle, label: &str) {
    if let Some(w) = get(app, label) {
        let _ = w.show();
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
        let _ = w.set_always_on_top(true);
        let _ = w.show();
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
        let _ = w.set_always_on_top(true);
        let _ = w.show();
        let _ = w.set_focus();
    }
}

pub fn hide_capture(app: &AppHandle) {
    hide(app, "capture");
}
