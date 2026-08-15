// 安全層の境界値テスト（§6/§12 Phase 3）: 上下限ちょうど・跨ぎ・頻度制限・キルスイッチ。
// 実 DO の SQLite に対して enforce を直接叩く。
import { abortAllDurableObjects, env, reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { EnforceDeps } from "../src/safety/enforce";
import { executeAction } from "../src/safety/enforce";
import { setKv } from "../src/store";
import { AC_DEVICE, FakeAdapter, MemoryNotifier, PLUG_DEVICE } from "./fakes";

beforeEach(async () => {
  await reset();
  await abortAllDurableObjects();
});

function makeDeps(sql: SqlStorage, nowRef: { t: number }) {
  const adapter = new FakeAdapter();
  const notifier = new MemoryNotifier();
  const deps: EnforceDeps = {
    sql,
    adapters: new Map([["fake", adapter]]),
    notifier,
    now: () => nowRef.t,
  };
  return { deps, adapter, notifier };
}

async function withSql<T>(fn: (sql: SqlStorage) => Promise<T>): Promise<T> {
  const stub = env.SITE.get(env.SITE.idFromName("main"));
  return runInDurableObject(stub, (_i, state) => fn(state.storage.sql));
}

describe("安全層 enforce", () => {
  it("設定温度の境界値: 19.9=blocked / 20=ok / 30=ok / 30.1=blocked", async () => {
    await withSql(async (sql) => {
      const nowRef = { t: 1_700_000_000_000 };
      const { deps, adapter } = makeDeps(sql, nowRef);
      const run = (v: number) =>
        executeAction(deps, AC_DEVICE, { type: "temperature_set", value: v }, "test", "境界値");

      expect((await run(19.9)).result).toBe("blocked:temp_out_of_range:20..30");
      expect((await run(20)).result).toBe("ok");
      expect((await run(30)).result).toBe("ok");
      expect((await run(30.1)).result).toBe("blocked:temp_out_of_range:20..30");
      expect(adapter.executed.map((e) => e.action)).toEqual([
        { type: "temperature_set", value: 20 },
        { type: "temperature_set", value: 30 },
      ]);

      // ブロックも操作ログに blocked:<理由> で残る（D10）
      const rows = sql
        .exec<{ result: string }>("SELECT result FROM operation_log ORDER BY id")
        .toArray()
        .map((r) => r.result);
      expect(rows).toEqual([
        "blocked:temp_out_of_range:20..30",
        "ok",
        "ok",
        "blocked:temp_out_of_range:20..30",
      ]);
    });
  });

  it("エアコンは 6 回/時でブロック、1 時間経過で再び通る（コンプレッサ保護）", async () => {
    await withSql(async (sql) => {
      const nowRef = { t: 1_700_000_000_000 };
      const { deps } = makeDeps(sql, nowRef);
      for (let i = 0; i < 6; i++) {
        nowRef.t += 60_000;
        const o = await executeAction(deps, AC_DEVICE, { type: "temperature_set", value: 21 + i }, "test", "頻度");
        expect(o.result).toBe("ok");
      }
      const blocked = await executeAction(deps, AC_DEVICE, { type: "temperature_set", value: 27 }, "test", "頻度");
      expect(blocked.result).toBe("blocked:ac_rate_limit:6/h");

      nowRef.t += 3_600_000; // 1 時間経過で窓から抜ける
      const again = await executeAction(deps, AC_DEVICE, { type: "temperature_set", value: 27 }, "test", "頻度");
      expect(again.result).toBe("ok");
    });
  });

  it("機器共通の上限は 12 回/時（エアコン以外）", async () => {
    await withSql(async (sql) => {
      const nowRef = { t: 1_700_000_000_000 };
      const { deps } = makeDeps(sql, nowRef);
      for (let i = 0; i < 12; i++) {
        nowRef.t += 1000;
        const o = await executeAction(deps, PLUG_DEVICE, { type: "on_off", value: i % 2 === 0 }, "test", "頻度");
        expect(o.result).toBe("ok");
      }
      const blocked = await executeAction(deps, PLUG_DEVICE, { type: "on_off", value: true }, "test", "頻度");
      expect(blocked.result).toBe("blocked:device_rate_limit:12/h");
    });
  });

  it("キルスイッチ ON で全操作拒否", async () => {
    await withSql(async (sql) => {
      const nowRef = { t: 1_700_000_000_000 };
      const { deps, adapter } = makeDeps(sql, nowRef);
      setKv(sql, "kill_switch", "on");
      const o = await executeAction(deps, PLUG_DEVICE, { type: "on_off", value: true }, "test", "kill");
      expect(o.result).toBe("blocked:kill_switch");
      expect(adapter.executed).toHaveLength(0);

      setKv(sql, "kill_switch", "off");
      const o2 = await executeAction(deps, PLUG_DEVICE, { type: "on_off", value: true }, "test", "kill");
      expect(o2.result).toBe("ok");
    });
  });

  it("宣言していない能力への操作はブロック", async () => {
    await withSql(async (sql) => {
      const nowRef = { t: 1_700_000_000_000 };
      const { deps } = makeDeps(sql, nowRef);
      const o = await executeAction(deps, AC_DEVICE, { type: "curtain_position", value: 50 }, "test", "能力");
      expect(o.result).toBe("blocked:unsupported_capability:curtain_position");
      const o2 = await executeAction(deps, PLUG_DEVICE, { type: "lock" }, "test", "能力");
      expect(o2.result).toBe("blocked:unsupported_capability:lock");
    });
  });

  it("inferred(via あり) の on_off は検証タスクが積まれ、assumed(via なし) は unverifiable", async () => {
    await withSql(async (sql) => {
      const nowRef = { t: 1_700_000_000_000 };
      const { deps } = makeDeps(sql, nowRef);

      const on = await executeAction(deps, AC_DEVICE, { type: "on_off", value: true }, "rule:x", "検証");
      expect(on.result).toBe("ok");
      expect(on.verification).toBe("pending");
      const pv = sql
        .exec<{ device_id: string; check_after: number; expect: string }>("SELECT * FROM pending_verifications")
        .toArray();
      expect(pv).toHaveLength(1);
      expect(pv[0]?.device_id).toBe("bedroom-ac");
      expect(pv[0]?.check_after).toBe(nowRef.t + 5 * 60_000);
      expect(JSON.parse(pv[0]?.expect ?? "{}")).toEqual({ via: "bedroom-plug", metric: "powerW", op: ">=", value: 100 });

      // 設定温度(assumed・via なし)は確認手段がない → unverifiable として記録
      const temp = await executeAction(deps, AC_DEVICE, { type: "temperature_set", value: 26 }, "rule:x", "検証");
      expect(temp.verification).toBe("unverifiable");
      expect(sql.exec("SELECT * FROM pending_verifications").toArray()).toHaveLength(1);
    });
  });

  it("アダプタの実行失敗は error として記録される", async () => {
    await withSql(async (sql) => {
      const nowRef = { t: 1_700_000_000_000 };
      const { deps, adapter } = makeDeps(sql, nowRef);
      adapter.failNext = true;
      const o = await executeAction(deps, PLUG_DEVICE, { type: "on_off", value: true }, "test", "失敗");
      expect(o.result).toBe("error:boom");
      expect(o.ok).toBe(false);
    });
  });
});
