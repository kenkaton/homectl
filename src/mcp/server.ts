// MCP サーバー（streamable HTTP・SDK 非依存の最小 JSON-RPC 実装。§10）。
// - 全ツールは SiteDO への RPC（get_power_history のみ Analytics SQL API）
// - set_state は安全層経由。応答に必ず安全層の判定結果を含める
// - 解錠に相当するツール・引数は定義しない（§14。Action 型にも存在しない）
import { z } from "zod";
import type { Action } from "../adapters/types";
import type { Env } from "../env";
import { queryHistory } from "../analytics";

const PROTOCOL_VERSION = "2025-03-26";
const SERVER_INFO = { name: "homectl", version: "0.1.0" };
const INSTRUCTIONS = `自宅の機器統合基盤 homectl。
- 機器の操作(set_state)は必ず安全層を通り、blocked:<理由> で拒否されることがある。結果の result / verification をユーザーに説明すること。
- feedback が assumed の機器（赤外線）は「送っただけ」で実行は保証されない。verification が pending なら約5分後に根拠機器で自動検証される。
- 錠は施錠(lock)のみ。解錠機能は存在しない。
- 「なぜ勝手に動いた/止まった?」には explain_recent_actions の reason（発動根拠）で答える。`;

// ---- ツール定義（inputSchema は JSON Schema、検証は zod で行う） ----

const setStateActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("on_off"), value: z.boolean() }),
  z.object({ type: z.literal("temperature_set"), value: z.number() }),
  z.object({ type: z.literal("curtain_position"), value: z.number().min(0).max(100) }),
  z.object({ type: z.literal("lock") }), // 施錠のみ。unlock は型にも存在しない
]);

const argSchemas = {
  list_devices: z.object({}).strict(),
  get_state: z.object({ deviceId: z.string().optional() }).strict(),
  get_power_history: z
    .object({
      hours: z.number().min(1).max(168).optional(),
      deviceId: z.string().optional(),
    })
    .strict(),
  set_state: z
    .object({
      deviceId: z.string(),
      action: setStateActionSchema,
      reason: z.string().optional(),
    })
    .strict(),
  explain_recent_actions: z.object({ limit: z.number().min(1).max(200).optional() }).strict(),
  get_rate_budget: z.object({}).strict(),
  set_kill_switch: z.object({ on: z.boolean() }).strict(),
  update_device: z
    .object({
      deviceId: z.string(),
      name: z.string().optional(),
      room: z.string().optional(),
      capabilityOverride: z
        .object({
          capability: z.string(),
          feedback: z.enum(["verified", "assumed", "inferred"]),
          via: z.string().optional(),
        })
        .optional(),
    })
    .strict(),
} as const;

type ToolName = keyof typeof argSchemas;

const TOOLS: Array<{ name: ToolName; description: string; inputSchema: Record<string, unknown> }> = [
  {
    name: "list_devices",
    description: "機器一覧（能力・フィードバック信頼度込み）",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_state",
    description: "指定機器（または全機器）の最新状態と取得時刻・取得元（poll/webhook/command）",
    inputSchema: {
      type: "object",
      properties: { deviceId: { type: "string", description: "機器の id か表示名。省略で全機器" } },
      additionalProperties: false,
    },
  },
  {
    name: "get_power_history",
    description: "期間指定の消費電力集計（Analytics Engine）。機器別の平均W・概算kWh とバケット時系列を返す",
    inputSchema: {
      type: "object",
      properties: {
        hours: { type: "number", minimum: 1, maximum: 168, description: "遡る時間。既定 24" },
        deviceId: { type: "string", description: "機器 id で絞り込み（省略で全機器）" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "set_state",
    description:
      "機器を操作する（安全層経由）。result が blocked:<理由> なら安全層による拒否。" +
      "assumed 機器は verification=pending となり約5分後に自動検証される。施錠(lock)はあるが解錠は存在しない",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: { type: "string", description: "機器の id か表示名" },
        action: {
          type: "object",
          description:
            '{"type":"on_off","value":true|false} | {"type":"temperature_set","value":20..30} | ' +
            '{"type":"curtain_position","value":0..100} | {"type":"lock"}',
          properties: {
            type: { type: "string", enum: ["on_off", "temperature_set", "curtain_position", "lock"] },
            value: { type: ["boolean", "number"] },
          },
          required: ["type"],
        },
        reason: { type: "string", description: "操作ログに残す理由（ユーザーの依頼内容など）" },
      },
      required: ["deviceId", "action"],
      additionalProperties: false,
    },
  },
  {
    name: "explain_recent_actions",
    description: "直近の操作ログを人間可読で返す（いつ・誰(どのルール)が・何を・なぜ・結果・検証結果）",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", minimum: 1, maximum: 200, description: "既定 20" } },
      additionalProperties: false,
    },
  },
  {
    name: "get_rate_budget",
    description: "ベンダー別の本日の API 残枠（JST 日付でリセット）",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "set_kill_switch",
    description: "キルスイッチ。on で全ての機器操作（ルール含む）を拒否する。操作ログと通知にも残る",
    inputSchema: {
      type: "object",
      properties: { on: { type: "boolean" } },
      required: ["on"],
      additionalProperties: false,
    },
  },
  {
    name: "update_device",
    description:
      "機器の整理: 表示名・部屋の変更、能力の feedback/via の上書き。" +
      "例: 赤外線エアコンの on_off を feedback=inferred, via=<プラグid> にすると操作後の自動検証が効くようになる",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: { type: "string" },
        name: { type: "string" },
        room: { type: "string" },
        capabilityOverride: {
          type: "object",
          properties: {
            capability: { type: "string" },
            feedback: { type: "string", enum: ["verified", "assumed", "inferred"] },
            via: { type: "string", description: "inferred のとき必須: 根拠となる power_read 機器の id" },
          },
          required: ["capability", "feedback"],
        },
      },
      required: ["deviceId"],
      additionalProperties: false,
    },
  },
];

// ---- JSON-RPC 処理 ----

interface RpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: unknown;
}

function rpcResult(id: RpcMessage["id"], result: unknown) {
  return { jsonrpc: "2.0" as const, id: id ?? null, result };
}
function rpcError(id: RpcMessage["id"], code: number, message: string) {
  return { jsonrpc: "2.0" as const, id: id ?? null, error: { code, message } };
}

export async function handleMcp(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST") {
    // SSE ストリームは提供しない（全ツールが短命の要求応答で完結する）
    return Response.json(rpcError(null, -32000, "Method Not Allowed: POST only"), { status: 405 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json(rpcError(null, -32700, "Parse error"), { status: 400 });
  }
  const messages: RpcMessage[] = Array.isArray(body) ? (body as RpcMessage[]) : [body as RpcMessage];
  const responses: unknown[] = [];
  for (const msg of messages) {
    const res = await handleMessage(msg, env);
    if (res !== null) responses.push(res);
  }
  if (responses.length === 0) return new Response(null, { status: 202 }); // notification のみ
  return Response.json(Array.isArray(body) ? responses : responses[0]);
}

async function handleMessage(msg: RpcMessage, env: Env): Promise<unknown | null> {
  if (msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return rpcError(msg.id, -32600, "Invalid Request");
  }
  if (msg.method.startsWith("notifications/")) return null;
  switch (msg.method) {
    case "initialize": {
      const requested =
        typeof msg.params === "object" && msg.params !== null
          ? (msg.params as { protocolVersion?: string }).protocolVersion
          : undefined;
      return rpcResult(msg.id, {
        protocolVersion: requested === "2024-11-05" ? requested : PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return rpcResult(msg.id, {});
    case "tools/list":
      return rpcResult(msg.id, { tools: TOOLS });
    case "tools/call": {
      const params = z
        .object({ name: z.string(), arguments: z.record(z.unknown()).optional() })
        .safeParse(msg.params);
      if (!params.success) return rpcError(msg.id, -32602, "Invalid params");
      return rpcResult(msg.id, await callTool(env, params.data.name, params.data.arguments ?? {}));
    }
    default:
      return rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

// ---- ツール実装 ----

function toolText(value: unknown, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], isError };
}

async function callTool(env: Env, name: string, rawArgs: Record<string, unknown>) {
  const schema = (argSchemas as Record<string, z.ZodTypeAny>)[name];
  if (!schema) return toolText({ error: `unknown tool: ${name}` }, true);
  const parsed = schema.safeParse(rawArgs);
  if (!parsed.success) {
    return toolText({ error: "invalid arguments", issues: parsed.error.issues }, true);
  }
  const site = env.SITE.get(env.SITE.idFromName("main"));
  try {
    switch (name as ToolName) {
      case "list_devices":
        return toolText(await site.listDevicesRpc());
      case "get_state": {
        const args = parsed.data as z.infer<(typeof argSchemas)["get_state"]>;
        return toolText(await site.getStateRpc(args.deviceId));
      }
      case "get_power_history": {
        const args = parsed.data as z.infer<(typeof argSchemas)["get_power_history"]>;
        const history = await queryHistory(env, { hours: args.hours ?? 24, deviceId: args.deviceId });
        if (!history.configured) {
          return toolText({
            configured: false,
            note: "Analytics Engine の SQL API が未設定（CF_ACCOUNT_ID / CF_ANALYTICS_TOKEN を設定すると履歴照会が有効になる）。現在値は get_state で取れる",
          });
        }
        return toolText({ ...history, summary: summarizePower(history.rows, history.intervalMinutes) });
      }
      case "set_state": {
        const args = parsed.data as z.infer<(typeof argSchemas)["set_state"]>;
        const outcome = await site.setStateRpc(args.deviceId, args.action as Action, "mcp", args.reason);
        return toolText(
          {
            ...outcome,
            safetyVerdict: outcome.result.startsWith("blocked:")
              ? `安全層が拒否: ${outcome.result.slice("blocked:".length)}`
              : outcome.result === "ok"
                ? "安全層の全チェックを通過して実行済み"
                : `実行エラー: ${outcome.result}`,
          },
          !outcome.ok,
        );
      }
      case "explain_recent_actions": {
        const args = parsed.data as z.infer<(typeof argSchemas)["explain_recent_actions"]>;
        const ops = await site.recentOperationsRpc(args.limit ?? 20);
        const lines = ops.map(
          (o) =>
            `#${o.id} [${o.at}] ${o.actor} → ${o.deviceName ?? o.deviceId ?? "(site)"}: ${o.action}` +
            ` | 結果: ${o.result}${o.verification ? ` | 検証: ${o.verification}` : ""} | 理由: ${o.reason}`,
        );
        return toolText({ lines, raw: ops });
      }
      case "get_rate_budget":
        return toolText(await site.getRateBudgetRpc());
      case "set_kill_switch": {
        const args = parsed.data as z.infer<(typeof argSchemas)["set_kill_switch"]>;
        return toolText(await site.setKillSwitchRpc(args.on, "mcp"));
      }
      case "update_device": {
        const args = parsed.data as z.infer<(typeof argSchemas)["update_device"]>;
        const result = await site.updateDeviceRpc(args.deviceId, {
          name: args.name,
          room: args.room,
          capabilityOverride: args.capabilityOverride,
        });
        return toolText(result, !result.ok);
      }
    }
  } catch (e) {
    return toolText({ error: e instanceof Error ? e.message : String(e) }, true);
  }
  return toolText({ error: `unhandled tool: ${name}` }, true);
}

function summarizePower(
  rows: Array<{ device_id: string; powerW: number }>,
  intervalMinutes: number,
): Array<{ deviceId: string; avgW: number; approxKWh: number; buckets: number }> {
  const byDevice = new Map<string, { sum: number; n: number }>();
  for (const r of rows) {
    const cur = byDevice.get(r.device_id) ?? { sum: 0, n: 0 };
    cur.sum += r.powerW;
    cur.n += 1;
    byDevice.set(r.device_id, cur);
  }
  return [...byDevice.entries()].map(([deviceId, { sum, n }]) => ({
    deviceId,
    avgW: Math.round(sum / n),
    approxKWh: Math.round(((sum * intervalMinutes) / 60 / 1000) * 100) / 100,
    buckets: n,
  }));
}
