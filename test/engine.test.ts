// ルールエンジンのテスト（§7）: cooldown・例外分離・webhook の room フィルタ・決定性。
import { abortAllDurableObjects, env, reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { EngineDeps } from "../src/rules/engine";
import { evaluateRules } from "../src/rules/engine";
import { defineRule } from "../src/rules/types";
import peakShaving from "../rules/peak-shaving";
import { AC_DEVICE, FakeAdapter, insertDevice, insertState, MemoryNotifier, PLUG_DEVICE } from "./fakes";

beforeEach(async () => {
  await reset();
  await abortAllDurableObjects();
});

async function withSql<T>(fn: (sql: SqlStorage) => Promise<T>): Promise<T> {
  const stub = env.SITE.get(env.SITE.idFromName("main"));
  return runInDurableObject(stub, (_i, state) => fn(state.storage.sql));
}

function makeDeps(sql: SqlStorage, nowRef: { t: number }, rules: EngineDeps["rules"]) {
  const adapter = new FakeAdapter();
  const notifier = new MemoryNotifier();
  const deps: EngineDeps = {
    sql,
    adapters: new Map([["fake", adapter]]),
    notifier,
    rules,
    now: () => nowRef.t,
    random: () => 0.5,
  };
  return { deps, adapter, notifier };
}

describe("ルールエンジン", () => {
  it("peak-shaving: 3kW 超で設定温度を 1 度上げ、cooldown 中は再発動しない", async () => {
    await withSql(async (sql) => {
      insertDevice(sql, AC_DEVICE);
      insertDevice(sql, PLUG_DEVICE);
      const nowRef = { t: 1_700_000_000_000 };
      insertState(sql, PLUG_DEVICE.id, { powerW: 3500 }, nowRef.t);
      insertState(sql, AC_DEVICE.id, { setTemp: 26 }, nowRef.t);
      const { deps, adapter } = makeDeps(sql, nowRef, [peakShaving]);

      await evaluateRules(deps, "alarm");
      expect(adapter.executed).toEqual([
        { deviceId: "bedroom-ac", action: { type: "temperature_set", value: 27 } },
      ]);

      // 操作ログに actor と発動根拠（実測値入り）が残る（D10）
      const log = sql
        .exec<{ actor: string; reason: string; result: string }>(
          "SELECT actor, reason, result FROM operation_log ORDER BY id DESC LIMIT 1",
        )
        .one();
      expect(log.actor).toBe("rule:peak-shaving");
      expect(log.reason).toContain("合計3kW超");
      expect(log.reason).toContain("totalPowerW=3500W");
      expect(log.result).toBe("ok");

      // cooldown 15 分: 5 分後は発動しない
      nowRef.t += 5 * 60_000;
      insertState(sql, AC_DEVICE.id, { setTemp: 27 }, nowRef.t); // 状態は command 反映済みとする
      await evaluateRules(deps, "alarm");
      expect(adapter.executed).toHaveLength(1);

      // 16 分後は再発動
      nowRef.t += 11 * 60_000;
      await evaluateRules(deps, "alarm");
      expect(adapter.executed).toHaveLength(2);
      expect(adapter.executed[1]?.action).toEqual({ type: "temperature_set", value: 28 });

      // さらに 16 分後: 上限 28 度なので操作なし（condition は真でも action が抑制）
      nowRef.t += 16 * 60_000;
      insertState(sql, AC_DEVICE.id, { setTemp: 28 }, nowRef.t);
      await evaluateRules(deps, "alarm");
      expect(adapter.executed).toHaveLength(2);
    });
  });

  it("例外を投げるルールは通知され、他のルールは継続する", async () => {
    await withSql(async (sql) => {
      insertDevice(sql, PLUG_DEVICE);
      const nowRef = { t: 1_700_000_000_000 };
      const broken = defineRule({
        id: "broken",
        description: "存在しない機器を触る",
        condition: () => true,
        action: async (ctx) => {
          ctx.device("no-such-device");
        },
      });
      const healthy = defineRule({
        id: "healthy",
        description: "プラグを切る",
        condition: () => true,
        action: async (ctx) => {
          await ctx.setOnOff(ctx.device("bedroom-plug"), false);
        },
      });
      const { deps, adapter, notifier } = makeDeps(sql, nowRef, [broken, healthy]);

      await evaluateRules(deps, "alarm");
      // broken は rule_error 通知、healthy は実行されている
      expect(notifier.events).toHaveLength(1);
      expect(notifier.events[0]).toMatchObject({ kind: "rule_error", level: "alert" });
      expect(notifier.events[0]?.title).toContain("broken");
      expect(adapter.executed).toEqual([
        { deviceId: "bedroom-plug", action: { type: "on_off", value: false } },
      ]);

      // エラー通知は 1 時間に 1 回まで（スパム防止）
      nowRef.t += 10 * 60_000;
      await evaluateRules(deps, "alarm");
      expect(notifier.events).toHaveLength(1);
    });
  });

  it("webhook トリガーは rooms を宣言したルールの該当部屋のみ評価", async () => {
    await withSql(async (sql) => {
      insertDevice(sql, PLUG_DEVICE);
      const nowRef = { t: 1_700_000_000_000 };
      const fired: string[] = [];
      const bedroomRule = defineRule({
        id: "bedroom-rule",
        description: "",
        rooms: ["bedroom"],
        condition: () => true,
        action: () => {
          fired.push("bedroom-rule");
        },
      });
      const livingRule = defineRule({
        id: "living-rule",
        description: "",
        rooms: ["living"],
        condition: () => true,
        action: () => {
          fired.push("living-rule");
        },
      });
      const noRoomRule = defineRule({
        id: "no-room-rule",
        description: "",
        condition: () => true,
        action: () => {
          fired.push("no-room-rule");
        },
      });
      const { deps } = makeDeps(sql, nowRef, [bedroomRule, livingRule, noRoomRule]);

      await evaluateRules(deps, "webhook", ["bedroom"]);
      expect(fired).toEqual(["bedroom-rule"]); // rooms 未宣言ルールは webhook では走らない

      fired.length = 0;
      await evaluateRules(deps, "alarm");
      expect(fired.sort()).toEqual(["bedroom-rule", "living-rule", "no-room-rule"]);
    });
  });

  it("決定性: 時刻と乱数は ctx 経由の注入値", async () => {
    await withSql(async (sql) => {
      const nowRef = { t: 1_722_222_222_222 };
      const seen: Array<{ now: number; random: number }> = [];
      const probe = defineRule({
        id: "probe",
        description: "",
        condition: (ctx) => {
          seen.push({ now: ctx.now(), random: ctx.random() });
          return false;
        },
        action: () => undefined,
      });
      const { deps } = makeDeps(sql, nowRef, [probe]);
      await evaluateRules(deps, "alarm");
      expect(seen).toEqual([{ now: 1_722_222_222_222, random: 0.5 }]);
    });
  });
});
