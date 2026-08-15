// Phase 1 完了条件のテスト: 温湿度がアラームごとに state_cache に入る。
// 実 DO（workerd + SQLite）でアラーム 1 周を回し、SwitchBot API はグローバル fetch モックで偽装する。
import { abortAllDurableObjects, env, reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jstDay } from "../src/util/time";
import { mockFetch } from "./helpers";

beforeEach(async () => {
  // v0.21 は per-test isolated storage を持たないため、自前でテスト間を隔離する
  await reset();
  await abortAllDurableObjects();
});

afterEach(() => {
  // 各テストで張ったグローバルモックを確実に剥がす
  vi.unstubAllGlobals();
});

function siteStub() {
  return env.SITE.get(env.SITE.idFromName("main"));
}

describe("SiteDO アラーム 1 周（発見 → ポーリング → state_cache）", () => {
  it("温湿度が state_cache に入り、残枠が消費される", async () => {
    const mock = mockFetch({
      "GET https://api.switch-bot.com/v1.1/devices": () => ({
        statusCode: 100,
        message: "success",
        body: {
          deviceList: [
            { deviceId: "ABCD1234", deviceName: "リビング温湿度計", deviceType: "Meter", hubDeviceId: "H1" },
          ],
        },
      }),
      "GET https://api.switch-bot.com/v1.1/devices/ABCD1234/status": () => ({
        statusCode: 100,
        message: "success",
        body: { deviceId: "ABCD1234", deviceType: "Meter", temperature: 27.5, humidity: 61, battery: 90 },
      }),
    });

    const stub = siteStub();
    await stub.listDevicesRpc(); // 初回アクセス: コンストラクタがアラームを予約する
    const ran = await runDurableObjectAlarm(stub);
    expect(ran).toBe(true);

    const states = await stub.getStateRpc();
    expect(states).toHaveLength(1);
    expect(states[0]?.device.id).toBe("switchbot:ABCD1234");
    expect(states[0]?.device.capabilities.map((c) => c.capability).sort()).toEqual([
      "humidity_read",
      "temperature_read",
    ]);
    expect(states[0]?.state).toMatchObject({ temperature: 27.5, humidity: 61 });
    expect(states[0]?.source).toBe("poll");
    expect(mock.calls.get("GET https://api.switch-bot.com/v1.1/devices")).toBe(1);
    expect(mock.calls.get("GET https://api.switch-bot.com/v1.1/devices/ABCD1234/status")).toBe(1);

    // /devices + /status で残枠 2 消費
    const budget = await stub.getRateBudgetRpc();
    expect(budget).toEqual([
      { vendor: "switchbot", day: jstDay(Date.now()), used: 2, dailyLimit: 10_000, remaining: 9_998 },
    ]);

    // アラーム連鎖: 次のアラームが再予約されている
    const next = await runInDurableObject(stub, (_i, state) => state.storage.getAlarm());
    expect(next).not.toBeNull();
  });

  it("残枠 95% 消費済みならポーリングを止める（Webhook とコマンドのみ残す）", async () => {
    mockFetch({}); // HTTP が 1 本でも飛んだら unmocked fetch エラーでテストが落ちる

    const stub = siteStub();
    const now = Date.now();
    await runInDurableObject(stub, (_i, state) => {
      const sql = state.storage.sql;
      // 発見済み機器 1 台 + 発見は済んだ扱い + 残枠 95% を注入
      sql.exec(
        "INSERT INTO devices (id, vendor, vendor_device_id, name, room, capabilities) VALUES (?, ?, ?, ?, ?, ?)",
        "switchbot:X1",
        "switchbot",
        "X1",
        "温湿度計",
        "living",
        JSON.stringify([{ capability: "temperature_read", feedback: "verified" }]),
      );
      sql.exec("INSERT INTO kv (key, value) VALUES ('last_discovery', ?)", String(now));
      sql.exec(
        "INSERT INTO rate_budget (vendor, day, used, daily_limit) VALUES ('switchbot', ?, 9500, 10000)",
        jstDay(now),
      );
    });

    const ran = await runDurableObjectAlarm(stub);
    expect(ran).toBe(true);

    const states = await stub.getStateRpc();
    expect(states[0]?.state).toBeNull(); // ポーリングされていない
  });

  it("Webhook: 状態が source=webhook で入り、直後のポーリングは間引かれる（D6）", async () => {
    mockFetch({}); // ポーリングが飛んだら失敗する
    const stub = siteStub();
    const now = Date.now();
    await runInDurableObject(stub, (_i, state) => {
      const sql = state.storage.sql;
      sql.exec(
        "INSERT INTO devices (id, vendor, vendor_device_id, name, room, capabilities) VALUES (?, ?, ?, ?, ?, ?)",
        "switchbot:MAC1",
        "switchbot",
        "MAC1",
        "温湿度計",
        "living",
        JSON.stringify([
          { capability: "temperature_read", feedback: "verified" },
          { capability: "humidity_read", feedback: "verified" },
        ]),
      );
      sql.exec("INSERT INTO kv (key, value) VALUES ('last_discovery', ?)", String(now));
    });

    // SwitchBot webhook payload を DO の fetch に直接投げる（Worker からの委譲と同じ経路）
    const res = await stub.fetch(
      new Request("https://do/webhook/switchbot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          eventType: "changeReport",
          context: { deviceType: "WoMeter", deviceMac: "MAC1", temperature: 22.5, humidity: 45, timeOfSample: now },
        }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, applied: 1 });

    const states = await stub.getStateRpc("switchbot:MAC1");
    expect(states[0]?.state).toMatchObject({ temperature: 22.5, humidity: 45 });
    expect(states[0]?.source).toBe("webhook");

    // 直後のアラームでは webhook で新鮮な機器はポーリングされない（unmocked fetch が飛べば失敗する）
    await runDurableObjectAlarm(stub);
    const after = await stub.getStateRpc("switchbot:MAC1");
    expect(after[0]?.source).toBe("webhook"); // poll で上書きされていない

    // 未知ベンダー・未対応ベンダーは 404
    const unknown = await stub.fetch(new Request("https://do/webhook/nope", { method: "POST", body: "{}" }));
    expect(unknown.status).toBe(404);
  });

  it("オフライン検知: 2時間無応答で通知フラグが立つ（同じ停止期間は1回だけ）", async () => {
    mockFetch({});
    const stub = siteStub();
    const now = Date.now();
    await runInDurableObject(stub, (_i, state) => {
      const sql = state.storage.sql;
      sql.exec(
        "INSERT INTO devices (id, vendor, vendor_device_id, name, room, capabilities) VALUES ('sw:old','fake','old','古い機器','living','[]')",
      );
      sql.exec(
        "INSERT INTO state_cache (device_id, state, updated_at, source) VALUES ('sw:old', '{}', ?, 'poll')",
        now - 3 * 3600_000, // 3 時間前
      );
      sql.exec("INSERT INTO kv (key, value) VALUES ('last_discovery', ?)", String(now));
    });

    await runDurableObjectAlarm(stub);
    const first = await runInDurableObject(stub, (_i, state) =>
      state.storage.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'offline_notified:sw:old'").toArray(),
    );
    expect(first).toHaveLength(1);

    // もう 1 周しても通知フラグは更新されない（再通知しない）
    await runDurableObjectAlarm(stub);
    const second = await runInDurableObject(stub, (_i, state) =>
      state.storage.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'offline_notified:sw:old'").toArray(),
    );
    expect(second).toEqual(first);
  });

  it("閉ループ検証: 期限到来分をアラームで判定し、効いていなければ failed を記録（D5）", async () => {
    mockFetch({}); // 実 HTTP は全て遮断（discovery の失敗は握って続行される）
    const stub = siteStub();
    const now = Date.now();
    await runInDurableObject(stub, (_i, state) => {
      const sql = state.storage.sql;
      // via 機器（プラグ）の最新値: 500W
      sql.exec(
        "INSERT INTO devices (id, vendor, vendor_device_id, name, room, capabilities) VALUES ('plug','fake','p','プラグ','bedroom','[]')",
      );
      sql.exec(
        "INSERT INTO state_cache (device_id, state, updated_at, source) VALUES ('plug', ?, ?, 'poll')",
        JSON.stringify({ powerW: 500 }),
        now,
      );
      sql.exec("INSERT INTO kv (key, value) VALUES ('last_discovery', ?)", String(now));
      // 操作ログ 2 件: ON(500W>=100 で ok になるはず) / OFF(500W<=50 で failed になるはず)
      for (const [id, expectJson] of [
        [1, { via: "plug", metric: "powerW", op: ">=", value: 100 }],
        [2, { via: "plug", metric: "powerW", op: "<=", value: 50 }],
      ] as const) {
        sql.exec(
          "INSERT INTO operation_log (id, ts, actor, device_id, action, reason, result, verification) VALUES (?, ?, 'rule:x', 'ac', '{}', 'r', 'ok', 'pending')",
          id,
          now - 6 * 60_000,
        );
        sql.exec(
          "INSERT INTO pending_verifications (op_log_id, device_id, check_after, expect) VALUES (?, 'ac', ?, ?)",
          id,
          now - 1000,
          JSON.stringify(expectJson),
        );
      }
    });

    await runDurableObjectAlarm(stub);

    const rows = await runInDurableObject(stub, (_i, state) =>
      state.storage.sql
        .exec<{ id: number; verification: string }>("SELECT id, verification FROM operation_log ORDER BY id")
        .toArray(),
    );
    expect(rows[0]?.verification).toBe("ok:powerW=500 expected>=100");
    expect(rows[1]?.verification).toBe("failed:powerW=500 expected<=50");
    const pending = await runInDurableObject(stub, (_i, state) =>
      state.storage.sql.exec("SELECT * FROM pending_verifications").toArray(),
    );
    expect(pending).toHaveLength(0);
  });
});
