// SiteDO — 拠点単位で唯一の Durable Object（idFromName("main")、D1）。
// 全状態は SQLite に置き、コンストラクタで再構築する（D9）。インスタンスフィールドは
// 設定由来（env から毎回同じものが作れる）のものだけ。
import { DurableObject } from "cloudflare:workers";
import type { Device, DeviceState, VendorAdapter } from "./adapters/types";
import { BudgetExceededError } from "./adapters/http";
import { createAdapters, isConfigured } from "./adapters";
import type { Notifier } from "./notify/types";
import { notifySafe } from "./notify/types";
import { createNotifier } from "./notify";
import type { Env } from "./env";
import * as store from "./store";
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
    } catch (e) {
      // アラーム全体を落とす例外はここで吸収（個別処理は各所で catch 済み）
      console.error("alarm cycle failed:", e instanceof Error ? e.message : String(e));
    } finally {
      // 例外時もアラーム連鎖を切らさない（§9-2）
      await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
    }
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
        store.mergeState(this.sql, device.id, state, "poll", now);
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
    devices: Array<{
      device: Device;
      state: DeviceState | null;
      updatedAt: string | null;
      source: string | null;
    }>;
    rateBudget: Array<{ vendor: string; used: number; dailyLimit: number }>;
    killSwitch: boolean;
  }> {
    const states = await this.getStateRpc();
    return {
      generatedAt: jstDateTime(Date.now()),
      devices: states.map((s) => ({
        device: s.device,
        state: s.state,
        updatedAt: s.updatedAt === null ? null : jstDateTime(s.updatedAt),
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
