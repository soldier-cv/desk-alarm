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
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

/**
 * 常驻前台服务：原生层持有 WebSocket 与心跳，锁屏后 WebView 冻结仍能即时收到提醒。
 * 逾期复催节奏（强提醒 0/15m/1h/每2h、弱提醒 0/30m/每3h汇总）与上线 overdue 补发统一由服务端驱动。
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

    @Volatile
    private var running = false
    private var quietStartMin = 23 * 60 + 30
    private var quietEndMin = 7 * 60
    @Volatile
    private var sound = "system"
    @Volatile
    private var lastWeakDigestAt = 0L

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

    override fun onTimeout(startId: Int, fgsType: Int) {
        super.onTimeout(startId, fgsType)
        stopSelf(startId)
    }

    override fun onDestroy() {
        running = false
        pingTask?.cancel(false)
        reconnectTask?.cancel(false)
        try { socket?.close(1000, "service stopped") } catch (_: Exception) {}
        executor.shutdownNow()
        try { wakeLock?.let { if (it.isHeld) it.release() } } catch (_: Exception) {}
        if (INSTANCE === this) INSTANCE = null
        super.onDestroy()
    }

    fun applyConfig(baseUrl: String, token: String) {
        val sp = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        sp.edit().putString(KEY_BASE, baseUrl).putString(KEY_TOKEN, token).apply()
        pingTask?.cancel(false)
        reconnectTask?.cancel(false)
        val old = socket
        if (old == null) connect() else old.close(1000, "reconnect with new config")
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
                    quietStartMin = it.optInt("quietStartMin", quietStartMin)
                    quietEndMin = it.optInt("quietEndMin", quietEndMin)
                    val next = it.optString("sound", sound)
                    if (next != sound) { sound = next; applySoundSetting() }
                }
                if (inQuiet()) return
                val overdue = msg.optJSONArray("overdue") ?: JSONArray()
                var strongCount = 0
                var firstStrongId = ""
                var firstStrongText = ""
                var weakCount = 0
                var oldestWeakDue = Long.MAX_VALUE
                var weakSample = ""
                for (i in 0 until overdue.length()) {
                    val p = overdue.optJSONObject(i) ?: continue
                    val strength = p.optString("strength", "weak")
                    if (strength == "strong") {
                        strongCount++
                        if (firstStrongId.isEmpty()) {
                            firstStrongId = p.optString("id")
                            firstStrongText = p.optString("text")
                        }
                    } else {
                        weakCount++
                        val due = p.optLong("dueAt", System.currentTimeMillis())
                        if (due < oldestWeakDue) {
                            oldestWeakDue = due
                            weakSample = p.optString("text")
                        }
                    }
                }
                if (strongCount > 0 && firstStrongId.isNotEmpty()) {
                    val title = if (strongCount == 1) firstStrongText else "有 $strongCount 条强提醒已逾期，需立即处理"
                    val body = if (strongCount == 1) "已逾期未处理，点开立即处理" else "首条：$firstStrongText"
                    post(firstStrongId, title, body, 4)
                }
                if (weakCount > 0) {
                    postWeakDigest(weakCount, oldestWeakDue, weakSample)
                } else if (strongCount == 0) {
                    val missed = msg.optJSONArray("missed") ?: JSONArray()
                    if (missed.length() > 0) postMissed(missed.length())
                }
            }
            "pursuit.nudge" -> {
                if (inQuiet()) return
                val pursuit = msg.optJSONObject("pursuit") ?: return
                val id = pursuit.optString("id")
                val text = pursuit.optString("text")
                if (id.isEmpty() || text.isEmpty()) return
                val level = msg.optInt("level", 2)
                if (level != 2 && level != 4) return
                val dueAt = pursuit.optLong("dueAt", 0L)
                if (level == 2 && dueAt > 0L &&
                    System.currentTimeMillis() - dueAt > 60_000L &&
                    System.currentTimeMillis() - lastWeakDigestAt < 60_000L) {
                    return
                }
                val reason = msg.optString("reason")
                post(id, text, reason, level)
            }
            "pursuit.overdue_digest" -> {
                if (inQuiet()) return
                val count = msg.optInt("count", 0)
                if (count <= 0) return
                val oldestDue = msg.optLong("oldestDueAt", System.currentTimeMillis())
                val sample = msg.optString("sample")
                postWeakDigest(count, oldestDue, sample)
            }
            "pursuit.followed" -> cancel(msg.optJSONObject("pursuit")?.optString("id") ?: "")
            "pursuit.deleted" -> cancel(msg.optString("pursuitId"))
        }
    }

    private fun notifyId(pursuitId: String): Int =
        (pursuitId.hashCode() and 0x7fffffff).let { if (it == 0) 1 else it }

    private fun openIntent(): PendingIntent {
        val open = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        return PendingIntent.getActivity(
            this, 0, open,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    private fun overdueLabel(dueAtMs: Long): String {
        val min = ((System.currentTimeMillis() - dueAtMs).coerceAtLeast(0L)) / 60_000L
        if (min < 1L) return "片刻"
        if (min < 60L) return "${min} 分钟"
        val h = min / 60L
        if (h < 24L) return "${h} 小时"
        return "${h / 24L} 天"
    }

    private fun post(pursuitId: String, text: String, reason: String, level: Int) {
        val nid = notifyId(pursuitId)
        main.post {
            val channel = if (level == 4) CH_STRONG else CH_WEAK
            val n = NotificationCompat.Builder(this, channel)
                .setSmallIcon(R.drawable.ic_stat_notify)
                .setContentTitle(text)
                .setContentText(reason)
                .setContentIntent(openIntent())
                .setAutoCancel(level != 4)
                .setOngoing(level == 4)
                .build()
            try { nm.notify(nid, n) } catch (_: Exception) {}
        }
    }

    private fun postWeakDigest(count: Int, oldestDueAt: Long, sample: String) {
        lastWeakDigestAt = System.currentTimeMillis()
        val body = "最早一条已逾期 ${overdueLabel(oldestDueAt)}${if (sample.isNotEmpty()) " · $sample" else ""}"
        main.post {
            val n = NotificationCompat.Builder(this, CH_WEAK)
                .setSmallIcon(R.drawable.ic_stat_notify)
                .setContentTitle("有 $count 条提醒已逾期未处理")
                .setContentText(body)
                .setContentIntent(openIntent())
                .setAutoCancel(true)
                .build()
            try { nm.notify(DIGEST_NOTIFICATION_ID, n) } catch (_: Exception) {}
        }
    }

    private fun postMissed(count: Int) {
        main.post {
            val n = NotificationCompat.Builder(this, CH_STRONG)
                .setSmallIcon(R.drawable.ic_stat_notify)
                .setContentTitle("有 $count 条跟进等你处理")
                .setContentText("点开看看哪些到点了")
                .setContentIntent(openIntent())
                .setAutoCancel(true)
                .build()
            try { nm.notify(MISSED_NOTIFICATION_ID, n) } catch (_: Exception) {}
        }
    }

    private fun inQuiet(): Boolean {
        if (quietStartMin == quietEndMin) return false
        val cal = java.util.Calendar.getInstance()
        val m = cal.get(java.util.Calendar.HOUR_OF_DAY) * 60 + cal.get(java.util.Calendar.MINUTE)
        return if (quietStartMin < quietEndMin) m >= quietStartMin && m < quietEndMin
        else m >= quietStartMin || m < quietEndMin
    }

    private fun cancel(pursuitId: String) {
        if (pursuitId.isEmpty()) return
        main.post {
            try { nm.cancel(notifyId(pursuitId)) } catch (_: Exception) {}
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
            c.description = "轻提醒与逾期汇总，静音不打断"
            c.setSound(null, null)
            c.enableVibration(false)
            nm.createNotificationChannel(c)
        }
    }

    private fun applySoundSetting() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val c = nm.getNotificationChannel(CH_STRONG) ?: return
        if (sound == "none") {
            c.setSound(null, null)
            c.enableVibration(false)
        } else {
            val attr = android.media.AudioAttributes.Builder()
                .setUsage(android.media.AudioAttributes.USAGE_NOTIFICATION)
                .setContentType(android.media.AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build()
            c.setSound(android.provider.Settings.System.DEFAULT_NOTIFICATION_URI, attr)
            c.enableVibration(true)
        }
        nm.createNotificationChannel(c)
    }

    private fun buildRunningNotification(): Notification {
        return NotificationCompat.Builder(this, CH_RUNNING)
            .setSmallIcon(R.drawable.ic_stat_notify)
            .setContentTitle("DeskAlarm 正在后台运行")
            .setContentText("保持提醒连接，锁屏也能收到，点此返回应用")
            .setContentIntent(openIntent())
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
        private const val NOTIFICATION_ID = 10001
        private const val MISSED_NOTIFICATION_ID = 10002
        private const val DIGEST_NOTIFICATION_ID = 10003
        @Volatile
        var INSTANCE: DeskAlarmKeepAliveService? = null
    }
}
