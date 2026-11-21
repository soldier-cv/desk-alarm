package io.github.soldier_cv.deskalarm

import android.app.DownloadManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.Settings
import android.widget.Toast
import androidx.core.content.FileProvider
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin
import java.io.File

@InvokeArg
class DownloadAndInstallArgs {
  lateinit var url: String
  var fileName: String? = null
}

/**
 * 安卓端应用内更新：用系统 DownloadManager 下载 APK，下载完成后调起系统安装器。
 * APK 本身用正式 keystore 签名，覆盖安装时系统会自动校验签名一致性。
 */
@TauriPlugin
class ApkInstallerPlugin(private val activity: android.app.Activity) : Plugin(activity) {
  private var pendingInvoke: Invoke? = null
  private var downloadId: Long = -1L
  private var apkFile: File? = null

  @Command
  fun downloadAndInstall(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(DownloadAndInstallArgs::class.java)
      val url = args.url
      if (!url.startsWith("https://") && !url.startsWith("http://")) {
        invoke.reject("下载地址必须用 http/https")
        return
      }
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !activity.packageManager.canRequestPackageInstalls()) {
        // 引导用户开启「安装未知应用」权限，开启后需重新点更新
        invoke.reject("NEED_INSTALL_PERMISSION")
        val intent = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${activity.packageName}"))
        activity.startActivity(intent)
        return
      }

      pendingInvoke?.reject("上一次下载尚未完成")
      pendingInvoke = invoke
      val name = args.fileName?.takeIf { it.endsWith(".apk") } ?: "deskalarm-update.apk"
      val dest = File(activity.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), name)
      if (dest.exists()) dest.delete()
      apkFile = dest

      val request = DownloadManager.Request(Uri.parse(url))
        .setTitle("DeskAlarm 更新")
        .setDescription("正在下载新版本…")
        .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
        .setDestinationUri(Uri.fromFile(dest))
        .setAllowedOverMetered(true)
        .setAllowedOverRoaming(true)

      val dm = activity.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
      downloadId = dm.enqueue(request)

      // 监听下载完成
      activity.registerReceiver(object : BroadcastReceiver() {
        override fun onReceive(ctx: Context, intent: Intent) {
          val id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1L)
          if (id != downloadId) return
          try { activity.unregisterReceiver(this) } catch (_: Exception) {}
          val file = apkFile
          if (file == null || !file.exists()) {
            pendingInvoke?.reject("下载失败，文件不存在")
            pendingInvoke = null
            return
          }
          installApk(file)
          pendingInvoke?.resolve()
          pendingInvoke = null
        }
      }, IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE))
    } catch (ex: Exception) {
      invoke.reject(ex.message ?: "下载失败")
    }
  }

  private fun installApk(file: File) {
    val uri = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
      FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", file)
    } else {
      Uri.fromFile(file)
    }
    val intent = Intent(Intent.ACTION_INSTALL_PACKAGE).apply {
      setDataAndType(uri, "application/vnd.android.package-archive")
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }
    activity.startActivity(intent)
  }
}
