#!/usr/bin/env node
/**
 * MCP stdio 入口。
 *
 * 独立进程，走 HTTP 访问 API。好处是鉴权边界不破，
 * 任何 MCP 客户端（Claude Desktop、Cursor、各种 agent）都能直接配。
 *
 * 客户端配置示例：
 * {
 *   "mcpServers": {
 *     "deskalarm": {
 *       "command": "node",
 *       "args": ["/path/to/server/dist/server/src/mcp/stdio.js"],
 *       "env": {
 *         "DESKALARM_API": "http://127.0.0.1:8091",
 *         "DESKALARM_TOKEN": "在客户端「服务端与本机设备」里签发的 Agent 令牌"
 *       }
 *     }
 *   }
 * }
 *
 * 协议就是 JSON-RPC 2.0 over stdio，一行一个 JSON。
 * 这里手写而不引 SDK，是为了不把整个 MCP 依赖树拖进生产镜像
 */
import { createInterface } from 'node:readline';

// 端口是宿主对外端口：容器内 8787，docker 只发布 8091
const API = process.env.DESKALARM_API ?? 'http://127.0.0.1:8091';
const TOKEN = process.env.DESKALARM_TOKEN ?? '';
const PROTOCOL = '2025-06-18';

if (!TOKEN) {
  process.stderr.write('[deskalarm-mcp] 缺 DESKALARM_TOKEN（Agent 令牌），MCP 调用会被 401\n');
}

interface Rpc {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

const out = (o: unknown) => process.stdout.write(`${JSON.stringify(o)}\n`);

const ok = (id: unknown, result: unknown) => out({ jsonrpc: '2.0', id, result });
const fail = (id: unknown, code: number, message: string) =>
  out({ jsonrpc: '2.0', id, error: { code, message } });

async function api(path: string, method = 'GET', body?: unknown) {
  const res = await fetch(`${API}/api/mcp${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((json as { message?: string }).message ?? `HTTP ${res.status}`);
  }
  return json;
}

async function handle(rpc: Rpc) {
  const { id, method, params = {} } = rpc;

  switch (method) {
    case 'initialize':
      return ok(id, {
        protocolVersion: PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: 'deskalarm', version: '1.2.0' },
        instructions: [
          'DeskAlarm 是 agent-first 的推进引擎，主力操作员是 agent。',
          '',
          '用法上的硬规矩：',
          '1. 先调 today_digest 看今日聚焦和剩余强打扰额度，别凭上下文里的印象动手。',
          '2. 写操作一律两步：create_pursuit / decompose / reprioritize / followup / archive / clone_pursuit',
          '   或 plan_changes 只生成预览和 plan_id；给用户看过并确认后，再调 apply_changes 执行。',
          '   plan_id 只能用一次且十分钟过期。',
          '3. 建推进项默认 importance=1(P2)、进进行中，不抢注意力。',
          '   importance=3(P0) 或会很快升级到强打扰时，必须给 reason 说明依据。',
          '4. followup 的 version 必填：先 get_pursuit 拿最新版本号，避免覆盖用户刚做的改动。',
          '   动作只有 done/later/smaller/archive/reopen；已完成只能归档或撤回，归档后只剩克隆。',
          '5. 只读令牌只能调 today_digest / list_pursuits / get_pursuit。',
          '',
          '用户的习惯：贴进来没定时间的东西是「待办」不是「闹钟」，不要自己给它加时间。',
        ].join('\n'),
      });

    case 'notifications/initialized':
      return; // 通知，不用回

    case 'ping':
      return ok(id, {});

    case 'tools/list':
      return ok(id, { tools: (await api('/tools') as { tools: unknown[] }).tools });

    case 'tools/call': {
      const name = String(params.name ?? '');
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      try {
        const r = await api('/call', 'POST', { name, arguments: args });
        return ok(id, {
          content: [{ type: 'text', text: JSON.stringify(r, null, 2) }],
          isError: false,
        });
      } catch (err) {
        // 工具报错要作为内容返回，让模型自己看，不是当成传输失败
        return ok(id, {
          content: [{ type: 'text', text: `调用失败: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        });
      }
    }

    default:
      return fail(id ?? null, -32601, `未实现的方法 ${method}`);
  }
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const t = line.trim();
  if (!t) return;
  let rpc: Rpc;
  try {
    rpc = JSON.parse(t) as Rpc;
  } catch {
    return fail(null, -32700, 'JSON 解析失败');
  }
  void handle(rpc).catch((err) =>
    fail(rpc.id ?? null, -32603, err instanceof Error ? err.message : String(err)),
  );
});

process.stderr.write(`[deskalarm-mcp] 已连接 ${API}\n`);
