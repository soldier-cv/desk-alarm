package io.github.soldier_cv.deskalarm

import android.content.Context
import android.content.Intent
import android.os.Build
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin

@InvokeArg
class PushStartArgs {
  lateinit var baseUrl: String
  lateinit var token: String
}

/**
 * 把服务端地址与 token 交给常驻服务，由原生层持有 WebSocket。
 * 锁屏后 WebView 的 JS 被冻结，但原生服务照常心跳、收消息、弹通知。
 */
@TauriPlugin
class PushPlugin(private val activity: android.app.Activity) : Plugin(activity) {
  @Command
  fun start(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(PushStartArgs::class.java)
      if (args.baseUrl.isBlank() || args.token.isBlank()) {
        invoke.reject("缺少服务端地址或 token")
        return
      }
      val intent = Intent(activity, DeskAlarmKeepAliveService::class.java)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        activity.startForegroundService(intent)
      } else {
        activity.startService(intent)
      }
      // 服务起来后再写入配置；服务 onCreate 会读，已连接会重连
      DeskAlarmKeepAliveService.INSTANCE?.applyConfig(args.baseUrl, args.token)
        ?: activity.getSharedPreferences(DeskAlarmKeepAliveService.PREFS, Context.MODE_PRIVATE)
          .edit()
          .putString(DeskAlarmKeepAliveService.KEY_BASE, args.baseUrl)
          .putString(DeskAlarmKeepAliveService.KEY_TOKEN, args.token)
          .apply()
      invoke.resolve()
    } catch (ex: Exception) {
      invoke.reject(ex.message ?: "启动推送失败")
    }
  }

  @Command
  fun stop(invoke: Invoke) {
    try {
      activity.stopService(Intent(activity, DeskAlarmKeepAliveService::class.java))
      invoke.resolve()
    } catch (ex: Exception) {
      invoke.reject(ex.message ?: "停止推送失败")
    }
  }
}
