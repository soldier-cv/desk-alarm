//! 本地日志：前端只上报关键事件，Rust 按天写文件并按策略清理。

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogPolicy {
    pub level: String,
    pub enabled: bool,
    pub retention_days: u32,
}

impl Default for LogPolicy {
    fn default() -> Self {
        Self {
            level: "info".into(),
            enabled: true,
            retention_days: 7,
        }
    }
}

fn policy_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|p| p.join("log-policy.json"))
}

pub fn load_policy(app: &AppHandle) -> LogPolicy {
    let Some(path) = policy_path(app) else {
        return LogPolicy::default();
    };
    let Ok(text) = std::fs::read_to_string(path) else {
        return LogPolicy::default();
    };
    serde_json::from_str::<LogPolicy>(&text).unwrap_or_default()
}

fn save_policy(app: &AppHandle, policy: &LogPolicy) -> Result<(), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let text = serde_json::to_string(policy).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("log-policy.json"), text).map_err(|e| e.to_string())
}

fn logs_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_log_dir().ok().map(|p| p.join("logs"))
}

fn rank(level: &str) -> u8 {
    match level.to_ascii_lowercase().as_str() {
        "debug" => 0,
        "info" => 1,
        "warn" => 2,
        "error" => 3,
        _ => 1,
    }
}

// 日期只用于文件名和时间戳，自己换算比引入 chrono 省一个依赖
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = mp + if mp < 10 { 3 } else { -9 };
    (y + if m <= 2 { 1 } else { 0 }, m as u32, d as u32)
}

fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = y - if m <= 2 { 1 } else { 0 };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = m as i64 + if m > 2 { -3 } else { 9 };
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

fn now_parts() -> (i64, u32, u32, u32, u32, u32) {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    let days = secs.div_euclid(86_400);
    let sod = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    (
        y,
        m,
        d,
        (sod / 3600) as u32,
        ((sod % 3600) / 60) as u32,
        (sod % 60) as u32,
    )
}

#[tauri::command]
pub fn log_event(app: AppHandle, level: String, message: String) {
    let policy = load_policy(&app);
    if !policy.enabled || rank(&level) < rank(&policy.level) {
        return;
    }
    let Some(dir) = logs_dir(&app) else {
        return;
    };
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let (y, m, d, hh, mm, ss) = now_parts();
    let date = format!("{y:04}-{m:02}-{d:02}");
    let line = format!(
        "{date} {hh:02}:{mm:02}:{ss:02} [{}] {}\n",
        level.to_ascii_uppercase(),
        message.replace(['\r', '\n'], " ")
    );
    let file = dir.join(format!("{date}.log"));
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(file)
    {
        let _ = f.write_all(line.as_bytes());
    }
}

#[tauri::command]
pub fn get_log_policy(app: AppHandle) -> LogPolicy {
    load_policy(&app)
}

#[tauri::command]
pub fn set_log_policy(
    app: AppHandle,
    level: String,
    enabled: bool,
    retention_days: u32,
) -> Result<(), String> {
    let level = level.to_ascii_lowercase();
    if !matches!(level.as_str(), "debug" | "info" | "warn" | "error") {
        return Err(format!("无效的日志级别: {level}"));
    }
    let retention_days = retention_days.clamp(1, 3650);
    let policy = LogPolicy {
        level,
        enabled,
        retention_days,
    };
    save_policy(&app, &policy)?;
    prune(&app, retention_days);
    Ok(())
}

pub fn prune_on_startup(app: &AppHandle) {
    let policy = load_policy(app);
    prune(app, policy.retention_days);
}

/// 在系统文件管理器里打开日志目录，方便直接看按天写下的日志文件。
#[tauri::command]
pub fn open_logs_dir(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let dir = logs_dir(&app).ok_or_else(|| "拿不到日志目录".to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    app.opener()
        .open_path(dir.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| e.to_string())
}

fn prune(app: &AppHandle, retention_days: u32) {
    let Some(dir) = logs_dir(app) else {
        return;
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };
    let today = (SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        / 86_400) as i64;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let Some(stem) = name.strip_suffix(".log") else {
            continue;
        };
        let parts: Vec<_> = stem.split('-').collect();
        if parts.len() != 3 {
            continue;
        }
        let (Ok(y), Ok(m), Ok(d)) = (
            parts[0].parse::<i64>(),
            parts[1].parse::<u32>(),
            parts[2].parse::<u32>(),
        ) else {
            continue;
        };
        if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
            continue;
        }
        if today - days_from_civil(y, m, d) >= retention_days as i64 {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}
