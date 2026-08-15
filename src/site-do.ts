// SiteDO — 拠点単位で唯一の Durable Object（idFromName("main")、D1）。
// 全状態は SQLite に置き、コンストラクタで再構築する（D9）。インスタンスフィールドは
// 設定由来（env から毎回同じものが作れる）のものだけ。
import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import type { Action, Device, DeviceState, VendorAdapter } from "./adapters/types";
import { BudgetExceededError } from "./adapters/http";
import { createAdapters, isConfigured } from "./adapters";
import type { Notifier } from "./notify/types";
import { notifySafe } from "./notify/types";
import { createNotifier } from "./notify";
import type { ActionOutcome } from "./safety/enforce";
import { evaluateExpectation, executeAction } from "./safety/enforce";
import { LIMITS } from "./safety/limits";
import { evaluateRules } from "./rules/engine";
import { rules } from "../rules/index";
import type { Env } from "./env";
import * as store from "./store";
import { writeTelemetry } from "./telemetry";
import { jstDay, jstDateTime } from "./util/time";

const ALARM_INTERVAL_MS = 5 * 60 * 1000; // D7: 既定 5 分。1 分に縮めない（wall-clock 課金が 5 倍になる）
const DISCOVERY_INTERVAL_MS = 24 * 60 * 60 * 1000;
const HTTP_TIMEOUT_MS = 10_000;

// ポーリングで読みに行く価値がある能力（verified な読み取り系 + プラグの on/off 実状態）
const READABLE = new Set(["temperature_read", "humidity_read", "power_read", "lock_state_read", "curtain_position"]);

export class SiteDO extends DurableObject<Env> {
  private sql: SqlStorage;
  private adapters: Map<string, VendorAdapter>;
  private notifier: Notifier;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    // D9: スキーマは常に冪等に再構築（sql.exec は同期）
    store.initSchema(this.sql);
    this.adapters = createAdapters(env, this.httpWithBudget.bind(this));
    this.notifier = createNotifier(env);
    // ハイバネーション復帰・初回起動のどちらでもアラーム連鎖を確実に開始する
    ctx.blockConcurrencyWhile(async () => {
      await this.ensureNextAlarm();
    });
  }

  // ---- アラーム（速いループ。D2） ----

  private async ensureNextAlarm(): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null) {
      await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
    }
  }

  override async alarm(): Promise<void> {
    try {
      const now = Date.now();
      await this.maybeDiscoverDevices(now);
      await this.pollAll(now);
      await this.processVerifications(now); // ポーリング直後 = via の最新値で判定できる
      await this.runRules("alarm");
      this.pruneOldRows(now);
    } catch (e) {
      // アラーム全体を落とす例外はここで吸収（個別処理は各所で catch 済み）
      console.error("alarm cycle failed:", e instanceof Error ? e.message : String(e));
    } finally {
      // 例外時もアラーム連鎖を切らさない（§9-2）
      await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
    }
  }

  // ---- ルール評価（速いループ本体） ----

  private async runRules(trigger: "alarm" | "webhook", rooms?: string[]): Promise<void> {
    await evaluateRules(
      {
        sql: this.sql,
        adapters: this.adapters,
        notifier: this.notifier,
        telemetry: this.env.TELEMETRY,
        rules,
        now: () => Date.now(),
        random: () => Math.random(),
      },
      trigger,
      rooms,
    );
  }

  // ---- 閉ループ検証（D5: assumed/inferred 操作の実効確認） ----

  private async processVerifications(now: number): Promise<void> {
    const expectSchema = z.object({
      via: z.string(),
      metric: z.literal("powerW"),
      op: z.enum([">=", "<="]),
      value: z.number(),
    });
    const due = this.sql
      .exec<{ id: number; op_log_id: number; device_id: string; check_after: number; expect: string }>(
        "SELECT * FROM pending_verifications WHERE check_after <= ?",
        now,
      )
      .toArray();
    for (const row of due) {
      const parsed = expectSchema.safeParse(JSON.parse(row.expect));
      const finish = (verification: string): void => {
        this.sql.exec("UPDATE operation_log SET verification = ? WHERE id = ?", verification, row.op_log_id);
        this.sql.exec("DELETE FROM pending_verifications WHERE id = ?", row.id);
      };
      if (!parsed.success) {
        finish("failed:bad_expectation");
        continue;
      }
      const expect = parsed.data;
      const via = store.getCachedState(this.sql, expect.via);
      const staleLimitMs = LIMITS.verification.staleAfterMinutes * 60_000;
      const fresh = via && now - via.updatedAt < staleLimitMs;
      if (!fresh) {
        if (now - row.check_after < staleLimitMs) continue; // 次のアラームでもう一度見る
        finish("failed:via_stale");
        await notifySafe(this.notifier, {
          level: "alert",
          kind: "verification_failed",
          title: `操作検証ができない: ${row.device_id}`,
          detail: `根拠機器 ${expect.via} のデータが古い（検証条件 ${expect.metric}${expect.op}${expect.value}）`,
          deviceId: row.device_id,
        });
        continue;
      }
      const measured = via.state[expect.metric];
      const ok = typeof measured === "number" && evaluateExpectation(expect, measured);
      const summary = `${expect.metric}=${typeof measured === "number" ? Math.round(measured) : "n/a"} expected${expect.op}${expect.value}`;
      finish(ok ? `ok:${summary}` : `failed:${summary}`);
      if (!ok) {
        await notifySafe(this.notifier, {
          level: "alert",
          kind: "verification_failed",
          title: `送った操作が効いていない可能性: ${row.device_id}`,
          detail: summary + `（根拠機器 ${expect.via}）`,
          deviceId: row.device_id,
        });
      }
    }
  }

  /** 古い操作ログ等の掃除（日付が変わったときに 1 回だけ） */
  private pruneOldRows(now: number): void {
    const today = jstDay(now);
    if (store.getKv(this.sql, "last_prune_day") === today) return;
    store.setKv(this.sql, "last_prune_day", today);
    this.sql.exec("DELETE FROM operation_log WHERE ts < ?", now - 60 * 24 * 3600_000); // 60日
    this.sql.exec("DELETE FROM pending_verifications WHERE check_after < ?", now - 24 * 3600_000);
  }

  // ---- 機器発見（24h ごと / 初回すぐ） ----

  private async maybeDiscoverDevices(now: number): Promise<void> {
    const last = Number(store.getKv(this.sql, "last_discovery") ?? 0);
    if (now - last < DISCOVERY_INTERVAL_MS) return;
    for (const adapter of this.adapters.values()) {
      if (!isConfigured(this.env, adapter)) continue;
      try {
        const found = await adapter.discoverDevices();
        for (const d of found) {
          const { id, inserted } = store.upsertDiscoveredDevice(this.sql, d);
          if (inserted) console.log(`discovered device ${id}`);
        }
      } catch (e) {
        console.error(`discovery failed for ${adapter.vendor}:`, e instanceof Error ? e.message : String(e));
      }
    }
    store.setKv(this.sql, "last_discovery", String(now));
  }

  // ---- ポーリング（Webhook 優先、ポーリングは補助。D6） ----

  private async pollAll(now: number): Promise<void> {
    for (const device of store.listDevices(this.sql)) {
      const adapter = this.adapters.get(device.vendor);
      if (!adapter || !isConfigured(this.env, adapter)) continue;
      if (!this.pollAllowed(adapter)) continue; // 残枠 95% 超はポーリング停止（§5）
      const readable = device.capabilities.some(
        (c) => READABLE.has(c.capability) || (c.capability === "on_off" && c.feedback === "verified"),
      );
      if (!readable) continue;
      try {
        const state = await adapter.readState(device);
        const merged = store.mergeState(this.sql, device.id, state, "poll", now);
        writeTelemetry(this.env.TELEMETRY, device, merged);
      } catch (e) {
        if (e instanceof BudgetExceededError) return; // このサイクルは打ち切り
        console.error(`poll failed for ${device.id}:`, e instanceof Error ? e.message : String(e));
      }
    }
  }

  // ---- API 残枠管理（httpWithBudget。§13） ----
  // 全ベンダー呼び出しはこの関数を経由する。残枠カウント・10s タイムアウト・冪等 GET のみ 1 回リトライ。

  private async httpWithBudget(vendor: string, req: Request): Promise<Response> {
    const limit = this.adapters.get(vendor)?.rateLimit?.perDay;
    const attempt = async (): Promise<Response> => {
      if (limit !== undefined) this.consumeBudget(vendor, limit);
      return fetch(req.clone(), { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    };
    const first = await attempt().catch((e: unknown) => e);
    const retryable =
      req.method === "GET" && (first instanceof Error || (first instanceof Response && first.status >= 500));
    if (!retryable) {
      if (first instanceof Response) return first;
      throw first;
    }
    return attempt();
  }

  /** 残枠を 1 消費。日付(JST)が変わればリセット。超過は例外 */
  private consumeBudget(vendor: string, limit: number): void {
    if (vendor === "") throw new BudgetExceededError(vendor); // 保険（vendor 不明の呼び出しは通さない）
    const day = jstDay(Date.now());
    const rows = this.sql
      .exec<{ day: string; used: number }>("SELECT day, used FROM rate_budget WHERE vendor = ?", vendor)
      .toArray();
    const row = rows[0];
    let used = row && row.day === day ? row.used : 0;
    if (used >= limit) throw new BudgetExceededError(vendor);
    used += 1;
    this.sql.exec(
      `INSERT INTO rate_budget (vendor, day, used, daily_limit) VALUES (?, ?, ?, ?)
       ON CONFLICT(vendor) DO UPDATE SET day = excluded.day, used = excluded.used, daily_limit = excluded.daily_limit`,
      vendor,
      day,
      used,
      limit,
    );
    this.onBudgetCrossed(vendor, used, limit);
  }

  /** 80% / 95% ちょうどを跨いだ瞬間に一度だけ通知（used は 1 ずつしか増えないので等値判定で足りる） */
  private onBudgetCrossed(vendor: string, used: number, limit: number): void {
    const warnAt = Math.ceil(limit * 0.8);
    const alertAt = Math.ceil(limit * 0.95);
    if (used === warnAt) {
      this.ctx.waitUntil(
        notifySafe(this.notifier, {
          level: "warn",
          kind: "rate_budget",
          title: `${vendor} の API 残枠 80% 消費`,
          detail: `used=${used}/${limit} (JST ${jstDay(Date.now())})`,
        }),
      );
    } else if (used === alertAt) {
      this.ctx.waitUntil(
        notifySafe(this.notifier, {
          level: "alert",
          kind: "rate_budget",
          title: `${vendor} の API 残枠 95% 消費 — ポーリング停止`,
          detail: `used=${used}/${limit}。Webhook とコマンドのみ継続`,
        }),
      );
    }
  }

  private pollAllowed(adapter: VendorAdapter): boolean {
    const limit = adapter.rateLimit?.perDay;
    if (limit === undefined) return true;
    const day = jstDay(Date.now());
    const rows = this.sql
      .exec<{ day: string; used: number }>("SELECT day, used FROM rate_budget WHERE vendor = ?", adapter.vendor)
      .toArray();
    const row = rows[0];
    const used = row && row.day === day ? row.used : 0;
    return used < Math.ceil(limit * 0.95);
  }

  // ---- Webhook 受信（Worker から Request ごと委譲される。Phase 5 で実装） ----

  override async fetch(_req: Request): Promise<Response> {
    return new Response("webhook handling not implemented yet", { status: 501 });
  }

  // ---- RPC（Worker / MCP から呼ばれる） ----

  async listDevicesRpc(): Promise<Device[]> {
    await this.ensureNextAlarm();
    return store.listDevices(this.sql);
  }

  async getStateRpc(deviceIdOrName?: string): Promise<
    Array<{ device: Device; state: DeviceState | null; updatedAt: number | null; source: string | null }>
  > {
    await this.ensureNextAlarm();
    const devices = deviceIdOrName
      ? [store.getDevice(this.sql, deviceIdOrName)].filter((d): d is Device => d !== null)
      : store.listDevices(this.sql);
    return devices.map((device) => {
      const cached = store.getCachedState(this.sql, device.id);
      return {
        device,
        state: cached?.state ?? null,
        updatedAt: cached?.updatedAt ?? null,
        source: cached?.source ?? null,
      };
    });
  }

  /** 機器操作。必ず安全層（enforce）経由（D3）。blocked 理由も outcome で返す */
  async setStateRpc(
    deviceIdOrName: string,
    action: Action,
    actor: string,
    reason?: string,
  ): Promise<ActionOutcome & { device?: { id: string; name: string } }> {
    await this.ensureNextAlarm();
    const device = store.getDevice(this.sql, deviceIdOrName);
    if (!device) {
      return { ok: false, result: `error:device_not_found:${deviceIdOrName}`, opLogId: -1, verification: "none" };
    }
    const outcome = await executeAction(
      {
        sql: this.sql,
        adapters: this.adapters,
        notifier: this.notifier,
        telemetry: this.env.TELEMETRY,
        now: () => Date.now(),
      },
      device,
      action,
      actor,
      reason ?? "手動操作（理由の記載なし）",
    );
    return { ...outcome, device: { id: device.id, name: device.name } };
  }

  /** キルスイッチ。"on" で全操作拒否（safety/enforce が参照） */
  async setKillSwitchRpc(on: boolean, actor: string): Promise<{ killSwitch: boolean }> {
    const now = Date.now();
    store.setKv(this.sql, LIMITS.global.killSwitchKey, on ? "on" : "off");
    this.sql.exec(
      "INSERT INTO operation_log (ts, actor, device_id, action, reason, result, verification) VALUES (?, ?, NULL, ?, ?, 'ok', NULL)",
      now,
      actor,
      JSON.stringify({ type: "set_kill_switch", value: on }),
      on ? "全機器の自動・手動操作を停止" : "操作を再開",
    );
    await notifySafe(this.notifier, {
      level: "alert",
      kind: "kill_switch",
      title: `キルスイッチ ${on ? "ON — 全操作停止" : "OFF — 操作再開"}`,
      detail: `actor: ${actor}`,
    });
    return { killSwitch: on };
  }

  /** 直近の操作ログ（新しい順）。D10: なぜ動いたかに即答するための一次データ */
  async recentOperationsRpc(limit = 20): Promise<
    Array<{
      id: number;
      ts: number;
      at: string;
      actor: string;
      deviceId: string | null;
      deviceName: string | null;
      action: string;
      reason: string;
      result: string;
      verification: string | null;
    }>
  > {
    const n = Math.min(200, Math.max(1, Math.floor(limit)));
    return this.sql
      .exec<{
        id: number;
        ts: number;
        actor: string;
        device_id: string | null;
        action: string;
        reason: string;
        result: string;
        verification: string | null;
        device_name: string | null;
      }>(
        `SELECT o.*, d.name AS device_name FROM operation_log o
         LEFT JOIN devices d ON d.id = o.device_id
         ORDER BY o.id DESC LIMIT ?`,
        n,
      )
      .toArray()
      .map((r) => ({
        id: r.id,
        ts: r.ts,
        at: jstDateTime(r.ts),
        actor: r.actor,
        deviceId: r.device_id,
        deviceName: r.device_name,
        action: r.action,
        reason: r.reason,
        result: r.result,
        verification: r.verification,
      }));
  }

  /** 機器の整理（表示名・部屋・能力の feedback/via 上書き）。発見データは消さない */
  async updateDeviceRpc(
    deviceIdOrName: string,
    patch: {
      name?: string;
      room?: string;
      capabilityOverride?: { capability: string; feedback: "verified" | "assumed" | "inferred"; via?: string };
    },
  ): Promise<{ ok: boolean; device?: Device; error?: string }> {
    const device = store.getDevice(this.sql, deviceIdOrName);
    if (!device) return { ok: false, error: `device_not_found:${deviceIdOrName}` };
    const name = patch.name ?? device.name;
    const room = patch.room ?? device.room;
    let capabilities = device.capabilities;
    if (patch.capabilityOverride) {
      const o = patch.capabilityOverride;
      if (o.feedback === "inferred" && !o.via) {
        return { ok: false, error: "inferred には via（根拠機器の id）が必要" };
      }
      if (o.via && !store.getDevice(this.sql, o.via)) {
        return { ok: false, error: `via の機器が見つからない: ${o.via}` };
      }
      let found = false;
      capabilities = device.capabilities.map((c) => {
        if (c.capability !== o.capability) return c;
        found = true;
        return { capability: c.capability, feedback: o.feedback, via: o.via };
      });
      if (!found) return { ok: false, error: `機器が能力 ${o.capability} を持っていない` };
    }
    this.sql.exec(
      "UPDATE devices SET name = ?, room = ?, capabilities = ? WHERE id = ?",
      name,
      room,
      JSON.stringify(capabilities),
      device.id,
    );
    return { ok: true, device: store.getDevice(this.sql, device.id) ?? undefined };
  }

  async getRateBudgetRpc(): Promise<
    Array<{ vendor: string; day: string; used: number; dailyLimit: number; remaining: number }>
  > {
    const today = jstDay(Date.now());
    return this.sql
      .exec<{ vendor: string; day: string; used: number; daily_limit: number }>("SELECT * FROM rate_budget")
      .toArray()
      .map((r) => {
        const used = r.day === today ? r.used : 0;
        return { vendor: r.vendor, day: today, used, dailyLimit: r.daily_limit, remaining: r.daily_limit - used };
      });
  }

  /** ダッシュボード用スナップショット（読み取り専用） */
  async dashData(): Promise<{
    generatedAt: string;
    now: number;
    devices: Array<{
      device: Device;
      state: DeviceState | null;
      updatedAt: string | null;
      updatedAtMs: number | null;
      source: string | null;
    }>;
    rateBudget: Array<{ vendor: string; used: number; dailyLimit: number }>;
    killSwitch: boolean;
  }> {
    const states = await this.getStateRpc();
    return {
      generatedAt: jstDateTime(Date.now()),
      now: Date.now(),
      devices: states.map((s) => ({
        device: s.device,
        state: s.state,
        updatedAt: s.updatedAt === null ? null : jstDateTime(s.updatedAt),
        updatedAtMs: s.updatedAt,
        source: s.source,
      })),
      rateBudget: (await this.getRateBudgetRpc()).map((b) => ({
        vendor: b.vendor,
        used: b.used,
        dailyLimit: b.dailyLimit,
      })),
      killSwitch: store.getKv(this.sql, "kill_switch") === "on",
    };
  }
}
