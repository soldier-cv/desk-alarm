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
 * 常驻前台服务：原生层持有 WebSocket 与心跳，锁屏后 WebView 的 JS 被冻结也不受影响。
 * 只认 pursuit.nudge：level=4 是强提醒（常驻通知等处理），level=2 是弱提醒（通知并按节奏重复）。
 * 弱提醒重复间隔与 app/src/alarm.ts 的 WEAK_REPEAT 一致：1/10/30/60 分钟后每 120 分钟一次。
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
    private val cancelled = ConcurrentHashMap<String, Boolean>()

    @Volatile
    private var running = false
    private var quietStartMin = 23 * 60 + 30
    private var quietEndMin = 7 * 60
    @Volatile
    private var sound = "system"

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
        cancelled.clear()
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
        // 冷启动登录时 socket 还没建立，光 close 不会触发连接，必须主动连
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
                // missed 是 Nudge，没有事项正文；合成一条汇总，不按条数连轰
                val missed = msg.optJSONArray("missed") ?: JSONArray()
                if (missed.length() > 0) postMissed(missed.length())
            }
            "pursuit.nudge" -> {
                val pursuit = msg.optJSONObject("pursuit") ?: return
                val id = pursuit.optString("id")
                val text = pursuit.optString("text")
                if (id.isEmpty() || text.isEmpty()) return
                val level = msg.optInt("level", 2)
                if (level != 2 && level != 4) return
                val reason = msg.optString("reason")
                cancelled[id] = false
                post(id, text, reason, level)
                // 强提醒的接管窗由 WebView 承载，原生层只发常驻通知，不做本地重复
                if (level == 2) scheduleRepeat(id, text, reason, level)
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

    private fun post(pursuitId: String, text: String, reason: String, level: Int, attempt: Int = 1) {
        val nid = notifyId(pursuitId)
        main.post {
            val body = if (attempt > 1) "$reason · 第 $attempt 次" else reason
            val channel = if (level == 4) CH_STRONG else CH_WEAK
            val n = NotificationCompat.Builder(this, channel)
                .setSmallIcon(R.drawable.ic_stat_notify)
                .setContentTitle(text)
                .setContentText(body)
                .setContentIntent(openIntent())
                .setAutoCancel(level != 4)
                .setOngoing(level == 4)
                .build()
            try { nm.notify(nid, n) } catch (_: Exception) {}
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

    /** 与前端 inQuietHours 一致：静音时段暂停重复，跨零点同样处理 */
    private fun inQuiet(): Boolean {
        if (quietStartMin == quietEndMin) return false
        val cal = java.util.Calendar.getInstance()
        val m = cal.get(java.util.Calendar.HOUR_OF_DAY) * 60 + cal.get(java.util.Calendar.MINUTE)
        return if (quietStartMin < quietEndMin) m >= quietStartMin && m < quietEndMin
        else m >= quietStartMin || m < quietEndMin
    }

    /** 秒；弱提醒 1/10/30/60 分钟后每 120 分钟一次 */
    private fun ladderFor(level: Int): LongArray = when (level) {
        2 -> longArrayOf(60, 600, 1800, 3600, 7200)
        else -> longArrayOf()
    }

    private fun scheduleRepeat(pursuitId: String, text: String, reason: String, level: Int) {
        repeatTasks[pursuitId]?.cancel(false)
        val ladder = ladderFor(level)
        if (ladder.isEmpty()) return

        fun step(index: Int) {
            if (cancelled[pursuitId] == true || !running) return
            val delay = ladder[minOf(index, ladder.size - 1)]
            val future = executor.schedule({
                if (cancelled[pursuitId] == true || !running) return@schedule
                // 静音只顺延，不消耗次数；结束后接着原来的节奏
                if (inQuiet()) {
                    step(index)
                    return@schedule
                }
                val attempt = index + 1
                main.post { post(pursuitId, text, reason, level, attempt) }
                step(index + 1)
            }, delay, TimeUnit.SECONDS)
            repeatTasks[pursuitId] = future
        }
        step(0)
    }

    private fun cancel(pursuitId: String) {
        if (pursuitId.isEmpty()) return
        cancelled[pursuitId] = true
        repeatTasks.remove(pursuitId)?.cancel(false)
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
            c.description = "轻提醒，静音不打断"
            c.setSound(null, null)
            c.enableVibration(false)
            nm.createNotificationChannel(c)
        }
    }

    /** 渠道声音建好后仍可改；静音设置变更时同步，避免 L2 也响铃震动 */
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
        val n = NotificationCompat.Builder(this, CH_RUNNING)
            .setSmallIcon(R.drawable.ic_stat_notify)
            .setContentTitle("DeskAlarm 正在后台运行")
            .setContentText("保持提醒连接，锁屏也能收到，点此返回应用")
            .setContentIntent(openIntent())
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
        return n
    }

    companion object {
        const val PREFS = "deskalarm_push"
        const val KEY_BASE = "baseUrl"
        const val KEY_TOKEN = "token"
        private const val CH_RUNNING = "deskalarm_keepalive"
        private const val CH_STRONG = "deskalarm_strong"
        private const val CH_WEAK = "deskalarm_weak"
        private const val NOTIFICATION_ID = 1001
        private const val MISSED_NOTIFICATION_ID = 1002
        @Volatile
        var INSTANCE: DeskAlarmKeepAliveService? = null
    }
}
