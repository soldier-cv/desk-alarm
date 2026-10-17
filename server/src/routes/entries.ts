import type { FastifyInstance } from 'fastify';
import type {
  CreateEntryRequest, DismissRequest, SnoozeRequest, UpdateEntryRequest,
} from '../../../shared/types.js';
import { requireAuth } from '../auth.js';
import { hub } from '../hub.js';
import { log } from '../log.js';
import {
  VersionConflict, ackEntry, createEntry, deleteEntry, dismissEntry, getEntry,
  listDismissals, listEntries, listNeglected, searchEntries, updateEntry,
} from '../repo/entries.js';
import { findMissed, markAcked } from '../repo/deliveries.js';
import { getSettings, patchSettings } from '../repo/settings.js';
import { getDevice, listDevices } from '../repo/devices.js';

export async function entryRoutes(app: FastifyInstance) {
  // 整个插件加一层鉴权。独立 register 出来的，钩子不会泄漏到别的路由组
  app.addHook('preHandler', requireAuth);

  /* ------------------------------------------------------------ 查询 */

  app.get('/entries', async (req) => {
    const q = req.query as { view?: string; limit?: string; q?: string };
    if (q.q) return { entries: await searchEntries(q.q) };

    if (q.view === 'dismissed') {
      return { dismissals: await listDismissals(q.limit ? Number(q.limit) : undefined), entries: [] };
    }
    const views = ['today', 'upcoming', 'inbox', 'all', 'done'] as const;
    const view = views.includes(q.view as never) ? (q.view as (typeof views)[number]) : 'all';
    return { entries: await listEntries(view, q.limit ? Number(q.limit) : undefined) };
  });

  app.get('/entries/:id', async (req, reply) => {
    const e = await getEntry((req.params as { id: string }).id);
    if (!e) return reply.code(404).send({ error: 'NOT_FOUND', message: '条目不存在' });
    return { entry: e };
  });

  /**
   * 被反复忽略的条目。
   * 强弱提示这套设计真正的收益点：系统在告诉你一件关于你自己行为、
   * 而你本来看不见的事
   */
  app.get('/neglected', async () => ({ entries: await listNeglected(2) }));

  /* ------------------------------------------------------------ 写入 */

  app.post('/entries', async (req, reply) => {
    const body = (req.body ?? {}) as CreateEntryRequest & { idempotencyKey?: string };

    // 校验放在这里而不是 repo 层。repo 被 MCP 复用，
    // 报错格式不一致会让 agent 拿到看不懂的东西
    if (typeof body.text !== 'string' || !body.text.trim()) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'text 必填，而且不能是空字符串' });
    }
    if (body.text.length > 4000) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'text 太长了，控制在 4000 字以内' });
    }
    if (body.strength && body.strength !== 'weak' && body.strength !== 'strong') {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'strength 只能是 weak 或 strong' });
    }

    const entry = await createEntry(body, {
      source: body.idempotencyKey?.startsWith('mcp:') ? 'mcp' : 'app',
      idempotencyKey: body.idempotencyKey,
    });
    hub.broadcast({ t: 'entry.created', entry });
    log.info('entry created', {
      id: entry.id, kind: entry.kind, strength: entry.strength,
      remindAt: entry.remindAt, source: entry.source,
    });
    return reply.code(201).send({ entry });
  });

  app.patch('/entries/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    try {
      const entry = await updateEntry(id, req.body as UpdateEntryRequest);
      hub.broadcast({ t: 'entry.updated', entry });
      return { entry };
    } catch (err) {
      if (err instanceof VersionConflict) {
        return reply.code(409).send({
          error: 'VERSION_CONFLICT', message: err.message, current: err.current,
        });
      }
      if (err instanceof Error && err.message === 'NOT_FOUND') {
        return reply.code(404).send({ error: 'NOT_FOUND', message: '条目不存在' });
      }
      // 真出错别伪装成 404，否则客户端只会一直重试一条永远写不进去的条目
      log.error('entry update failed', err);
      return reply.code(500).send({ error: 'INTERNAL', message: '保存失败，请重试' });
    }
  });

  app.delete('/entries/:id', async (req) => {
    const id = (req.params as { id: string }).id;
    await deleteEntry(id);
    hub.broadcast({ t: 'entry.deleted', entryId: id });
    return { ok: true };
  });

  /* ------------------------------------------------------------ 确认 */

  /**
   * 完成。任意设备调用后，其它设备收到 entry.acked 立刻停铃。
   * 这一步是跨端去重的关键，不要在客户端本地做
   */
  app.post('/entries/:id/done', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const device = req.session!.device;
    try {
      const entry = await ackEntry(id, 'done', device.name);
      await markAcked(id, device.id, 'done');
      hub.broadcast({ t: 'entry.updated', entry });
      hub.broadcast({
        t: 'entry.acked', entryId: id,
        deviceId: device.id, deviceName: device.name, action: 'done',
      });
      log.info('entry done', { id, by: device.name });
      return { entry };
    } catch {
      return reply.code(404).send({ error: 'NOT_FOUND', message: '条目不存在' });
    }
  });

  /** 推迟。给 minutes（相对）或 to（绝对），重排进调度队列 */
  app.post('/entries/:id/snooze', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const device = req.session!.device;
    const body = (req.body ?? {}) as SnoozeRequest;

    let target: number | null = null;
    if (typeof body.to === 'number' || typeof body.to === 'string') {
      const t = typeof body.to === 'number' ? body.to : Date.parse(body.to);
      if (!Number.isNaN(t)) target = t;
    } else if (typeof body.minutes === 'number') {
      // 「推迟 30 分钟」是相对现在，不是相对那个已经过去的时间。
      // 拿过去的时间加 30 分钟会算出一个还在过去的时刻，等于没推
      const cur = await getEntry(id);
      const base = Math.max(cur?.remindAt ?? 0, Date.now());
      target = base + body.minutes * 60_000;
    }
    if (target === null) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'minutes 或 to 必填一个' });
    }

    try {
      const entry = await ackEntry(id, 'snooze', device.name, target);
      await markAcked(id, device.id, 'snooze');
      hub.broadcast({ t: 'entry.updated', entry });
      hub.broadcast({
        t: 'entry.acked', entryId: id,
        deviceId: device.id, deviceName: device.name, action: 'snooze',
      });
      log.info('entry snoozed', { id, to: new Date(target).toISOString() });
      return { entry };
    } catch {
      return reply.code(404).send({ error: 'NOT_FOUND', message: '条目不存在' });
    }
  });

  /**
   * 弱提示的「忽略」。和 done 语义完全不同：
   *   done      = 我做完了
   *   dismissed = 我看到了，故意不处理
   *
   * 忽略不关掉条目，也不改它的时间。它只是留下一条带理由的记录，
   * 让「被忽略 N 次」这个判断有据可查
   */
  app.post('/entries/:id/dismiss', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const device = req.session!.device;
    const body = (req.body ?? {}) as DismissRequest;
    try {
      const r = await dismissEntry(id, device.id, device.name, body.reason);
      await markAcked(id, device.id, 'dismiss');
      hub.broadcast({ t: 'entry.updated', entry: r.entry });
      // 别的设备上正在显示的横幅要跟着收
      hub.broadcast({
        t: 'entry.acked', entryId: id,
        deviceId: device.id, deviceName: device.name, action: 'dismiss',
      });
      // 触发自动降级时告诉所有客户端
      if (r.suggestion && r.entry.strength === 'weak') {
        hub.broadcast({
          t: 'entry.downgraded', entry: r.entry,
          dismissCount: r.dismissCount, reason: r.suggestion,
        });
      }
      log.info('entry dismissed', {
        id, by: device.name, count: r.dismissCount, reason: body.reason ?? '(没写)',
      });
      return { ...r };
    } catch {
      return reply.code(404).send({ error: 'NOT_FOUND', message: '条目不存在' });
    }
  });

  /** 重新武装一条被忽略的条目 */
  app.post('/entries/:id/rearm', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const cur = await getEntry(id);
    if (!cur) return reply.code(404).send({ error: 'NOT_FOUND', message: '条目不存在' });
    const next = cur.remindAt && cur.remindAt > Date.now() ? cur.remindAt : Date.now() + 60_000;
    const entry = await updateEntry(id, { remindAt: next, version: cur.version });
    hub.broadcast({ t: 'entry.updated', entry });
    return { entry };
  });

  /* ------------------------------------------------------------ 其它 */

  app.get('/missed', async (req) => ({ missed: await findMissed(req.session!.device.id) }));

  app.get('/settings', async () => ({ settings: await getSettings() }));

  app.patch('/settings', async (req) => {
    const settings = await patchSettings(req.body as Record<string, never>);
    hub.broadcast({ t: 'settings.changed', settings });
    return { settings };
  });
}
