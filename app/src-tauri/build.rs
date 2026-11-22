fn main() {
    // apk-installer / push 是注册进 app 的自定义 Android 插件（Kotlin 实现）。
    // 必须在这里声明它们的命令，tauri-build 才会生成 ACL manifest；
    // 否则前端调用 plugin:xxx|cmd 会被 ACL 拒绝（not allowed by ACL）。
    let attributes = tauri_build::Attributes::new()
        .plugin(
            "apk-installer",
            tauri_build::InlinedPlugin::new()
                .commands(&["download_and_install"])
                .default_permission(tauri_build::DefaultPermissionRule::AllowAllCommands),
        )
        .plugin(
            "push",
            tauri_build::InlinedPlugin::new()
                .commands(&["start", "stop"])
                .default_permission(tauri_build::DefaultPermissionRule::AllowAllCommands),
        );
    tauri_build::try_build(attributes).expect("failed to run tauri-build");
}
