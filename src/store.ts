// SiteDO の SQLite に対する薄いヘルパ群。
// D9: 判断に使う状態はすべてここ（SQLite）にあり、in-memory には持たない。
import { z } from "zod";
import type { Device, DeviceState } from "./adapters/types";

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  vendor TEXT NOT NULL,
  vendor_device_id TEXT NOT NULL,
  name TEXT NOT NULL,
  room TEXT NOT NULL,
  capabilities TEXT NOT NULL          -- JSON
);

CREATE TABLE IF NOT EXISTS state_cache (
  device_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,                -- JSON（能力ごとの最新値）
  updated_at INTEGER NOT NULL,
  source TEXT NOT NULL                -- 'webhook' | 'poll' | 'command'
);

CREATE TABLE IF NOT EXISTS rate_budget (
  vendor TEXT PRIMARY KEY,
  day TEXT NOT NULL,                  -- 'YYYY-MM-DD' (JST)
  used INTEGER NOT NULL,
  daily_limit INTEGER NOT NULL        -- アダプタの rateLimit 宣言から転記
);

CREATE TABLE IF NOT EXISTS operation_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  actor TEXT NOT NULL,                -- 'rule:<id>' | 'mcp' | 'system'
  device_id TEXT,
  action TEXT NOT NULL,               -- JSON
  reason TEXT NOT NULL,               -- 発動根拠（閾値・実測値を含む文字列）
  result TEXT NOT NULL,               -- 'ok' | 'blocked:<why>' | 'error:<msg>'
  verification TEXT                   -- 閉ループ検証の結果。'pending'→後で更新
);

CREATE TABLE IF NOT EXISTS pending_verifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  op_log_id INTEGER NOT NULL,
  device_id TEXT NOT NULL,
  check_after INTEGER NOT NULL,       -- この時刻以降のアラームで検証
  expect TEXT NOT NULL                -- JSON: { via, metric, op, value }
);

CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY, value TEXT NOT NULL
);
`;

export function initSchema(sql: SqlStorage): void {
  sql.exec(SCHEMA);
}

// ---- kv ----

export function getKv(sql: SqlStorage, key: string): string | null {
  const rows = sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = ?", key).toArray();
  return rows[0]?.value ?? null;
}

export function setKv(sql: SqlStorage, key: string, value: string): void {
  sql.exec(
    "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    key,
    value,
  );
}

export function delKv(sql: SqlStorage, key: string): void {
  sql.exec("DELETE FROM kv WHERE key = ?", key);
}

// ---- devices ----

const capabilitySchema = z.object({
  capability: z.enum([
    "on_off",
    "temperature_set",
    "temperature_read",
    "humidity_read",
    "power_read",
    "lock_state_read",
    "curtain_position",
  ]),
  feedback: z.enum(["verified", "assumed", "inferred"]),
  via: z.string().optional(),
});

const capabilitiesSchema = z.array(capabilitySchema);

interface DeviceRow {
  id: string;
  vendor: string;
  vendor_device_id: string;
  name: string;
  room: string;
  capabilities: string;
  [key: string]: SqlStorageValue;
}

export function rowToDevice(row: DeviceRow): Device {
  const parsed = capabilitiesSchema.safeParse(JSON.parse(row.capabilities));
  return {
    id: row.id,
    vendor: row.vendor,
    vendorDeviceId: row.vendor_device_id,
    name: row.name,
    room: row.room,
    capabilities: parsed.success ? parsed.data : [],
  };
}

export function listDevices(sql: SqlStorage): Device[] {
  return sql.exec<DeviceRow>("SELECT * FROM devices ORDER BY room, name").toArray().map(rowToDevice);
}

export function getDevice(sql: SqlStorage, idOrName: string): Device | null {
  const rows = sql
    .exec<DeviceRow>("SELECT * FROM devices WHERE id = ? OR name = ? LIMIT 1", idOrName, idOrName)
    .toArray();
  const row = rows[0];
  return row ? rowToDevice(row) : null;
}

/** 発見済み機器の登録。既存行の name/room/capabilities は上書きしない（ユーザーの整理を保持） */
export function upsertDiscoveredDevice(
  sql: SqlStorage,
  d: Omit<Device, "id" | "room">,
): { id: string; inserted: boolean } {
  const id = `${d.vendor}:${d.vendorDeviceId}`;
  const exists = sql.exec("SELECT 1 FROM devices WHERE id = ?", id).toArray().length > 0;
  if (!exists) {
    sql.exec(
      "INSERT INTO devices (id, vendor, vendor_device_id, name, room, capabilities) VALUES (?, ?, ?, ?, ?, ?)",
      id,
      d.vendor,
      d.vendorDeviceId,
      d.name,
      "unassigned",
      JSON.stringify(d.capabilities),
    );
  }
  return { id, inserted: !exists };
}

// ---- state_cache ----

export interface CachedState {
  deviceId: string;
  state: DeviceState;
  updatedAt: number;
  source: string;
}

export function getCachedState(sql: SqlStorage, deviceId: string): CachedState | null {
  const rows = sql
    .exec<{ state: string; updated_at: number; source: string }>(
      "SELECT state, updated_at, source FROM state_cache WHERE device_id = ?",
      deviceId,
    )
    .toArray();
  const row = rows[0];
  if (!row) return null;
  return {
    deviceId,
    state: parseState(row.state),
    updatedAt: row.updated_at,
    source: row.source,
  };
}

export function allCachedStates(sql: SqlStorage): CachedState[] {
  return sql
    .exec<{ device_id: string; state: string; updated_at: number; source: string }>(
      "SELECT device_id, state, updated_at, source FROM state_cache",
    )
    .toArray()
    .map((r) => ({
      deviceId: r.device_id,
      state: parseState(r.state),
      updatedAt: r.updated_at,
      source: r.source,
    }));
}

/** 部分更新をマージして保存（webhook は部分的な状態しか運ばないため） */
export function mergeState(
  sql: SqlStorage,
  deviceId: string,
  partial: DeviceState,
  source: "webhook" | "poll" | "command",
  now: number,
): DeviceState {
  const prev = getCachedState(sql, deviceId)?.state ?? {};
  const merged = { ...prev, ...partial };
  sql.exec(
    `INSERT INTO state_cache (device_id, state, updated_at, source) VALUES (?, ?, ?, ?)
     ON CONFLICT(device_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at, source = excluded.source`,
    deviceId,
    JSON.stringify(merged),
    now,
    source,
  );
  return merged;
}

function parseState(json: string): DeviceState {
  try {
    const v: unknown = JSON.parse(json);
    if (v !== null && typeof v === "object" && !Array.isArray(v)) return v as DeviceState;
  } catch {
    // 壊れたキャッシュは空として扱う（次のポーリングで復元される）
  }
  return {};
}
