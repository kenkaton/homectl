// MCP サーバーのテスト（§10）: initialize / tools 一覧 / set_state の安全層判定 /
// 解錠が存在しないこと / explain_recent_actions。
import { abortAllDurableObjects, env, reset } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { handleMcp } from "../src/mcp/server";

beforeEach(async () => {
  await reset();
  await abortAllDurableObjects();
});

let nextId = 1;
async function rpc(method: string, params?: unknown): Promise<Record<string, unknown>> {
  const res = await handleMcp(
    new Request("https://homectl.test/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
    }),
    env,
  );
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

async function callTool(name: string, args: Record<string, unknown> = {}) {
  const res = (await rpc("tools/call", { name, arguments: args })) as {
    result: { content: Array<{ text: string }>; isError: boolean };
  };
  return { parsed: JSON.parse(res.result.content[0]?.text ?? "null") as unknown, isError: res.result.isError };
}

describe("MCP サーバー", () => {
  it("initialize → serverInfo と tools capability を返す", async () => {
    const res = (await rpc("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "claude", version: "1" },
    })) as { result: { serverInfo: { name: string }; capabilities: { tools: object } } };
    expect(res.result.serverInfo.name).toBe("homectl");
    expect(res.result.capabilities.tools).toBeDefined();
  });

  it("tools/list: §10 のツールが揃い、解錠に相当するものは存在しない", async () => {
    const res = (await rpc("tools/list")) as { result: { tools: Array<{ name: string }> } };
    const names = res.result.tools.map((t) => t.name);
    for (const required of [
      "list_devices",
      "get_state",
      "get_power_history",
      "set_state",
      "explain_recent_actions",
      "get_rate_budget",
      "set_kill_switch",
    ]) {
      expect(names).toContain(required);
    }
    // 解錠は tool 名にも schema にも現れない
    const json = JSON.stringify(res.result.tools);
    expect(json).not.toMatch(/unlock/i);
    expect(json).toContain('"lock"'); // 施錠は action enum に存在する
  });

  it("set_state: キルスイッチ ON なら blocked が safetyVerdict つきで返る", async () => {
    await callTool("set_kill_switch", { on: true });
    // 機器を用意（fake vendor なのでアダプタ不在だが、キルスイッチが先に効く）
    const stub = env.SITE.get(env.SITE.idFromName("main"));
    const { runInDurableObject } = await import("cloudflare:test");
    await runInDurableObject(stub, (_i, state) => {
      state.storage.sql.exec(
        "INSERT INTO devices (id, vendor, vendor_device_id, name, room, capabilities) VALUES ('plug','fake','p','プラグ','bedroom', ?)",
        JSON.stringify([{ capability: "on_off", feedback: "verified" }]),
      );
    });

    const blocked = await callTool("set_state", {
      deviceId: "plug",
      action: { type: "on_off", value: true },
      reason: "テスト",
    });
    expect(blocked.isError).toBe(true);
    expect(blocked.parsed).toMatchObject({
      result: "blocked:kill_switch",
      safetyVerdict: "安全層が拒否: kill_switch",
    });

    // explain_recent_actions で説明できる（D10）
    const explain = await callTool("explain_recent_actions", { limit: 5 });
    const lines = (explain.parsed as { lines: string[] }).lines;
    expect(lines.some((l) => l.includes("blocked:kill_switch") && l.includes("mcp"))).toBe(true);
  });

  it("set_state: unlock は引数スキーマで拒否される", async () => {
    const res = await callTool("set_state", { deviceId: "x", action: { type: "unlock" } });
    expect(res.isError).toBe(true);
    expect(res.parsed).toMatchObject({ error: "invalid arguments" });
  });

  it("get_power_history: SQL API 未設定なら configured:false で degrade", async () => {
    const res = await callTool("get_power_history", { hours: 24 });
    expect(res.isError).toBe(false);
    expect(res.parsed).toMatchObject({ configured: false });
  });

  it("未知メソッドは -32601", async () => {
    const res = (await rpc("resources/list")) as { error: { code: number } };
    expect(res.error.code).toBe(-32601);
  });

  it("notifications/initialized は 202", async () => {
    const res = await handleMcp(
      new Request("https://homectl.test/mcp", {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      }),
      env,
    );
    expect(res.status).toBe(202);
  });

  it("GET は 405（SSE ストリームは提供しない）", async () => {
    const res = await handleMcp(new Request("https://homectl.test/mcp", { method: "GET" }), env);
    expect(res.status).toBe(405);
  });
});
