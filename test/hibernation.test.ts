// ハイバーネーション対策の検証（§9-5）:
// 「状態設定 → DO 再生成（コンストラクタ再実行）→ 同じ判断が再現される」。
// abortAllDurableObjects() でインスタンスを破棄し（ストレージは残る）、
// 次のアクセスでコンストラクタが SQLite から再構築することを確かめる。
import { abortAllDurableObjects, env, reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { getKv, setKv } from "../src/store";
import { jstDay } from "../src/util/time";
import { insertDevice, insertState, PLUG_DEVICE } from "./fakes";

beforeEach(async () => {
  await reset();
  await abortAllDurableObjects();
});

const stub = () => env.SITE.get(env.SITE.idFromName("main"));

describe("SiteDO ハイバーネーション復帰", () => {
  it("キルスイッチ・残枠・状態キャッシュ・cooldown が再構築後も同じ判断を導く", async () => {
    const now = Date.now();

    // --- 状態設定（1 世代目のインスタンス） ---
    await stub().setKillSwitchRpc(true, "test");
    await runInDurableObject(stub(), (_i, state) => {
      const sql = state.storage.sql;
      insertDevice(sql, { ...PLUG_DEVICE, vendor: "switchbot" });
      insertState(sql, PLUG_DEVICE.id, { powerW: 1234, power: "on" }, now);
      setKv(sql, "rule_last_fired:peak-shaving", String(now));
      sql.exec(
        "INSERT INTO rate_budget (vendor, day, used, daily_limit) VALUES ('switchbot', ?, 4321, 10000)",
        jstDay(now),
      );
    });

    // --- DO 再生成（インスタンス破棄・ストレージ保持 = ハイバネーション相当） ---
    await abortAllDurableObjects();

    // --- 2 世代目: コンストラクタが SQLite から再構築し、同じ判断を返す ---
    // キルスイッチ: 操作は依然として拒否される（in-memory に依存していない証拠）
    const blocked = await stub().setStateRpc("bedroom-plug", { type: "on_off", value: false }, "test");
    expect(blocked.result).toBe("blocked:kill_switch");

    // 残枠: 消費カウントが保持されている
    const budget = await stub().getRateBudgetRpc();
    expect(budget).toEqual([
      { vendor: "switchbot", day: jstDay(Date.now()), used: 4321, dailyLimit: 10000, remaining: 5679 },
    ]);

    // 状態キャッシュ: 復帰後も読める
    const states = await stub().getStateRpc("bedroom-plug");
    expect(states[0]?.state).toMatchObject({ powerW: 1234, power: "on" });

    // cooldown: ルールの最終発動時刻が残っている（エンジンは毎回ここを読む）
    const lastFired = await runInDurableObject(stub(), (_i, state) =>
      getKv(state.storage.sql, "rule_last_fired:peak-shaving"),
    );
    expect(lastFired).toBe(String(now));

    // アラーム連鎖: 再構築後も次のアラームが必ず張られている（§9-2）
    const alarm = await runInDurableObject(stub(), (_i, state) => state.storage.getAlarm());
    expect(alarm).not.toBeNull();

    // 操作ログ: 世代を跨いで追記されている（kill_switch 操作 + ブロックされた操作）
    const ops = await stub().recentOperationsRpc(10);
    expect(ops.map((o) => o.result)).toEqual(["blocked:kill_switch", "ok"]);
  });

  it("キルスイッチ解除も再生成を跨いで効く", async () => {
    await stub().setKillSwitchRpc(true, "test");
    await stub().setKillSwitchRpc(false, "test");
    await runInDurableObject(stub(), (_i, state) => {
      insertDevice(state.storage.sql, PLUG_DEVICE); // vendor "fake" = アダプタなし
    });

    await abortAllDurableObjects();

    // キルスイッチは off のまま → 安全層は通過し、アダプタ不在エラーまで到達する
    const outcome = await stub().setStateRpc("bedroom-plug", { type: "on_off", value: true }, "test");
    expect(outcome.result).toBe("error:no_adapter");
  });
});
