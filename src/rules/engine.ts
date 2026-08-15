// ルールエンジン（速いループの評価器。D2）。
// - 5 分アラームごと + Webhook 受信直後（該当 room のルールのみ）に評価
// - 例外は握り潰さず通知し、当該ルールのみ skip して他は継続（§7）
// - 判断材料（cooldown・状態）は全て SQLite。エンジン自体は状態を持たない（D9）
import type { Device, VendorAdapter } from "../adapters/types";
import type { Notifier } from "../notify/types";
import { notifySafe } from "../notify/types";
import type { ActionOutcome } from "../safety/enforce";
import { executeAction } from "../safety/enforce";
import * as store from "../store";
import type { RuleContext, RuleDef } from "./types";

export interface EngineDeps {
  sql: SqlStorage;
  adapters: Map<string, VendorAdapter>;
  notifier: Notifier;
  telemetry?: AnalyticsEngineDataset;
  rules: RuleDef[];
  now(): number;
  random(): number;
}

const RULE_ERROR_NOTIFY_INTERVAL_MS = 3600_000; // 同一ルールのエラー通知は 1 時間に 1 回まで

export async function evaluateRules(
  deps: EngineDeps,
  trigger: "alarm" | "webhook",
  rooms?: string[],
): Promise<void> {
  for (const rule of deps.rules) {
    // Webhook 即時評価は rooms を宣言したルールのみ・該当部屋のみ（§7）
    if (trigger === "webhook") {
      if (!rule.rooms || !rooms || !rule.rooms.some((r) => rooms.includes(r))) continue;
    }

    const now = deps.now();
    const lastFired = Number(store.getKv(deps.sql, `rule_last_fired:${rule.id}`) ?? 0);
    const cooldownMs = (rule.cooldownMinutes ?? 0) * 60_000;
    if (lastFired && now - lastFired < cooldownMs) continue;

    const { ctx, outcomes } = buildContext(deps, rule, now);
    try {
      if (!rule.condition(ctx)) continue;
      // 発動: cooldown は action の成否によらず記録（壊れた action の連打を防ぐ）
      store.setKv(deps.sql, `rule_last_fired:${rule.id}`, String(now));
      await rule.action(ctx);
      // 操作が error だった場合は通知（アダプタ内で 1 回だけ再送済み。無限再送はしない）
      const failed = outcomes.filter((o) => o.result.startsWith("error:"));
      if (failed.length > 0) {
        await notifyRuleError(deps, rule, now, `操作失敗: ${failed.map((f) => f.result).join(", ")}`);
      }
    } catch (e) {
      await notifyRuleError(deps, rule, now, e instanceof Error ? (e.stack ?? e.message) : String(e));
      // 当該ルールのみ skip、他のルールは継続
    }
  }
}

async function notifyRuleError(deps: EngineDeps, rule: RuleDef, now: number, detail: string): Promise<void> {
  console.error(`rule ${rule.id} error:`, detail);
  const key = `rule_error_notified:${rule.id}`;
  const last = Number(store.getKv(deps.sql, key) ?? 0);
  if (now - last < RULE_ERROR_NOTIFY_INTERVAL_MS) return;
  store.setKv(deps.sql, key, String(now));
  await notifySafe(deps.notifier, {
    level: "alert",
    kind: "rule_error",
    title: `ルール ${rule.id} の実行に失敗`,
    detail: detail.slice(0, 500),
  });
}

function buildContext(
  deps: EngineDeps,
  rule: RuleDef,
  now: number,
): { ctx: RuleContext; outcomes: ActionOutcome[] } {
  const outcomes: ActionOutcome[] = [];
  const trace: string[] = [];
  let because: string | undefined;

  const resolveDevice = (idOrName: string): Device => {
    const d = store.getDevice(deps.sql, idOrName);
    if (!d) throw new Error(`device not found: ${idOrName}`);
    return d;
  };
  const stateOf = (device: Device | string) => {
    const id = typeof device === "string" ? resolveDevice(device).id : device.id;
    const s = store.getCachedState(deps.sql, id)?.state ?? {};
    if (trace.length < 6) trace.push(`state(${id})=${JSON.stringify(s).slice(0, 80)}`);
    return s;
  };
  const reason = (): string => {
    const basis = because ?? trace.join("; ");
    return basis ? `${rule.description} | ${basis}` : rule.description;
  };
  const act = async (device: Device, action: Parameters<typeof executeAction>[2]): Promise<ActionOutcome> => {
    const outcome = await executeAction(
      { sql: deps.sql, adapters: deps.adapters, notifier: deps.notifier, telemetry: deps.telemetry, now: deps.now },
      device,
      action,
      `rule:${rule.id}`,
      reason(),
    );
    outcomes.push(outcome);
    return outcome;
  };

  const ctx: RuleContext = {
    now: () => now,
    random: deps.random,
    device: resolveDevice,
    state: stateOf,
    totalPowerW: () => {
      let total = 0;
      for (const d of store.listDevices(deps.sql)) {
        if (!d.capabilities.some((c) => c.capability === "power_read")) continue;
        const w = store.getCachedState(deps.sql, d.id)?.state.powerW;
        if (typeof w === "number") total += w;
      }
      if (trace.length < 6) trace.push(`totalPowerW=${Math.round(total)}W`);
      return total;
    },
    room: (name) => store.listDevices(deps.sql).filter((d) => d.room === name),
    because: (r) => {
      because = r;
    },
    setTemperature: (device, tempC) => act(device, { type: "temperature_set", value: tempC }),
    setOnOff: (device, on) => act(device, { type: "on_off", value: on }),
    setCurtainPosition: (device, position) => act(device, { type: "curtain_position", value: position }),
    lock: (device) => act(device, { type: "lock" }),
  };
  return { ctx, outcomes };
}
