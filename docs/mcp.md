# MCP 接入

agent 怎么推进事项。走 stdio，任何 MCP 客户端都能接；也有等价的 HTTP 入口和独立的 `/api/agent`。

## 装

```bash
cd server && npm run build
```

## 客户端配置

```json
{
  "mcpServers": {
    "deskalarm": {
      "command": "node",
      "args": ["D:\\project\\desk-alarm\\server\\dist\\server\\mcp\\stdio.js"],
      "env": {
        "DESKALARM_API": "http://127.0.0.1:8091",
        "DESKALARM_TOKEN": "在客户端签发并复制的 Agent 令牌"
      }
    }
  }
}
```

Agent 令牌不是登录 token，也不来自服务端 env。打开客户端左侧「Agent 令牌」，填名字、选读写/只读，点签发。machine-id 可选：桌面端可绑定本机，云端 agent 留空即可。令牌绑定签发用户的账号，**明文只显示一次**，服务端只存哈希。登录 token 调 MCP 会被 403。

`initialize` 响应里会带一份 `instructions`，硬规矩以它为准；本文是展开说明。只读令牌只能调 `today_digest` / `list_pursuits` / `get_pursuit`。

HTTP 入口也能直接用（调试和脚本方便）：

```bash
curl http://127.0.0.1:8091/api/mcp/tools -H "Authorization: Bearer $AGENT_TOKEN"
curl -X POST http://127.0.0.1:8091/api/mcp/call \
  -H "Authorization: Bearer $AGENT_TOKEN" -H 'content-type: application/json' \
  -d '{"name":"today_digest","arguments":{}}'
```

## 工具

| 工具 | 干什么 |
|---|---|
| `today_digest` | 今日聚焦、剩余强打扰额度、每项的理由和下一步建议。**先调这个** |
| `list_pursuits` | 按 `status` 过滤推进项；只读可用 |
| `get_pursuit` | 查一条的完整状态，含步骤、进度和 `version`；写之前必须先拿它 |
| `create_pursuit` | 建推进项，`steps` 可一次给多个；默认 `importance=1`(P2)、`status=active` |
| `decompose` | 给推进项补步骤 |
| `reprioritize` | 改重要性：`1=P2`、`2=P1`、`3=P0` |
| `followup` | 回答一次跟进：`done`/`later`/`smaller`/`archive`/`reopen`，`version` 必填 |
| `archive` | 归档；归档后没有任何跟进动作，只能克隆 |
| `clone_pursuit` | 克隆任意状态的事项（含已完成/已归档）；复制内容与步骤文本，步骤重置、截止清空 |
| `plan_changes` | dry-run，返回预览和 `plan_id`，不落库 |
| `apply_changes` | 执行 `plan_id`，只能用一次、十分钟过期 |

`/api/agent` 是另一套等价接口：`/focus`、`/pursuits`、`/pursuits/:id`、`/followup`、`/clone`、`/decompose`、`/pursuits/:id/followup`、`/pursuits/:id/clone`，同样只认 Agent 令牌并按 scope 限制。

## 防呆规则

### 1. 写操作先 plan 再 apply

```
plan_changes(operations)  →  返回 plan_id 和预览，用户确认
apply_changes(plan_id)     →  真执行
```

`operations` 的 `kind` 只能是 `create`/`decompose`/`reprioritize`/`followup`/`archive`/`clone`。`plan_id` 只能用一次，十分钟过期。这样 agent 不可能在你不知情的情况下批量改 20 条的时间。

### 2. P0 必须有依据

```json
{ "name": "create_pursuit", "arguments": {
    "text": "交周报",
    "dueAt": 1790580000000,
    "importance": 3,
    "reason": "用户说明天早上评审必须交"
} }
```

`importance=3`(P0) 或对用户有承诺且临近时，不给 `reason` 会被拒。重要性只有 P0/P1/P2，默认 P2；没有「强/弱提示」这个开关，打扰由引擎按等级和配额决定。

### 3. version 和状态边界

- 所有写操作先 `get_pursuit` 拿最新 `version`，避免覆盖用户刚做的改动。
- `done`/`later`/`smaller`/`archive` 只对 收件箱/进行中/暂停有效。
- 已完成只能 `reopen`（撤回）或 `archive`；已归档不能做任何 `followup`，但随时可以 `clone_pursuit`。
- 克隆不是跟进动作：不改原项状态、不停铃、不占配额。

### 4. 每条写入都记来源

agent 建的事项 `source` 是 `mcp`，界面上能认出来；重复调用同一操作仍能靠 `plan_id` 一次性消费和 `version` 乐观锁防重。

## 写进 instructions 的规矩

`initialize` 里实际带的是：先 `today_digest`；写操作两步确认；默认 P2、P0 必须给 reason；`version` 必填；只读令牌范围限制。另有一条语义约定：**用户贴进来没定时间的东西是「待办」不是「闹钟」**，agent 不该自己给它加时间。

## today_digest 里最有用的一段

```json
{
  "剩余强打扰额度": 2,
  "聚焦数": 3,
  "聚焦": [
    {
      "id": "p_xxx",
      "text": "写季度报告",
      "importance": 3,
      "status": "active",
      "progress": 0.5,
      "理由": "有承诺在身，别失约",
      "下一步建议": "写第二章节"
    }
  ],
  "提示": "这是引擎建议，不要自己给它加时间或改优先级；要动先跟用户确认"
}
```

这是引擎按权重排出来的，不要凭上下文印象自己猜「应该先做什么」。

## 想让它更听话就写技能

MCP 给的是能力面，判断还得靠技能。几条该写进去的规则：

- 「别老忘这个链接」= 进收件箱，不要自己给它加时间
- 批量延期要先列清单再问，已逾期那几条要单独确认
- 用户用过去式提到已完成的事，别重新打开，也别克隆
- 归档是不可逆的收口；拿不准就先克隆一份再动

完整清单见 `docs/mcp-rules.md`。
