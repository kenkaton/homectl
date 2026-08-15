// 安全層 — 全ての機器操作はこの関数を必ず通る（§6・D3）。
// アダプタを直接呼ぶコードパスは作らない（ESLint で import を制限済み）。
// チェック順: キルスイッチ → 機器別頻度 → 能力別制約 → 実行 → 操作ログ記録
// → (assumed/inferred なら) 検証タスク登録。ブロック時も操作ログに blocked:<理由> で残す。
import type { Action, Device, VendorAdapter } from "../adapters/types";
import type { Notifier } from "../notify/types";
import { LIMITS } from "./limits";
import * as store from "../store";
import { writeTelemetry } from "../telemetry";

export interface EnforceDeps {
  sql: SqlStorage;
  adapters: Map<string, VendorAdapter>;
  notifier: Notifier;
  telemetry?: AnalyticsEngineDataset;
  now(): number;
}

export interface ActionOutcome {
  ok: boolean;
  result: string; // 'ok' | 'blocked:<why>' | 'error:<msg>'
  opLogId: number;
  verification: "pending" | "none" | "unverifiable";
}

// Action.type → 必要な能力。lock は lock_state_read を持つ機器（=錠）に対して行う
// （能力 union に施錠の書き込み能力は存在しないため、読み取り能力を錠のマーカーとして使う）
const REQUIRED_CAP: Record<Action["type"], Device["capabilities"][number]["capability"]> = {
  on_off: "on_off",
  temperature_set: "temperature_set",
  curtain_position: "curtain_position",
  lock: "lock_state_read",
};

export async function executeAction(
  deps: EnforceDeps,
  device: Device,
  action: Action,
  actor: string,
  reason: string,
): Promise<ActionOutcome> {
  const now = deps.now();

  const log = (result: string, verification: ActionOutcome["verification"]): number => {
    deps.sql.exec(
      "INSERT INTO operation_log (ts, actor, device_id, action, reason, result, verification) VALUES (?, ?, ?, ?, ?, ?, ?)",
      now,
      actor,
      device.id,
      JSON.stringify(action),
      reason,
      result,
      verification === "none" ? null : verification,
    );
    const row = deps.sql.exec<{ id: number }>("SELECT last_insert_rowid() AS id").one();
    return row.id;
  };
  const blocked = (why: string): ActionOutcome => ({
    ok: false,
    result: `blocked:${why}`,
    opLogId: log(`blocked:${why}`, "none"),
    verification: "none",
  });

  // 1. キルスイッチ
  if (store.getKv(deps.sql, LIMITS.global.killSwitchKey) === "on") {
    return blocked("kill_switch");
  }

  // 2. 能力の宣言確認（宣言していない操作は物理的に通さない）
  const requiredCap = REQUIRED_CAP[action.type];
  const cap = device.capabilities.find((c) => c.capability === requiredCap);
  if (!cap) {
    return blocked(`unsupported_capability:${action.type}`);
  }

  // 3. 機器別頻度（実行された操作のみ数える。ブロックは機器に届いていない）
  const hourAgo = now - 3600_000;
  const okOpsLastHour = deps.sql
    .exec<{ n: number }>(
      "SELECT COUNT(*) AS n FROM operation_log WHERE device_id = ? AND result = 'ok' AND ts > ?",
      device.id,
      hourAgo,
    )
    .one().n;
  if (okOpsLastHour >= LIMITS.global.maxOpsPerDevicePerHour) {
    return blocked(`device_rate_limit:${LIMITS.global.maxOpsPerDevicePerHour}/h`);
  }

  // 4. 能力別制約
  const isAc = device.capabilities.some((c) => c.capability === "temperature_set");
  if (isAc && okOpsLastHour >= LIMITS.ac.maxOpsPerHour) {
    // コンプレッサ保護: エアコン系機器は種別を問わず操作総数を絞る
    return blocked(`ac_rate_limit:${LIMITS.ac.maxOpsPerHour}/h`);
  }
  if (action.type === "temperature_set") {
    if (action.value < LIMITS.ac.minSetTemp || action.value > LIMITS.ac.maxSetTemp) {
      return blocked(`temp_out_of_range:${LIMITS.ac.minSetTemp}..${LIMITS.ac.maxSetTemp}`);
    }
  }
  if (action.type === "curtain_position" && (action.value < 0 || action.value > 100)) {
    return blocked("curtain_out_of_range:0..100");
  }
  // action.type === "lock": 施錠のみ存在する。解錠 Action は型に無い（LIMITS.lock.allowUnlock は恒真で false）

  // 5. 実行（アダプタ経由。ここが唯一の呼び出し点）
  const adapter = deps.adapters.get(device.vendor);
  if (!adapter) {
    return {
      ok: false,
      result: "error:no_adapter",
      opLogId: log("error:no_adapter", "none"),
      verification: "none",
    };
  }
  let execResult;
  try {
    execResult = await adapter.execute(device, action);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, result: `error:${msg}`, opLogId: log(`error:${msg}`, "none"), verification: "none" };
  }
  if (!execResult.ok) {
    const msg = execResult.error ?? "unknown";
    return { ok: false, result: `error:${msg}`, opLogId: log(`error:${msg}`, "none"), verification: "none" };
  }

  // 6. 状態キャッシュ更新 + テレメトリ
  if (execResult.newState && Object.keys(execResult.newState).length > 0) {
    const merged = store.mergeState(deps.sql, device.id, execResult.newState, "command", now);
    writeTelemetry(deps.telemetry, device, merged);
  }

  // 7. 検証タスク登録（送っただけ＝assumed / 別センサー推定＝inferred の操作は閉ループで確認。D5）
  let verification: ActionOutcome["verification"] = "none";
  if (cap.feedback !== "verified") {
    const expect = buildExpectation(cap.via, action);
    if (expect) {
      verification = "pending";
      const opLogId = log("ok", "pending");
      deps.sql.exec(
        "INSERT INTO pending_verifications (op_log_id, device_id, check_after, expect) VALUES (?, ?, ?, ?)",
        opLogId,
        device.id,
        now + LIMITS.verification.delayMinutes * 60_000,
        JSON.stringify(expect),
      );
      return { ok: true, result: "ok", opLogId, verification };
    }
    // via 未設定 = 確認手段がない。正直に unverifiable と記録する
    verification = "unverifiable";
    return { ok: true, result: "ok", opLogId: log("ok", "unverifiable"), verification };
  }
  return { ok: true, result: "ok", opLogId: log("ok", "none"), verification };
}

export interface Expectation {
  via: string; // 根拠となる機器 id（power_read を持つプラグ/スマートメーター）
  metric: "powerW";
  op: ">=" | "<=";
  value: number;
}

function buildExpectation(via: string | undefined, action: Action): Expectation | null {
  if (!via) return null;
  if (action.type === "on_off") {
    return action.value
      ? { via, metric: "powerW", op: ">=", value: LIMITS.verification.onMinPowerW }
      : { via, metric: "powerW", op: "<=", value: LIMITS.verification.offMaxPowerW };
  }
  // temperature_set 等は短時間の消費電力では白黒つけられないため自動検証しない
  return null;
}

export function evaluateExpectation(expect: Expectation, measured: number): boolean {
  return expect.op === ">=" ? measured >= expect.value : measured <= expect.value;
}
