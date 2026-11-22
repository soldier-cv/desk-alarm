package io.github.soldier_cv.deskalarm

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

/**
 * 常驻前台服务：在原生层持有 WebSocket 与心跳，锁屏后 WebView 的 JS 被冻结也不受影响。
 * 到点由原生直接弹通知，不再等 JS——这是锁屏即时到达的关键。
 * 提醒逻辑从 JS 的 alarm.ts 搬过来：强提示按 repeatEverySec 重复，收到 entry.acked 才停。
 */
class DeskAlarmKeepAliveService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    private val main = Handler(Looper.getMainLooper())
    private val executor = Executors.newSingleThreadScheduledExecutor()
    private val nm by lazy { getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager }
    private var wakeLock: PowerManager.WakeLock? = null
    private var client: OkHttpClient? = null
    private var socket: WebSocket? = null
    private var pingTask: ScheduledFuture<*>? = null
    private var reconnectTask: ScheduledFuture<*>? = null
    private val repeatTasks = ConcurrentHashMap<String, ScheduledFuture<*>>()

    @Volatile
    private var running = false
    private var escalateSec = 30
    private var repeatSec = 120

    override fun onCreate() {
        super.onCreate()
        INSTANCE = this
        running = true
        createChannels()
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "deskalarm:push").apply { acquire() }
        startForeground(NOTIFICATION_ID, buildRunningNotification())
        client = OkHttpClient.Builder().pingInterval(25, TimeUnit.SECONDS).build()
        connect()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForeground(NOTIFICATION_ID, buildRunningNotification())
        return START_STICKY
    }

    /** Android 15+ 若给这类服务加了时限，主动停掉，避免系统抛异常杀进程 */
    override fun onTimeout(startId: Int, fgsType: Int) {
        super.onTimeout(startId, fgsType)
        stopSelf(startId)
    }

    override fun onDestroy() {
        running = false
        pingTask?.cancel(false)
        reconnectTask?.cancel(false)
        repeatTasks.values.forEach { it.cancel(false) }
        repeatTasks.clear()
        try { socket?.close(1000, "service stopped") } catch (_: Exception) {}
        executor.shutdownNow()
        try { wakeLock?.let { if (it.isHeld) it.release() } } catch (_: Exception) {}
        if (INSTANCE === this) INSTANCE = null
        super.onDestroy()
    }

    fun applyConfig(baseUrl: String, token: String) {
        val sp = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        sp.edit().putString(KEY_BASE, baseUrl).putString(KEY_TOKEN, token).apply()
        // 已连接时重连用新配置
        socket?.close(1000, "reconnect with new config")
    }

    private fun connect() {
        if (!running) return
        val sp = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val base = sp.getString(KEY_BASE, null) ?: return
        val token = sp.getString(KEY_TOKEN, null) ?: return
        val wsUrl = base.replaceFirst("^http", "ws") + "/api/v1/stream?token=" +
            java.net.URLEncoder.encode(token, "UTF-8")
        val req = Request.Builder().url(wsUrl).build()
        socket = client?.newWebSocket(req, object : WebSocketListener() {
            override fun onOpen(ws: WebSocket, response: Response) {
                pingTask?.cancel(false)
                pingTask = executor.scheduleAtFixedRate({
                    ws.send("{\"t\":\"ping\",\"at\":${System.currentTimeMillis()}}")
                }, 0, 20, TimeUnit.SECONDS)
            }

            override fun onMessage(ws: WebSocket, text: String) {
                try { handle(JSONObject(text)) } catch (_: Exception) {}
            }

            override fun onFailure(ws: WebSocket, t: Throwable, response: Response?) {
                scheduleReconnect()
            }

            override fun onClosed(ws: WebSocket, code: Int, reason: String) {
                scheduleReconnect()
            }
        })
    }

    private fun scheduleReconnect() {
        if (!running) return
        pingTask?.cancel(false)
        if (reconnectTask?.isCancelled == false || reconnectTask?.isDone == false) return
        reconnectTask = executor.schedule({ connect() }, 3, TimeUnit.SECONDS)
    }

    private fun handle(msg: JSONObject) {
        when (msg.optString("t")) {
            "welcome" -> {
                msg.optJSONObject("settings")?.let {
                    escalateSec = it.optInt("escalateAfterSec", 30)
                    repeatSec = it.optInt("repeatEverySec", 120)
                }
                val missed = msg.optJSONArray("missed") ?: JSONArray()
                for (i in 0 until missed.length()) {
                    val entry = missed.optJSONObject(i)?.optJSONObject("entry") ?: continue
                    post(entry, msg.missedStrong(entry))
                }
            }
            "entry.fired" -> {
                val entry = msg.optJSONObject("entry") ?: return
                post(entry, entry.optString("strength") == "strong")
            }
            "entry.weak" -> {
                val entry = msg.optJSONObject("entry") ?: return
                post(entry, false)
            }
            "entry.acked" -> cancel(msg.optString("entryId"))
        }
    }

    /** MissedFire 里强度从 entry 本身取 */
    private fun JSONObject.missedStrong(entry: JSONObject): Boolean =
        entry.optString("strength") == "strong"

    private fun notifyId(entryId: String): Int =
        (entryId.hashCode() and 0x7fffffff).let { if (it == 0) 1 else it }

    private fun post(entry: JSONObject, strong: Boolean) {
        val id = entry.optString("id")
        val text = entry.optString("text")
        if (id.isEmpty() || text.isEmpty()) return
        val nid = notifyId(id)
        val channel = if (strong) CH_STRONG else CH_WEAK
        main.post {
            val open = Intent(this, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_SINGLE_TOP
            }
            val pi = PendingIntent.getActivity(
                this, 0, open,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            val n = NotificationCompat.Builder(this, channel)
                .setSmallIcon(R.drawable.ic_stat_notify)
                .setContentTitle(if (strong) "提醒 · 需要处理" else "提醒")
                .setContentText(text)
                .setContentIntent(pi)
                .setAutoCancel(!strong)
                .setOngoing(strong)
                .build()
            try { nm.notify(nid, n) } catch (_: Exception) {}
        }
        if (strong) scheduleRepeat(nid, id, text)
    }

    /** 强提示：升级点后按 repeatEverySec 重复，直到别处确认 */
    private fun scheduleRepeat(nid: Int, entryId: String, text: String) {
        repeatTasks[entryId]?.cancel(false)
        val task = executor.scheduleAtFixedRate({
            main.post {
                val open = Intent(this, MainActivity::class.java).apply {
                    flags = Intent.FLAG_ACTIVITY_SINGLE_TOP
                }
                val pi = PendingIntent.getActivity(
                    this, 0, open,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                )
                val n = NotificationCompat.Builder(this, CH_STRONG)
                    .setSmallIcon(R.drawable.ic_stat_notify)
                    .setContentTitle("还没处理？")
                    .setContentText(text)
                    .setContentIntent(pi)
                    .setOngoing(true)
                    .build()
                try { nm.notify(nid, n) } catch (_: Exception) {}
            }
        }, escalateSec.toLong(), repeatSec.toLong(), TimeUnit.SECONDS)
        repeatTasks[entryId] = task
    }

    private fun cancel(entryId: String) {
        if (entryId.isEmpty()) return
        repeatTasks.remove(entryId)?.cancel(false)
        main.post {
            try { nm.cancel(notifyId(entryId)) } catch (_: Exception) {}
        }
    }

    private fun createChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        if (nm.getNotificationChannel(CH_RUNNING) == null) {
            val c = NotificationChannel(CH_RUNNING, "提醒保活", NotificationManager.IMPORTANCE_LOW)
            c.description = "保持提醒连接，关闭后锁屏可能收不到提醒"
            nm.createNotificationChannel(c)
        }
        if (nm.getNotificationChannel(CH_STRONG) == null) {
            val c = NotificationChannel(CH_STRONG, "强提醒", NotificationManager.IMPORTANCE_HIGH)
            c.description = "需要立即处理的提醒，响铃震动，锁屏可见"
            c.enableVibration(true)
            c.vibrationPattern = longArrayOf(0, 300, 200, 300)
            c.lockscreenVisibility = Notification.VISIBILITY_PUBLIC
            nm.createNotificationChannel(c)
        }
        if (nm.getNotificationChannel(CH_WEAK) == null) {
            val c = NotificationChannel(CH_WEAK, "轻提醒", NotificationManager.IMPORTANCE_LOW)
            c.description = "轻提醒，静音不打断"
            c.setSound(null, null)
            c.enableVibration(false)
            nm.createNotificationChannel(c)
        }
    }

    private fun buildRunningNotification(): Notification {
        val open = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        val pi = PendingIntent.getActivity(
            this, 0, open,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(this, CH_RUNNING)
            .setSmallIcon(R.drawable.ic_stat_notify)
            .setContentTitle("DeskAlarm 正在后台运行")
            .setContentText("保持提醒连接，锁屏也能收到，点此返回应用")
            .setContentIntent(pi)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    companion object {
        const val PREFS = "deskalarm_push"
        const val KEY_BASE = "baseUrl"
        const val KEY_TOKEN = "token"
        private const val CH_RUNNING = "deskalarm_keepalive"
        private const val CH_STRONG = "deskalarm_strong"
        private const val CH_WEAK = "deskalarm_weak"
        private const val NOTIFICATION_ID = 1001
        @Volatile
        var INSTANCE: DeskAlarmKeepAliveService? = null
    }
}
