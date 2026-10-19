//! 应用内更新：Gitee 优先、GitHub 降级。
//! 为什么不用插件内置的 endpoints 轮询、以及为什么选官方插件，见 docs/update.md。

use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;

/// Gitee 上的 latest.json。由 build.yml 生成并上传到 Release。
const GITEE_MANIFEST: &str = "https://gitee.com/huaxudong/desk-alarm/releases/latest/download/latest.json";
const GITHUB_MANIFEST: &str =
    "https://github.com/soldier-cv/desk-alarm/releases/latest/download/latest.json";
const RELEASES_PAGE: &str = "https://gitee.com/huaxudong/desk-alarm/releases";

/// 单次请求超时。国内直连 Gitee 是毫秒级，GitHub 常常超时，
/// 所以 Gitee 先问、超时就降级，不让用户干等。
const REQUEST_TIMEOUT: Duration = Duration::from_secs(8);

/// 整轮检查的总预算。
///
/// 逐段超时管不了"DNS 挂起 / 系统代理黑洞"这类停顿，那种情况下界面会
/// 永远停在"正在检查更新…"，用户能做的只有重启。超预算必然落到一个终态。
const CHECK_BUDGET: Duration = Duration::from_secs(25);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    /// 是否有可用更新
    pub available: bool,
    /// 当前版本
    pub current_version: String,
    /// 远端最新版本，未知时为空串
    pub latest_version: String,
    /// 最终决定使用的清单地址，供日志与排障
    pub source: String,
    /// 是否命中"镜像落后、已改用 GitHub"
    pub mirror_stale: bool,
    /// 给用户看的一句话
    pub message: String,
    /// 手动下载页
    pub release_page: String,
}

/// latest.json 的结构。字段与官方静态 JSON 一致，未出现的部分忽略。
#[derive(Debug, Deserialize)]
struct Manifest {
    #[serde(default)]
    version: String,
    #[serde(default)]
    platforms: std::collections::HashMap<String, Platform>,
}

#[derive(Debug, Deserialize)]
struct Platform {
    #[serde(default)]
    url: String,
    #[serde(default)]
    signature: String,
}

/// 当前平台在清单里的 key，与 Tauri 的 {{target}}-{{arch}} 一致。
fn platform_key() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows-x86_64"
    } else if cfg!(target_os = "macos") {
        // 打包只出 aarch64（CI 用 macos-15 arm64 runner）
        if cfg!(target_arch = "aarch64") {
            "darwin-aarch64"
        } else {
            "darwin-x86_64"
        }
    } else {
        "linux-x86_64"
    }
}

/// 下载地址的硬闸门。
///
/// 地址来自远端 JSON，被劫持的响应完全可以指向任意 exe。
/// 按 `.` 分段比而不是 `ends_with`：否则 `evilgitee.com` 也能通过。
fn is_trusted_download_url(url: &str) -> bool {
    let Ok(parsed) = url::Url::parse(url) else {
        return false;
    };
    if parsed.scheme() != "https" {
        return false;
    }
    let Some(host) = parsed.host_str() else {
        return false;
    };
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    if host.is_empty() {
        return false;
    }
    let is_domain = |base: &str| host == base || host.ends_with(&format!(".{base}"));
    is_domain("gitee.com")
        || is_domain("github.com")
        || is_domain("githubusercontent.com")
        // Gitee 附件最终落在 foruda 上，GitHub 的落在 release-assets 上
        || is_domain("foruda.gitee.com")
        || is_domain("release-assets.githubusercontent.com")
        || is_domain("objects.githubusercontent.com")
}

/// 版本号比较。返回 true 表示 a 比 b 新。
///
/// 只按点分段比数字，不认预发布后缀：清单里的版本来自 tag，
/// 形如 0.2.3，不会出现 1.0.0-beta 这种。
fn is_newer(a: &str, b: &str) -> bool {
    let parse = |s: &str| -> Vec<u64> {
        s.trim_start_matches(['v', 'V'])
            .split('.')
            .map(|p| p.parse::<u64>().unwrap_or(0))
            .collect()
    };
    let (x, y) = (parse(a), parse(b));
    let n = x.len().max(y.len());
    for i in 0..n {
        let (l, r) = (*x.get(i).unwrap_or(&0), *y.get(i).unwrap_or(&0));
        if l != r {
            return l > r;
        }
    }
    false
}

async fn fetch_manifest(url: &str) -> Result<Manifest, String> {
    let resp = reqwest::Client::builder()
        .connect_timeout(REQUEST_TIMEOUT)
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|e| format!("构建 HTTP 客户端失败: {e}"))?
        .get(url)
        .send()
        .await
        .map_err(|e| format!("请求失败: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status().as_u16()));
    }
    resp.json::<Manifest>()
        .await
        .map_err(|e| format!("清单解析失败: {e}"))
}

/// 清单能不能真用来装：版本要更新，且当前平台那一档要齐（url + signature）。
fn usable(m: &Manifest) -> Result<Option<String>, String> {
    let key = platform_key();
    let Some(p) = m.platforms.get(key) else {
        return Err(format!("清单里没有当前平台（{key}）的安装包"));
    };
    if p.url.is_empty() || p.signature.is_empty() {
        return Err(format!("清单里 {key} 的 url 或 signature 为空"));
    }
    // 地址来自远端，不校验的话一个被劫持的清单就能让客户端装任意 exe
    if !is_trusted_download_url(&p.url) {
        return Err(format!("清单里 {key} 的下载地址不受信任，已拒绝"));
    }
    let current = env!("CARGO_PKG_VERSION");
    if is_newer(&m.version, current) {
        Ok(Some(m.version.clone()))
    } else {
        Ok(None)
    }
}

/// 问两条通道，返回该不该更新 + 用哪条。
/// 镜像说"已是最新"时必须再复核 GitHub（理由见 docs/update.md），
/// 复核失败则维持镜像结论：拿不到证据不等于有更新。
async fn resolve() -> Result<UpdateInfo, String> {
    let current = env!("CARGO_PKG_VERSION").to_string();
    let base = || UpdateInfo {
        available: false,
        current_version: current.clone(),
        latest_version: String::new(),
        source: String::new(),
        mirror_stale: false,
        message: String::new(),
        release_page: RELEASES_PAGE.to_string(),
    };

    let gitee = fetch_manifest(GITEE_MANIFEST).await;

    let mut info = base();
    match &gitee {
        Ok(m) => match usable(m) {
            Ok(Some(v)) => {
                info.available = true;
                info.latest_version = v;
                info.source = "Gitee".into();
                info.message = format!("发现新版本 v{}", info.latest_version);
                return Ok(info);
            }
            Ok(None) => {
                // 镜像说已是最新，去 GitHub 复核
                info.source = "Gitee".into();
                info.latest_version = m.version.clone();
            }
            Err(e) => return Err(format!("Gitee 清单不可用: {e}")),
        },
        Err(e) => {
            log::warn!("Gitee 通道不可用（{e}），降级 GitHub");
        }
    }

    // Gitee 不可用，或说已是最新需要复核
    match fetch_manifest(GITHUB_MANIFEST).await {
        Ok(m) => match usable(&m) {
            Ok(Some(v)) => {
                let stale = gitee.is_ok();
                info.available = true;
                info.latest_version = v;
                info.source = if stale { "GitHub（镜像落后）" } else { "GitHub" }.into();
                info.mirror_stale = stale;
                info.message = if stale {
                    format!("Gitee 镜像仍是旧版，已改用 GitHub 的 v{}", info.latest_version)
                } else {
                    format!("发现新版本 v{}", info.latest_version)
                };
                Ok(info)
            }
            Ok(None) => {
                info.message = format!("当前已是最新版本 v{current}");
                Ok(info)
            }
            Err(e) => Err(format!("GitHub 清单不可用: {e}")),
        },
        Err(e) => {
            // 两条通道都拿不到才是真失败
            if gitee.is_ok() {
                // Gitee 成功但说已是最新，GitHub 只是复核失败 —— 维持"已是最新"
                info.message = format!("当前已是最新版本 v{current}");
                Ok(info)
            } else {
                Err(format!("检查更新失败（Gitee 与 GitHub 都不可用）: {e}"))
            }
        }
    }
}

/// 前端调用：只检查，不安装。返回是否有可用更新。
#[tauri::command]
pub async fn check_update() -> Result<UpdateInfo, String> {
    match tokio::time::timeout(CHECK_BUDGET, resolve()).await {
        Ok(r) => r,
        Err(_) => Err(format!(
            "检查更新超时（{} 秒内未完成）。可稍后重试，或到 {} 手动下载",
            CHECK_BUDGET.as_secs(),
            RELEASES_PAGE
        )),
    }
}

/// 前端调用：下载并安装。走插件的 download_and_install，
/// 签名校验与静默安装都由它负责。
#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<String, String> {
    let info = match tokio::time::timeout(CHECK_BUDGET, resolve()).await {
        Ok(Ok(i)) => i,
        Ok(Err(e)) => return Err(e),
        Err(_) => return Err("检查更新超时".into()),
    };

    if !info.available {
        return Ok("当前已是最新版本".into());
    }

    // 用 resolve() 选中的那条通道：既避免重复探测，也保证
    // 「镜像落后时改用 GitHub」这个结论真的被采纳
    let endpoint = if info.mirror_stale || info.source.starts_with("GitHub") {
        GITHUB_MANIFEST
    } else {
        GITEE_MANIFEST
    };

    let url = endpoint
        .parse::<url::Url>()
        .map_err(|e| format!("更新源地址无效: {e}"))?;

    let updater = app
        .updater_builder()
        .endpoints(vec![url])
        .map_err(|e| format!("设置更新源失败: {e}"))?
        .build()
        .map_err(|e| format!("初始化更新器失败: {e}"))?;

    let Some(update) = updater
        .check()
        .await
        .map_err(|e| format!("校验更新失败: {e}"))?
    else {
        return Ok("当前已是最新版本".into());
    };

    let version = update.version.clone();
    // download 内部已做签名校验，验不过直接返回错误，不会走到 install
    let bytes = update
        .download(|_chunk, _total| {}, || {})
        .await
        .map_err(|e| format!("下载更新失败: {e}"))?;

    update
        .install(bytes)
        .map_err(|e| format!("安装更新失败: {e}"))?;

    Ok(format!("已安装 v{version}，重启后生效"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 白名单是一道安全闸门，改坏了不会有任何提示 ——
    /// 放行一个坏地址就等于允许被劫持的清单装任意 exe。
    #[test]
    fn trusted_download_url_only_allows_known_hosts() {
        for ok in [
            "https://gitee.com/a/b.exe",
            "https://foruda.gitee.com/assets/x.exe",
            "https://github.com/soldier-cv/desk-alarm/releases/download/v0.2.2/x.exe",
            "https://release-assets.githubusercontent.com/x",
        ] {
            assert!(is_trusted_download_url(ok), "应放行: {ok}");
        }

        // 后缀绕过是这类白名单最容易犯的错：evilgitee.com 不能被当成 gitee.com
        for bad in [
            "https://evilgitee.com/x.exe",
            "https://gitee.com.evil.com/x.exe",
            // http 明文会被中间人改包
            "http://gitee.com/x.exe",
            "https:/not a url",
        ] {
            assert!(!is_trusted_download_url(bad), "应拒绝: {bad}");
        }
    }

    #[test]
    fn version_compare() {
        assert!(is_newer("0.2.3", "0.2.2"));
        assert!(is_newer("0.3.0", "0.2.9"));
        assert!(is_newer("v1.0.0", "0.9.9"));
        assert!(!is_newer("0.2.2", "0.2.2"));
        assert!(!is_newer("0.2.2", "0.2.3"));
        // 位数不等时按 0 补齐，不能把 0.2 当成比 0.2.0 新
        assert!(!is_newer("0.2", "0.2.0"));
    }
}
