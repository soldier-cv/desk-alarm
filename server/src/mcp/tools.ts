/**
 * MCP 工具集（v2 推进引擎）。写操作一律 two-step：先 stage 拿预览与一次性 plan_id，
 * 再用 apply_changes 执行。域操作都调 drive.ts，薄壳不自己实现逻辑。
 * 设计理由见 docs/drive-engine.md「为什么 agent-first」与 docs/mcp-rules.md
 */
import { randomUUID } from 'node:crypto';
import type {
  AgentScope, CreatePursuitRequest, Energy, FollowupAction, FollowupRequest,
  FocusResult, Importance, Pursuit, PursuitNature, PursuitStatus,
} from '../../../shared/types.js';
import { buildFocus, decompose, followUp, reprioritize } from '../drive.js';
import { createPursuit, getPursuit, listPursuits, setStatus } from '../repo/pursuits.js';
import { hub } from '../hub.js';

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** 计划只活 10 分钟，且只能用一次，不给 agent 攒着半夜执行的机会 */
const PLAN_TTL_MS = 10 * 60_000;
const plans = new Map<string, {
  ops: Op[];
  at: number;
  userId: string;
  deviceName: string;
  summary: string;
}>();

const NATURES: readonly string[] = ['one_off', 'recurring', 'project'];
const ENERGIES: readonly string[] = ['low', 'medium', 'high'];
const STATUSES: readonly string[] = ['inbox', 'active', 'paused', 'done', 'archived'];
const FOLLOWUP_ACTIONS: readonly string[] = ['done', 'partial', 'later', 'smaller', 'archive', 'ignored'];
const READ_TOOLS = new Set(['today_digest', 'list_pursuits', 'get_pursuit']);

export type Op =
  | { kind: 'create'; req: CreatePursuitRequest; reason?: string }
  | { kind: 'decompose'; id: string; texts: string[] }
  | { kind: 'reprioritize'; id: string; importance: Importance }
  | { kind: 'followup'; id: string; req: FollowupRequest }
  | { kind: 'archive'; id: string };

const msg = (e: unknown) => e instanceof Error ? e.message : String(e);

function gcPlans() {
  const cut = Date.now() - PLAN_TTL_MS;
  for (const [k, v] of plans) if (v.at < cut) plans.delete(k);
}

/* ---------------------------------------------------------------- 工具 */

export const TOOLS: ToolDef[] = [
  {
    name: 'today_digest',
    description:
      '今日聚焦：引擎按重要性、逾期、停滞和承诺排出的该推的事，以及今天还剩几次强打扰额度。' +
      'agent 开工先调它，别凭上下文里的印象动手。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_pursuits',
    description: '列出推进项。可按 status 过滤。只读令牌也能用',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['inbox', 'active', 'paused', 'done', 'archived'] },
        limit: { type: 'number', description: '最多返回多少条，默认 100' },
      },
    },
  },
  {
    name: 'get_pursuit',
    description: '查一条推进项的完整状态，含步骤、进度和版本号。改之前先拿它，避免覆盖用户刚改过的状态。只读令牌也能用',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'create_pursuit',
    description:
      '建推进项，steps 可一次给多个步骤。默认 nature=one_off、importance=0、status=inbox，不抢注意力。' +
      'importance>=3 或会很快升级到强打扰时，必须同时给 reason 说明依据。' +
      '本工具只生成预览和 plan_id，不落库；跟用户确认后调 apply_changes 才真正执行。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '这件事是什么' },
        note: { type: 'string' },
        kind: { type: 'string', enum: ['text', 'link', 'path', 'image', 'audio'] },
        url: { type: 'string' },
        path: { type: 'string' },
        nature: { type: 'string', enum: ['one_off', 'recurring', 'project'] },
        importance: { type: 'integer', minimum: 0, maximum: 3, description: '默认 0，3 最高' },
        energy: { type: 'string', enum: ['low', 'medium', 'high'] },
        dueAt: { type: ['integer', 'string', 'null'], description: 'epoch 毫秒或日期字符串' },
        recurrence: { type: 'object' },
        context: { type: 'object' },
        commitment: { type: 'object' },
        status: { type: 'string', enum: ['inbox', 'active', 'paused', 'done', 'archived'] },
        steps: { type: 'array', items: { type: 'string' }, description: '拆好的步骤文本' },
        deviceIds: { type: 'array', items: { type: 'string' } },
        reason: { type: 'string', description: 'importance>=3 或会触发强打扰时必填，写明用户凭什么要求高优先级' },
      },
      required: ['text'],
    },
  },
  {
    name: 'decompose',
    description: '把一件事拆成可立刻动手的步骤。texts 是步骤文本数组。只生成预览，确认后调 apply_changes 执行',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        texts: { type: 'array', items: { type: 'string' } },
      },
      required: ['id', 'texts'],
    },
  },
  {
    name: 'reprioritize',
    description: '改一件事的重要性 0..3。引擎会据此重排聚焦。只生成预览，确认后调 apply_changes 执行',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        importance: { type: 'integer', minimum: 0, maximum: 3 },
      },
      required: ['id', 'importance'],
    },
  },
  {
    name: 'followup',
    description:
      '回答一次跟进：action 用 FollowupAction（done/partial/later/smaller/archive/ignored）。' +
      'version 必填，先 get_pursuit 拿最新版本号，避免覆盖用户刚做的改动。' +
      'later 可给 to，smaller 可带 steps。只生成预览，确认后调 apply_changes 执行',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        action: { type: 'string', enum: ['done', 'partial', 'later', 'smaller', 'archive', 'ignored'] },
        note: { type: 'string' },
        to: { type: ['integer', 'string'] },
        steps: { type: 'array', items: { type: 'string' } },
        version: { type: 'integer', description: '从 get_pursuit 拿到的最新版本号' },
      },
      required: ['id', 'action', 'version'],
    },
  },
  {
    name: 'archive',
    description: '归档一件事（不删除，可恢复）。只生成预览，确认后调 apply_changes 执行',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'plan_changes',
    description:
      'dry-run。传一组写操作，返回执行后的预览，不落库。' +
      '所有写操作都该先走这里或对应的单操作工具，把结果给用户看，确认后再 apply_changes。' +
      '返回的 plan_id 十分钟内有效且只能用一次。',
    inputSchema: {
      type: 'object',
      properties: {
        operations: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['create', 'decompose', 'reprioritize', 'followup', 'archive'] },
              id: { type: 'string', description: '除 create 外都要' },
              text: { type: 'string', description: 'create 用' },
              steps: { type: 'array', items: { type: 'string' } },
              nature: { type: 'string' },
              importance: { type: 'integer' },
              energy: { type: 'string' },
              dueAt: { type: ['integer', 'string', 'null'] },
              reason: { type: 'string' },
              action: { type: 'string' },
              note: { type: 'string' },
              to: { type: ['integer', 'string'] },
              version: { type: 'integer' },
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
    description: '执行 plan_changes 或写工具返回的 plan_id 里的操作。plan_id 只能用一次且十分钟过期',
    inputSchema: {
      type: 'object',
      properties: { planId: { type: 'string' } },
      required: ['planId'],
    },
  },
];

/* ---------------------------------------------------------------- 执行 */

export interface McpCtx {
  source: 'mcp';
  deviceName: string;
  /** MCP session 绑定的用户。所有读写都按这个用户隔离 */
  userId: string;
  /** 令牌范围。HTTP 入口没传时由路由层把关，这里再做一道防御 */
  scope?: AgentScope;
}

export async function callTool(
  name: string, args: Record<string, unknown>, ctx: McpCtx,
): Promise<unknown> {
  gcPlans();
  if (ctx.scope === 'read' && !READ_TOOLS.has(name)) {
    throw new Error(`只读 Agent 令牌不能调用 ${name}，写操作需要 write 令牌`);
  }
  switch (name) {
    case 'today_digest': return todayDigest(ctx.userId);
    case 'list_pursuits': return toolList(args, ctx);
    case 'get_pursuit': return toolGet(args, ctx);
    case 'create_pursuit': return toolCreate(args, ctx);
    case 'decompose': return toolDecompose(args, ctx);
    case 'reprioritize': return toolReprioritize(args, ctx);
    case 'followup': return toolFollowup(args, ctx);
    case 'archive': return toolArchive(args, ctx);
    case 'plan_changes': return toolPlan(args, ctx);
    case 'apply_changes': return toolApply(args, ctx);
    default: throw new Error(`未知工具 ${name}`);
  }
}

/* ------------------------------------------------------------ 只读工具 */

async function todayDigest(userId: string) {
  const focus: FocusResult = await buildFocus(userId);
  return {
    serverTs: focus.serverTs,
    剩余强打扰额度: focus.budgetLeft,
    聚焦数: focus.items.length,
    聚焦: focus.items.map((it) => ({
      id: it.pursuit.id,
      text: it.pursuit.text,
      nature: it.pursuit.nature,
      importance: it.pursuit.importance,
      status: it.pursuit.status,
      progress: it.pursuit.progress,
      理由: it.reason,
      下一步建议: it.suggestedNextStep,
    })),
    提示: '这是引擎建议，不要自己给它加时间或改优先级；要动先跟用户确认',
  };
}

async function toolList(args: Record<string, unknown>, ctx: McpCtx) {
  const status = args.status != null ? String(args.status) as PursuitStatus : undefined;
  const all = await listPursuits(ctx.userId, status ? { status } : undefined);
  const limit = args.limit ? Number(args.limit) : 100;
  return { pursuits: all.slice(0, limit), 总数: all.length };
}

async function toolGet(args: Record<string, unknown>, ctx: McpCtx) {
  const id = String(args.id ?? '');
  const p = await getPursuit(id, ctx.userId);
  if (!p) throw new Error(`找不到推进项 ${id}`);
  return { pursuit: p };
}

/* ------------------------------------------------------------ 写工具 */

async function toolCreate(args: Record<string, unknown>, ctx: McpCtx) {
  const req = buildCreateRequest(args);
  const reason = typeof args.reason === 'string' ? args.reason.trim() : '';
  const op: Op = { kind: 'create', req, reason: reason || undefined };
  const staged = await stageOps([op], ctx);
  return {
    ...staged,
    防呆说明: needsReason(req)
      ? 'importance>=3 或会很快升级到强打扰，必须给 reason 说明依据；已记录，确认后再执行'
      : '默认 importance=0、进收集箱，不抢注意力；确认后再执行',
  };
}

async function toolDecompose(args: Record<string, unknown>, ctx: McpCtx) {
  const op: Op = {
    kind: 'decompose',
    id: String(args.id ?? ''),
    texts: Array.isArray(args.texts)
      ? args.texts.filter((t) => typeof t === 'string' && t.trim()).map((t) => String(t).trim())
      : [],
  };
  return stageOps([op], ctx);
}

async function toolReprioritize(args: Record<string, unknown>, ctx: McpCtx) {
  const op: Op = {
    kind: 'reprioritize',
    id: String(args.id ?? ''),
    importance: Number(args.importance) as Importance,
  };
  return stageOps([op], ctx);
}

async function toolFollowup(args: Record<string, unknown>, ctx: McpCtx) {
  const req: FollowupRequest = {
    action: String(args.action ?? '') as FollowupAction,
    version: Number(args.version),
  };
  if (args.note !== undefined) req.note = String(args.note);
  if (args.to !== undefined) req.to = args.to as number | string;
  if (Array.isArray(args.steps)) req.steps = args.steps.map((s) => String(s));
  const op: Op = { kind: 'followup', id: String(args.id ?? ''), req };
  return stageOps([op], ctx);
}

async function toolArchive(args: Record<string, unknown>, ctx: McpCtx) {
  const op: Op = { kind: 'archive', id: String(args.id ?? '') };
  return stageOps([op], ctx);
}

/* ---------------------------------------------------------- 两步防呆 */

async function toolPlan(args: Record<string, unknown>, ctx: McpCtx) {
  const raw = (args.operations ?? []) as Array<Record<string, unknown>>;
  const ops: Op[] = raw.map(opFromRaw);
  return stageOps(ops, ctx);
}

function opFromRaw(o: Record<string, unknown>): Op {
  const kind = String(o.kind ?? '');
  switch (kind) {
    case 'create':
      return {
        kind,
        req: buildCreateRequest(o),
        reason: typeof o.reason === 'string' ? o.reason.trim() : undefined,
      };
    case 'decompose':
      return {
        kind,
        id: String(o.id ?? ''),
        texts: Array.isArray(o.texts) ? o.texts.map((t) => String(t)) : [],
      };
    case 'reprioritize':
      return { kind, id: String(o.id ?? ''), importance: Number(o.importance) as Importance };
    case 'followup': {
      const req: FollowupRequest = {
        action: String(o.action ?? '') as FollowupAction,
        version: Number(o.version),
      };
      if (o.note !== undefined) req.note = String(o.note);
      if (o.to !== undefined) req.to = o.to as number | string;
      if (Array.isArray(o.steps)) req.steps = o.steps.map((s) => String(s));
      return { kind, id: String(o.id ?? ''), req };
    }
    case 'archive':
      return { kind, id: String(o.id ?? '') };
    default:
      throw new Error(`未知操作 ${kind}`);
  }
}

async function stageOps(ops: Op[], ctx: McpCtx) {
  if (!ops.length) throw new Error('operations 不能为空');
  if (ops.length > 50) throw new Error('一次最多 50 个操作，别一把梭');
  for (const op of ops) validateOp(op);

  const changes: Array<Record<string, unknown>> = [];
  const warnings: string[] = [];
  for (const [i, op] of ops.entries()) {
    try {
      changes.push(await describeOp(op, i, ctx.userId));
    } catch (e) {
      warnings.push(`第 ${i + 1} 个操作无法解析: ${msg(e)}`);
    }
  }

  gcPlans();
  const planId = randomUUID();
  const summary = changes.map((c) => `  ${c.动作} ${c.目标}`).join('\n');
  plans.set(planId, {
    ops, at: Date.now(), userId: ctx.userId, deviceName: ctx.deviceName, summary,
  });

  return {
    planId,
    计划: changes,
    警告: warnings,
    预览: `将执行 ${changes.length} 项：\n${summary}`,
    提示: '这是预览，还没有落库。跟用户确认后再调 apply_changes（plan_id 只能用一次，10 分钟内有效）',
  };
}

function validateOp(op: Op): void {
  switch (op.kind) {
    case 'create':
      if (needsReason(op.req) && !(op.reason ?? '').trim()) {
        throw new Error('这个推进项重要性>=3 或会很快升级到强打扰，必须给 reason 说明依据');
      }
      break;
    case 'decompose':
      if (!op.id) throw new Error('decompose 必须给 id');
      if (!op.texts.length) throw new Error('decompose 的 texts 不能为空');
      break;
    case 'reprioritize':
      if (!op.id) throw new Error('reprioritize 必须给 id');
      if (![0, 1, 2, 3].includes(op.importance)) throw new Error('importance 必须是 0..3');
      break;
    case 'followup':
      if (!op.id) throw new Error('followup 必须给 id');
      if (!FOLLOWUP_ACTIONS.includes(op.req.action)) throw new Error(`未知的 followup action ${op.req.action}`);
      if (!Number.isInteger(op.req.version)) throw new Error('followup 必须给 version，先 get_pursuit 拿最新版本号');
      break;
    case 'archive':
      if (!op.id) throw new Error('archive 必须给 id');
      break;
  }
}

async function describeOp(op: Op, i: number, userId: string): Promise<Record<string, unknown>> {
  const n = i + 1;
  switch (op.kind) {
    case 'create':
      return {
        序号: n, 动作: '新建推进项', 目标: op.req.text,
        详情: {
          性质: op.req.nature ?? 'one_off',
          重要性: op.req.importance ?? 0,
          精力: op.req.energy ?? 'medium',
          状态: op.req.status ?? 'inbox',
          步骤: op.req.steps ?? [],
          截止: op.req.dueAt ?? null,
          重复: op.req.recurrence ?? null,
          备注: op.req.note ?? null,
        },
        依据: op.reason ?? null,
      };
    case 'decompose': {
      const p = await mustGet(op.id, userId);
      return {
        序号: n, 动作: '拆解', 目标: p.text,
        详情: { 现有步骤: p.steps.map((s) => s.text), 新增步骤: op.texts },
      };
    }
    case 'reprioritize': {
      const p = await mustGet(op.id, userId);
      return {
        序号: n, 动作: '改优先级', 目标: p.text,
        详情: { 重要性: `${p.importance} → ${op.importance}` },
      };
    }
    case 'followup': {
      const p = await mustGet(op.id, userId);
      return {
        序号: n, 动作: '跟进', 目标: p.text,
        详情: { 动作: op.req.action, 备注: op.req.note ?? null, 改期: op.req.to ?? null, 新步骤: op.req.steps ?? [] },
      };
    }
    case 'archive': {
      const p = await mustGet(op.id, userId);
      return {
        序号: n, 动作: '归档', 目标: p.text,
        详情: { 当前状态: p.status, 改为: 'archived' },
      };
    }
  }
}

async function toolApply(args: Record<string, unknown>, ctx: McpCtx) {
  const planId = String(args.planId ?? '');
  const plan = plans.get(planId);
  if (!plan) throw new Error('计划不存在或已过期（有效期 10 分钟），重新 plan_changes');
  if (plan.userId !== ctx.userId) throw new Error('这个计划属于其它用户，不能执行');
  plans.delete(planId); // 一次计划只能执行一次，避免 agent 重试造出重复

  const done: Array<Record<string, unknown>> = [];
  const failed: Array<Record<string, unknown>> = [];
  for (const op of plan.ops) {
    try {
      done.push(await runOp(op, ctx.userId));
    } catch (e) {
      failed.push({ 操作: op.kind, id: (op as { id?: string }).id, 错误: msg(e) });
    }
  }
  return { 已执行: done, 失败: failed, 发起者: ctx.deviceName };
}

async function runOp(op: Op, userId: string): Promise<Record<string, unknown>> {
  switch (op.kind) {
    case 'create': {
      const p = await createPursuit(userId, op.req);
      hub.broadcastToUser(userId, { t: 'pursuit.created', pursuit: p });
      return { 动作: '新建推进项', id: p.id, text: p.text, 重要性: p.importance };
    }
    case 'decompose': {
      const p = await decompose(op.id, userId, op.texts);
      hub.broadcastToUser(userId, { t: 'pursuit.stepped', pursuit: p });
      return { 动作: '拆解', id: p.id, text: p.text, 步骤数: p.steps.length };
    }
    case 'reprioritize': {
      const p = await reprioritize(op.id, userId, op.importance);
      hub.broadcastToUser(userId, { t: 'pursuit.updated', pursuit: p });
      return { 动作: '改优先级', id: p.id, text: p.text, 重要性: p.importance };
    }
    case 'followup': {
      const p = await followUp(op.id, userId, op.req);
      hub.broadcastToUser(userId, { t: 'pursuit.followed', pursuit: p, action: op.req.action });
      return { 动作: '跟进', id: p.id, text: p.text, action: op.req.action };
    }
    case 'archive': {
      const p = await setStatus(op.id, userId, 'archived');
      if (!p) throw new Error(`找不到推进项 ${op.id}`);
      hub.broadcastToUser(userId, { t: 'pursuit.updated', pursuit: p });
      return { 动作: '归档', id: p.id, text: p.text };
    }
  }
}

/* ---------------------------------------------------------------- 辅助 */

async function mustGet(id: string, userId: string): Promise<Pursuit> {
  const p = await getPursuit(id, userId);
  if (!p) throw new Error(`找不到推进项 ${id}`);
  return p;
}

function asMs(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(n) ? n : null;
}

function needsReason(req: CreatePursuitRequest): boolean {
  if ((req.importance ?? 0) >= 3) return true;
  // 对外承诺、或高精力且临近截止，都会很快爬到 L4/L5 强打扰
  if (req.commitment?.date != null) {
    const d = asMs(req.commitment.date);
    if (d !== null && d - Date.now() <= 24 * 3600_000) return true;
  }
  const due = asMs(req.dueAt);
  if (req.energy === 'high' && due !== null && due - Date.now() <= 24 * 3600_000) return true;
  return false;
}

function buildCreateRequest(args: Record<string, unknown>): CreatePursuitRequest {
  const text = String(args.text ?? '').trim();
  if (!text) throw new Error('text 不能为空');
  const req: CreatePursuitRequest = { text };

  if (args.kind !== undefined) {
    const v = String(args.kind);
    if (!['text', 'link', 'path', 'image', 'audio'].includes(v)) throw new Error(`未知 kind ${v}`);
    req.kind = v as CreatePursuitRequest['kind'];
  }
  if (args.note !== undefined) req.note = String(args.note);
  if (args.url !== undefined) req.url = String(args.url);
  if (args.path !== undefined) req.path = String(args.path);

  if (args.nature !== undefined) {
    const v = String(args.nature);
    if (!NATURES.includes(v)) throw new Error(`未知 nature ${v}`);
    req.nature = v as PursuitNature;
  }
  if (args.importance !== undefined) {
    const n = Number(args.importance);
    if (!Number.isInteger(n) || n < 0 || n > 3) throw new Error('importance 必须是 0..3 的整数');
    req.importance = n as Importance;
  }
  if (args.energy !== undefined) {
    const v = String(args.energy);
    if (!ENERGIES.includes(v)) throw new Error(`未知 energy ${v}`);
    req.energy = v as Energy;
  }
  if (args.dueAt !== undefined) req.dueAt = args.dueAt as CreatePursuitRequest['dueAt'];
  if (args.recurrence !== undefined) req.recurrence = args.recurrence as CreatePursuitRequest['recurrence'];
  if (args.context !== undefined) req.context = args.context as CreatePursuitRequest['context'];
  if (args.commitment !== undefined) req.commitment = args.commitment as CreatePursuitRequest['commitment'];

  if (args.status !== undefined) {
    const v = String(args.status);
    if (!STATUSES.includes(v)) throw new Error(`未知 status ${v}`);
    req.status = v as PursuitStatus;
  }
  if (Array.isArray(args.steps)) {
    req.steps = args.steps.filter((s) => typeof s === 'string' && s.trim()).map((s) => String(s).trim());
  }
  if (Array.isArray(args.deviceIds)) req.deviceIds = args.deviceIds.map((d) => String(d));
  return req;
}
