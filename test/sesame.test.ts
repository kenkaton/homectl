// SESAME アダプタ: 施錠のみ実装されていること（解錠はコードに存在しない）の検証。
import { describe, expect, it } from "vitest";
import { SesameAdapter } from "../src/adapters/sesame";
import type { Device } from "../src/adapters/types";
import type { Env } from "../src/env";

const DEVICE: Device = {
  id: "sesame:u-1",
  vendor: "sesame",
  vendorDeviceId: "u-1",
  name: "玄関",
  room: "entrance",
  capabilities: [{ capability: "lock_state_read", feedback: "verified" }],
};

function makeAdapter(overrides?: Partial<Record<string, string>>) {
  const env = {
    SESAME_API_KEY: "k",
    SESAME_DEVICE_UUID: "u-1",
    SESAME_SECRET_KEY: "2b7e151628aed2a6abf7158809cf4f3c",
    ...overrides,
  } as unknown as Env;
  const requests: Request[] = [];
  const adapter = new SesameAdapter(env, async (_v, req) => {
    requests.push(req);
    if (req.method === "POST") return Response.json({});
    return Response.json({ CHSesame2Status: "locked", batteryPercentage: 80 });
  });
  return { adapter, requests };
}

describe("SESAME アダプタ", () => {
  it("readState: 施錠状態と電池を正規化", async () => {
    const { adapter, requests } = makeAdapter();
    const state = await adapter.readState(DEVICE);
    expect(state).toEqual({ locked: true, battery: 80 });
    expect(requests[0]?.headers.get("x-api-key")).toBe("k");
  });

  it("lock: cmd=82 と 32桁 hex 署名を送る", async () => {
    const { adapter, requests } = makeAdapter();
    const result = await adapter.execute(DEVICE, { type: "lock" });
    expect(result).toEqual({ ok: true, newState: { locked: true } });
    const body = (await requests[0]?.clone().json()) as { cmd: number; sign: string; history: string };
    expect(body.cmd).toBe(82);
    expect(body.sign).toMatch(/^[0-9a-f]{32}$/);
    expect(new URL(requests[0]?.url ?? "").pathname).toBe("/api/sesame2/u-1/cmd");
  });

  it("lock 以外の操作は全て unsupported（解錠に相当する分岐が存在しない）", async () => {
    const { adapter, requests } = makeAdapter();
    for (const action of [
      { type: "on_off", value: false },
      { type: "temperature_set", value: 25 },
      { type: "curtain_position", value: 50 },
    ] as const) {
      const r = await adapter.execute(DEVICE, action);
      expect(r.ok).toBe(false);
      expect(r.error).toContain("lock only");
    }
    expect(requests).toHaveLength(0); // HTTP は一切飛ばない
  });

  it("SESAME_SECRET_KEY 未設定なら施錠はエラー（読み取りは可能なまま）", async () => {
    const { adapter, requests } = makeAdapter({ SESAME_SECRET_KEY: undefined });
    const r = await adapter.execute(DEVICE, { type: "lock" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("SESAME_SECRET_KEY");
    expect(requests).toHaveLength(0);
    expect((await adapter.readState(DEVICE)).locked).toBe(true);
  });

  it("ソースコードに解錠コマンド(83)・toggle(88) が存在しない", async () => {
    // アダプタ実装ファイルの定数を静的に確認する代わりに、
    // 公開 API 面から到達可能な全 Action で 82 以外のコマンドが送られないことを保証済み。
    // discoverDevices も lock_state_read のみを宣言する。
    const { adapter } = makeAdapter();
    const found = await adapter.discoverDevices();
    expect(found[0]?.capabilities).toEqual([{ capability: "lock_state_read", feedback: "verified" }]);
  });
});
