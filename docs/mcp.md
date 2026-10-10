# MCP 接入

agent 怎么安排提醒。走 stdio，任何 MCP 客户端都能接。

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
        "DESKALARM_API": "http://127.0.0.1:8787",
        "DESKALARM_TOKEN": "你的 MCP_TOKEN"
      }
    }
  }
}
```

`MCP_TOKEN` 配在服务端 `.env`。**建议给 agent 单独发一个**，出问题能单独吊销，不影响你自己的登录会话。

HTTP 入口也能直接用（调试和脚本方便）：

```bash
curl http://127.0.0.1:8091/api/mcp/tools -H "Authorization: Bearer $MCP_TOKEN"
curl -X POST http://127.0.0.1:8091/api/mcp/call \
  -H "Authorization: Bearer $MCP_TOKEN" -H 'content-type: application/json' \
  -d '{"name":"today_digest","arguments":{}}'
```

## 工具

| 工具 | 干什么 |
|---|---|
| `today_digest` | 今天要处理什么。**先调这个**，含已逾期、收集箱、以及被反复忽略的条目 |
| `list_entries` | 按视图查。`today` / `upcoming` / `inbox` / `all` / `done` / `dismissed` |
| `search_entries` | 搜文本、备注、路径 |
| `create_entry` | 建条目。**默认弱提示** |
| `plan_changes` | dry-run，返回完整 diff，不落库 |
| `apply_changes` | 执行 plan 返回的 plan_id |
| `complete_entry` | 标记完成 |
| `snooze_entry` | 推迟 |
| `device_health` | 哪台在线、有没有配好推送 |

## 三条防呆规则

这套设计不是「给 agent 一套 CRUD」，核心是**让破坏性操作需要意图明确**。

### 1. 写操作先 plan 再 apply

```
plan_changes(operations)  →  返回 plan_id 和预览，用户确认
apply_changes(plan_id)     →  真执行
```

plan_id 只能用一次，十分钟过期。这样 agent 不可能在你不知情的情况下批量改 20 条的时间。

### 2. 强提示必须有依据

```json
{ "name": "create_entry", "arguments": {
    "text": "交周报",
    "remindAt": 1790580000000,
    "strength": "strong"
} }
```

这样会被拒：

> 创建强提示必须提供 reason，说明用户凭什么要求强提示。如果用户只是随口提了一句，默认 weak 就够了。

因为一个能随便建全屏强提示的 agent，早晚会半夜三点为一份草稿邮件把你叫醒。默认 weak + 显式升级，是唯一能守住这条线的组合。

### 3. 每条写入都记来源

agent 建的条目 `source` 是 `mcp`，界面上能认出来。`idempotencyKey` 传同一个值重试不会造出两条。

## 初始化时写进 instructions 的规矩

stdio 服务端在 `initialize` 响应里带了三条 instructions：

1. 先调 `today_digest` 了解状态再动手
2. 所有写操作先 `plan_changes` 拿预览，确认后 `apply_changes`
3. `create_entry` 默认弱提示，只有用户明确要求响铃才传 `strength: strong` 且必须给 `reason`

另外还有一条给 agent 的语义约定：**用户贴进来没定时间的东西是「待办」不是「闹钟」**。agent 不该自己给它加时间。

## today_digest 里最有用的一段

```json
"被反复忽略": {
  "说明": "这些条目被忽略过多次。要么删掉，要么降级成弱提示。跟用户确认后再动",
  "条目": [
    { "text": "每天整理笔记", "dismissCount": 4, "strength": "weak", "建议": "建议删除" }
  ]
}
```

这是 agent 唯一能看见、而用户自己看不见的东西。用户在客户端点了多少次「忽略」，带着什么原因，都在 `dismissals` 表里。

## 想让它更听话就写技能

MCP 给的是能力面，判断还得靠技能。几个该写进技能里的规则：

- 「别老忘这个链接」= 进收集箱不响铃，不是「15 分钟后提醒我」
- 「今天要干的都往后推半小时」= 先列后批量挪，**已逾期的那几条要单独问**
- 用户用过去式提到已完成的事，别重新打开
- 不要因为用户在闲聊里提了一句就建提醒

完整清单和踩过的坑见 `docs/mcp-rules.md`。
