# v2 设计：agent-first 推进引擎

> 状态：**历史设计记录**。本文的 L1–L5 停滞阶梯已被 `docs/reminder-model.md` 的「强弱二值 + 截止时间单一时钟」取代。`pursuits/steps/followups/nudges` 三表模型仍然沿用。

## 为什么重构

v1 把"提醒"当成产品本身：记一条 → 到点响 → 点完成/忽略。它管"响没响"，不管"事往前走了没有"，
与"自我驱动、推进事项"的目标错配。v2 把核心抽象从「提醒条目 Entry」换成「推进项 Pursuit」——
一个有生命周期的对象：收集 → 明确 → 拆解 → 排期 → 跟进 → 完成/归档。系统不只问"到没到点"，
更问"这件事到哪了、下一步推什么"。用户写进句子的时间仍然算数：到点发一次 L2 通知（不占强打扰额度），
之后交给停滞阶梯继续跟。

四条被推翻的旧规则：

1. 关键词判强弱 + 默认全弱 → 显式 `importance` + **打扰预算** + 权重排序。
   措辞判的是语气不是代价，且会被 Goodhart 化。配额制从根上避免"全都喊等于全听不见"。
2. 忽略 2 次降级、3 次建议删除 → **跟进曲线**：忽略是信号不是惩罚，触发"改天/拆小/归档"的低摩擦动作。
3. 强/弱二分、永不升级 → **连续打扰等级 L1..L5** + 停滞驱动的动态阶梯。
4. 到点响一次 → **到点通知 + 停滞阶梯**：显式时间到点响一次，之后按用户动作持续跟进，不按次数放弃。

## 为什么 agent-first

这个系统的主力操作员是 agent，不是人盯着界面。所以领域操作（拆解、聚焦、跟催、改优先级、归档）
全部集中在服务端引擎 `drive.ts`，Agent API / MCP / 用户 HTTP 只是薄壳。人通过客户端看和确认，
agent 通过 MCP 全权推进。两条路走同一套逻辑，不存在"界面能做 agent 做不了"的分叉。

## 核心算法（唯一真相，各模块照此实现）

### 派生量

```
stalenessMs = now - lastActivityAt
progress    = doneSteps / totalSteps （无步骤时 0）
weight =
    importance * 20
  + 逾期/紧急加成: dueAt 在 24h 内 +40，72h 内 +20，已逾期 +60
  + 停滞加成: min(floor(stallDays) * 8, 40)
  + 承诺加成: commitment.date 存在 +25
  + 进行中项目加成: 0 < progress < 1 时 +15
```

### 跟进阶梯（停滞时长 → 等级）

```
staleness < l2(2h)        → L1 静默（只进聚焦列表）
l2 .. l3(1d)              → L2 通知
l3 .. l4(3d)              → L3 横幅
l4 .. l5(7d)              → L4 接管
>= l5                     → L5 归档（status=archived，不删除）
```

L4/L5 受 `dailyStrongBudget` 限额：当天强打扰用尽则降到 L2/L3。
静音时段内 L4 降到 L2（`bypassQuiet` 语义由 `energy=high` + 站点上下文体现）。

### 情境闸门

- `context.timeWindow` 未命中 → 本轮跳过，攒到命中再推
- `context.device` 指定的设备不在线 → 推迟
- 权重相同时 `importance_sort` 小的在前

### 重复规则

`nextOccurrence(fromMs, rule)`：`daily`+1d、`weekly`+7d、`monthly`+1 月并钳到月末、
`yearly`+1 年、`workdays` 跳过周末、`interval` 按 `interval` 天。
基数取 `max(dueAt, now)` 避免逾期后连排多次。

### 下一步建议（suggestNextStep）

- 有未完成步骤 → 取第一个 todo/doing 的 text
- project 无步骤 → "把这件事拆成 2-3 个能立刻动手的小步骤"
- one_off 停滞 → "今天花 5 分钟做第一步：<text>"
- 已到 L5 → "要么今天定个时间，要么归档"

## 模块边界与文件所有权（并行实现，严禁越界改别人的文件）

| 模块 | 拥有文件（仅这些可写） | 依赖 |
|---|---|---|
| 地基（主 agent，已完成） | `shared/types.ts`、`server/src/schema.pg.sql`、本文 | — |
| A 引擎核心 | `server/src/repo/pursuits.ts`、`steps.ts`、`followups.ts`、`nudges.ts`、`server/src/policy.ts`、`server/src/drive.ts`、`server/src/scheduler.ts` | 地基 |
| B Agent 接口 | `server/src/routes/agent-api.ts`、`server/src/mcp/tools.ts`、`server/src/mcp/stdio.ts` | A 的导出签名 |
| C 用户接口与集成 | `server/src/routes/pursuits.ts`、`stream.ts`、`index.ts`、`admin.ts`、`server/src/repo/settings.ts`、`stats.ts`、`server/src/transport/index.ts` | A 的导出签名 |
| D 客户端 | `app/src/**`（api.ts、alarm.ts、widgets.ts、theme.ts、ui/**、styles*.css） | 地基 |

## 引擎接口签名（A 必须实现，B/C 按此调用）

```ts
// repo/pursuits.ts
export function mapPursuit(row: any, steps: Step[], deviceIds: string[], nowMs: number): Pursuit
export function listPursuits(userId: string, opts?: { status?: PursuitStatus }): Promise<Pursuit[]>
export function getPursuit(id: string, userId: string): Promise<Pursuit | null>
export function createPursuit(userId: string, req: CreatePursuitRequest): Promise<Pursuit>
export function updatePursuit(id: string, userId: string, req: UpdatePursuitRequest): Promise<Pursuit | null>
export function setStatus(id: string, userId: string, status: PursuitStatus): Promise<Pursuit | null>
export function touchActivity(id: string, userId: string): Promise<void>
export function deletePursuit(id: string, userId: string): Promise<boolean>
export function listActiveUserIds(): Promise<string[]>

// repo/steps.ts
export function listSteps(pursuitId: string, userId: string): Promise<Step[]>
export function addStep(pursuitId: string, userId: string, text: string): Promise<Step>
export function updateStep(stepId: string, userId: string, patch: { text?: string; state?: StepState }): Promise<Step | null>
export function deleteStep(stepId: string, userId: string): Promise<boolean>

// repo/followups.ts
export function recordFollowup(pursuitId: string, userId: string, level: NudgeLevel, action: FollowupAction, note: string | null): Promise<Followup>
export function listFollowups(pursuitId: string, userId: string): Promise<Followup[]>

// repo/nudges.ts
export function createNudge(userId: string, pursuitId: string, deviceId: string | null, level: NudgeLevel, channel: NudgeChannel, reason: string, fireKey: string): Promise<Nudge | null>
export function takePending(limit: number): Promise<Nudge[]>
export function markDelivered(id: number): Promise<void>
export function markFailed(id: number, error: string): Promise<void>
export function markAcked(id: number, action: string): Promise<void>
export function countStrongToday(userId: string): Promise<number>
export function listMissed(userId: string, afterMs: number): Promise<Nudge[]>
export function sweepStale(): Promise<number>

// policy.ts
export function stalenessOf(lastActivityAt: number, nowMs: number): number
export function weightOf(p: Pursuit, nowMs: number): number
export function levelFor(stalenessMs: number, s: Settings): NudgeLevel
export function inQuietHours(s: Settings, atMs?: number): boolean
export function suggestNextStep(p: Pursuit): string | null
export function focusReason(p: Pursuit): string
export function nextOccurrence(fromMs: number, rule: RecurrenceRule): number | null

// drive.ts
export function buildFocus(userId: string): Promise<FocusResult>
export function driveTick(): Promise<void>
export function followUp(pursuitId: string, userId: string, req: FollowupRequest): Promise<Pursuit>
export function decompose(pursuitId: string, userId: string, texts: string[]): Promise<Pursuit>
export function reprioritize(pursuitId: string, userId: string, importance: Importance): Promise<Pursuit>
export function pushFocus(userId: string): Promise<FocusResult>

// scheduler.ts
export function startScheduler(): void
export function stopScheduler(): void
export function schedulerStats(): { tickMs: number; ticks: number; lastTickAt: number | null; active: number; stalled: number }
```

B/C 需要的额外导出（C 拥有 settings.ts/stats.ts）：
```ts
// repo/settings.ts (C)
export function getSettings(userId: string): Promise<Settings>
export function saveSettings(userId: string, patch: Partial<Settings>): Promise<Settings>
export function ensureSettings(userId: string): Promise<void>
// repo/stats.ts (C)
export function getMyStats(userId: string): Promise<MyStats>
export function getOverview(): Promise<Overview>
```

## 验证

改完必须全绿：
```
cd server && npm run typecheck
cd app && npx tsc --noEmit && npx vite build
```
