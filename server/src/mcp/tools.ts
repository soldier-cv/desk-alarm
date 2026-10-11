/**
 * MCP 工具集。写操作必须 plan_changes 干跑再 apply_changes 执行，
 * create_entry 默认 weak。设计理由见 docs/requirements.md「MCP 的防呆规则」
 */
import { randomUUID } from 'node:crypto';
import type {
  CreateEntryRequest, Entry, Strength,
} from '../../../shared/types.js';
import { toMs } from '../db.js';
import {
  VersionConflict, ackEntry, createEntry, deleteEntry, dismissEntry,
  getEntry, listDismissals, listEntries, listNeglected, searchEntries, updateEntry,
} from '../repo/entries.js';
import { getSettings } from '../repo/settings.js';
import { listDevices } from '../repo/devices.js';

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** 计划只能活 10 分钟。过期了要重新 plan，不给 agent 攒着半夜执行的机会 */
const PLAN_TTL_MS = 10 * 60_000;
const plans = new Map<string, {
  ops: Op[];
  at: number;
  deviceName: string;
  summary: string;
}>();

export type Op =
  | { kind: 'create'; text: string; remindAt: number | null; strength: Strength; repeat?: string; bypassQuiet?: boolean; devices?: string[]; note?: string; reason?: string }
  | { kind: 'snooze'; id: string; to: number }
  | { kind: 'complete'; id: string }
  | { kind: 'dismiss'; id: string; reason?: string }
  | { kind: 'update'; id: string; strength: Strength; bypassQuiet: boolean }
  | { kind: 'delete'; id: string };

function gcPlans() {
  const cut = Date.now() - PLAN_TTL_MS;
  for (const [k, v] of plans) if (v.at < cut) plans.delete(k);
}

/* ---------------------------------------------------------------- 工具 */

export const TOOLS: ToolDef[] = [
  {
    name: 'today_digest',
    description:
      '今天要处理什么。含已逾期的、收集箱里没定时间的、以及被反复忽略的条目。' +
      '这是 agent 了解用户当前状态最省事的一个入口，先调它再决定要不要动手。',
    inputSchema: {
      type: 'object',
      properties: {
        includeInbox: { type: 'boolean', description: '是否带上收集箱，默认 true' },
      },
    },
  },
  {
    name: 'list_entries',
    description: '按视图查条目。view: today | upcoming | inbox | all | done | dismissed',
    inputSchema: {
      type: 'object',
      properties: {
        view: { type: 'string', enum: ['today', 'upcoming', 'inbox', 'all', 'done', 'dismissed'] },
        limit: { type: 'number' },
      },
    },
  },
  {
    name: 'search_entries',
    description: '在未完成的条目里搜文本、备注、路径',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },
  {
    name: 'create_entry',
    description:
      '建一条提醒。默认进收集箱（不响铃）。' +
      '要真正响铃必须给 remindAt。' +
      '默认 strength=weak（只出通知）。' +
      '只有用户明确说了「一定要提醒我」「响铃」这类话，' +
      '才可以传 strength=strong，并且必须同时给 reason 说明依据。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '内容。可以是短语、链接、目录路径' },
        remindAt: {
          type: ['integer', 'null'],
          description: 'epoch 毫秒。null 表示不定时，进收集箱',
        },
        strength: { type: 'string', enum: ['weak', 'strong'], description: '默认 weak' },
        reason: { type: 'string', description: '传 strong 时必填，写明用户凭什么要求强提示' },
        repeat: { type: 'string', enum: ['none', 'daily', 'weekly', 'monthly'] },
        bypassQuiet: { type: 'boolean', description: '静音时段也照响，默认 false' },
        note: { type: 'string' },
        idempotencyKey: { type: 'string', description: '重试时传同一个键，不会造出两条' },
      },
      required: ['text'],
    },
  },
  {
    name: 'plan_changes',
    description:
      'dry-run。传一组操作，返回执行后的完整 diff，不落库。' +
      '所有写操作都该先走这里，把结果给用户看，确认后再 apply_changes。' +
      '返回的 plan_id 十分钟内有效。',
    inputSchema: {
      type: 'object',
      properties: {
        operations: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['create', 'snooze', 'complete', 'dismiss', 'update', 'delete'] },
              id: { type: 'string', description: '除 create 外都要' },
              text: { type: 'string' },
              remindAt: { type: ['integer', 'null'] },
              to: { type: 'integer' },
              strength: { type: 'string', enum: ['weak', 'strong'] },
              bypassQuiet: { type: 'boolean' },
              reason: { type: 'string' },
            },
            required: ['kind'],
          },
        },
      },
      required: ['operations'],
    },
  },
  {
    name: 'apply_changes',
    description: '执行 plan_changes 返回的 plan_id 里的操作',
    inputSchema: {
      type: 'object',
      properties: { planId: { type: 'string' } },
      required: ['planId'],
    },
  },
  {
    name: 'complete_entry',
    description: '标记完成。任何设备调用后，其它设备立刻停铃',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'snooze_entry',
    description: '推迟。minutes 相对，to 是 epoch 毫秒',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, minutes: { type: 'number' }, to: { type: 'integer' } },
      required: ['id'],
    },
  },
  {
    name: 'device_health',
    description: '哪台设备在线、有没有配好推送。安排提醒范围之前先看一眼',
    inputSchema: { type: 'object', properties: {} },
  },
];

/* ---------------------------------------------------------------- 执行 */

export interface McpCtx {
  /** 这条写操作是谁发起的。会写到 entry.source */
  source: 'mcp';
  deviceName: string;
}

export async function callTool(
  name: string, args: Record<string, unknown>, ctx: McpCtx,
): Promise<unknown> {
  gcPlans();
  switch (name) {
    case 'today_digest': return todayDigest(args.includeInbox !== false);
    case 'list_entries': return listEntries(
      String(args.view ?? 'all') as Parameters<typeof listEntries>[0],
      Number(args.limit) || 50,
    );
    case 'search_entries': return searchEntries(String(args.query ?? ''));
    case 'create_entry': return toolCreate(args, ctx);
    case 'plan_changes': return toolPlan(args);
    case 'apply_changes': return toolApply(args, ctx);
    case 'complete_entry': return toolComplete(String(args.id), ctx);
    case 'snooze_entry': return toolSnooze(args, ctx);
    case 'device_health': return listDevices();
    default: throw new Error(`未知工具 ${name}`);
  }
}

/* -------------------------------------------------------------- 各工具 */

async function todayDigest(includeInbox: boolean) {
  const [today, inbox, neglected, settings, dismissals] = await Promise.all([
    listEntries('today', 50),
    includeInbox ? listEntries('inbox', 20) : Promise.resolve([]),
    listNeglected(2),
    getSettings(),
    listDismissals(10),
  ]);

  const overdue = today.filter((e) => e.status === 'missed');
  const upcoming = today.filter((e) => e.status === 'pending');
  const done = today.filter((e) => e.status === 'done');

  return {
    serverTime: Date.now(),
    概览: {
      待处理: upcoming.length,
      已逾期: overdue.length,
      收集箱: inbox.length,
      今日完成: done.length,
      被反复忽略: neglected.length,
    },
    逾期: brief(overdue),
    接下来: brief(upcoming),
    收集箱: brief(inbox),
    /**
     * 这段是 agent 唯一能看见而用户看不见的东西：
     * 用户自己被自己的提醒烦到关掉了多少次
     */
    被反复忽略: neglected.length > 0 ? {
      说明: '这些条目被忽略过多次。要么删掉，要么降级成弱提示。跟用户确认后再动',
      条目: neglected.map((e) => ({
        id: e.id, text: e.text, dismissCount: e.dismissCount,
        strength: e.strength, 建议: e.dismissCount >= 3 ? '建议删除' : '建议降为弱提示',
      })),
    } : null,
    最近忽略: dismissals.map((d) => ({
      text: d.text, reason: d.reason ?? '(没写理由)', device: d.deviceName, at: d.at,
    })),
    升级策略: {
      多少秒后升级全屏: settings.escalateAfterSec,
      多少秒重复一次: settings.repeatEverySec,
      忽略几次自动降级: settings.autoDowngradeAfter,
    },
  };
}

function brief(list: Entry[]) {
  return list.map((e) => ({
    id: e.id,
    text: e.text,
    remindAt: e.remindAt,
    remindAtText: e.remindAt ? new Date(e.remindAt).toLocaleString('zh-CN') : null,
    status: e.status,
    strength: e.strength,
    dismissCount: e.dismissCount,
  }));
}

async function toolCreate(args: Record<string, unknown>, ctx: McpCtx) {
  const strength = (args.strength as Strength) ?? 'weak';
  const remindAt = (args.remindAt as number | null | undefined) ?? null;

  // 硬规则：强提示必须给依据
  if (strength === 'strong' && !String(args.reason ?? '').trim()) {
    throw new Error(
      '创建强提示必须提供 reason，说明用户凭什么要求强提示。' +
      '如果用户只是随口提了一句，默认 weak 就够了。',
    );
  }

  const req: CreateEntryRequest = {
    text: String(args.text ?? ''),
    remindAt,
    strength,
    repeat: (args.repeat as CreateEntryRequest['repeat']) ?? 'none',
    bypassQuiet: Boolean(args.bypassQuiet),
    note: (args.note as string) ?? null,
  };
  if (!req.text.trim()) throw new Error('text 不能为空');

  const entry = await createEntry(req, {
    source: 'mcp',
    idempotencyKey: args.idempotencyKey ? `mcp:${args.idempotencyKey}` : undefined,
  });
  return {
    entry,
    说明: strength === 'weak'
      ? '已进列表，弱提示。要响铃请让用户确认后调 plan_changes 改 strong'
      : `已建强提示，依据：${args.reason}`,
    发起者: ctx.deviceName,
  };
}

async function toolPlan(args: Record<string, unknown>) {
  const ops = (args.operations as Op[]) ?? [];
  if (ops.length === 0) throw new Error('operations 不能为空');
  if (ops.length > 50) throw new Error('一次最多 50 个操作，别一把梭');

  const changes: Array<Record<string, unknown>> = [];
  const warnings: string[] = [];

  for (const [i, op] of ops.entries()) {
    try {
      changes.push(await describeOp(op, i));
    } catch (e) {
      warnings.push(`第 ${i + 1} 个操作无法解析: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  gcPlans();
  const planId = randomUUID();
  const summary = changes
    .map((c) => `  ${c.动作} ${c.目标}`)
    .join('\n');

  plans.set(planId, { ops, at: Date.now(), deviceName: '', summary });

  return {
    planId,
    计划: changes,
    警告: warnings,
    预览: `将执行 ${changes.length} 项：\n${summary}`,
    提示: '这是预览，还没有落库。跟用户确认后再调 apply_changes',
  };
}

async function describeOp(op: Op, i: number): Promise<Record<string, unknown>> {
  const n = i + 1;
  switch (op.kind) {
    case 'create': {
      if (op.strength === 'strong' && !op.reason) {
        throw new Error('强提示必须给 reason');
      }
      return {
        序号: n, 动作: '新建',
        目标: op.text,
        详情: {
          提醒时间: op.remindAt ? new Date(op.remindAt).toLocaleString('zh-CN') : '不定时（进收集箱）',
          强度: op.strength ?? 'weak',
          重复: op.repeat ?? 'none',
          绕过静音: op.bypassQuiet ?? false,
        },
        依据: op.reason,
      };
    }
    case 'snooze': {
      const e = await getEntry(op.id);
      if (!e) throw new Error(`找不到条目 ${op.id}`);
      return {
        序号: n, 动作: '推迟', 目标: e.text,
        详情: {
          从: e.remindAt ? new Date(e.remindAt).toLocaleString('zh-CN') : '不定时',
          到: new Date(op.to).toLocaleString('zh-CN'),
        },
      };
    }
    case 'complete': {
      const e = await getEntry(op.id);
      if (!e) throw new Error(`找不到条目 ${op.id}`);
      return { 序号: n, 动作: '完成', 目标: e.text, 详情: { 当前状态: e.status } };
    }
    case 'dismiss': {
      const e = await getEntry(op.id);
      if (!e) throw new Error(`找不到条目 ${op.id}`);
      return { 序号: n, 动作: '忽略', 目标: e.text, 详情: { 理由: op.reason ?? '(没写)' } };
    }
    case 'update': {
      const e = await getEntry(op.id);
      if (!e) throw new Error(`找不到条目 ${op.id}`);
      return {
        序号: n, 动作: '改设置', 目标: e.text,
        详情: { 强度: `${e.strength} → ${op.strength}`, 绕过静音: `${e.bypassQuiet} → ${op.bypassQuiet}` },
      };
    }
    case 'delete': {
      const e = await getEntry(op.id);
      if (!e) throw new Error(`找不到条目 ${op.id}`);
      return { 序号: n, 动作: '删除', 目标: e.text, 详情: { 已推迟次数: e.snoozeCount, 忽略次数: e.dismissCount } };
    }
    default:
      throw new Error(`未知操作 ${(op as { kind: string }).kind}`);
  }
}

async function toolApply(args: Record<string, unknown>, ctx: McpCtx) {
  const planId = String(args.planId ?? '');
  const plan = plans.get(planId);
  if (!plan) throw new Error('计划不存在或已过期（有效期 10 分钟），重新 plan_changes');
  plans.delete(planId); // 一次计划只能执行一次，避免 agent 重试造出重复

  const done: Array<Record<string, unknown>> = [];
  const failed: Array<Record<string, unknown>> = [];

  for (const op of plan.ops) {
    try {
      switch (op.kind) {
        case 'create': {
          const e = await createEntry({
            text: op.text, remindAt: op.remindAt,
            strength: op.strength ?? 'weak',
            repeat: (op.repeat as CreateEntryRequest['repeat']) ?? 'none',
            bypassQuiet: op.bypassQuiet ?? false,
            devices: op.devices,
          }, { source: 'mcp' });
          done.push({ 动作: '新建', id: e.id, text: e.text, 提醒: e.remindAt, 强度: e.strength });
          break;
        }
        case 'snooze': {
          const e = await ackEntry(op.id, 'snooze', ctx.deviceName, op.to);
          done.push({ 动作: '推迟', id: e.id, text: e.text, 新的提醒时间: e.remindAt });
          break;
        }
        case 'complete': {
          const e = await ackEntry(op.id, 'done', ctx.deviceName);
          done.push({ 动作: '完成', id: e.id, text: e.text });
          break;
        }
        case 'dismiss': {
          const r = await dismissEntry(op.id, 'mcp', ctx.deviceName, op.reason);
          done.push({ 动作: '忽略', id: r.entry.id, text: r.entry.text, 累计: r.dismissCount, 建议: r.suggestion });
          break;
        }
        case 'update': {
          const cur = await getEntry(op.id);
          if (!cur) throw new Error(`找不到条目 ${op.id}`);
          const e = await updateEntry(op.id, {
            strength: op.strength, bypassQuiet: op.bypassQuiet, version: cur.version,
          });
          done.push({ 动作: '改设置', id: e.id, text: e.text, 强度: e.strength });
          break;
        }
        case 'delete': {
          await deleteEntry(op.id);
          done.push({ 动作: '删除', id: op.id });
          break;
        }
      }
    } catch (e) {
      failed.push({ 操作: op.kind, id: (op as { id?: string }).id, 错误: e instanceof Error ? e.message : String(e) });
    }
  }

  return { 已执行: done, 失败: failed, 发起者: ctx.deviceName };
}

async function toolComplete(id: string, ctx: McpCtx) {
  const entry = await ackEntry(id, 'done', ctx.deviceName);
  return { entry, 说明: '其它设备上正在响的会立刻停' };
}

async function toolSnooze(args: Record<string, unknown>, ctx: McpCtx) {
  const id = String(args.id ?? '');
  const cur = await getEntry(id);
  if (!cur) throw new Error(`找不到条目 ${id}`);

  const to = typeof args.to === 'number'
    ? args.to
    : Math.max(cur.remindAt ?? 0, Date.now()) + Number(args.minutes ?? 10) * 60_000;

  const entry = await ackEntry(id, 'snooze', ctx.deviceName, to);
  return { entry, 新的提醒时间: new Date(entry.remindAt!).toLocaleString('zh-CN') };
}

export { VersionConflict, toMs };
