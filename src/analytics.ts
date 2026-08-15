// Analytics Engine SQL API の照会（ダッシュボードと MCP get_power_history が共用。§11）。
// CF_ACCOUNT_ID / CF_ANALYTICS_TOKEN 未設定なら configured:false で degrade（落とさない）。
import { z } from "zod";
import type { Env } from "./env";

const rowSchema = z.object({
  t: z.coerce.number(), // バケット開始 (unix 秒)
  device_id: z.string(),
  powerW: z.coerce.number(),
  tempC: z.coerce.number(),
  humidity: z.coerce.number(),
});
const responseSchema = z.object({ data: z.array(rowSchema) });

export type HistoryRow = z.infer<typeof rowSchema>;

export interface HistoryResult {
  configured: boolean;
  error?: string;
  intervalMinutes: number;
  rows: HistoryRow[];
}

/** 期間に応じてバケット幅を選ぶ（行数を抑える） */
function intervalFor(hours: number): number {
  if (hours <= 24) return 10;
  if (hours <= 72) return 30;
  return 60;
}

export async function queryHistory(env: Env, opts: { hours: number; deviceId?: string }): Promise<HistoryResult> {
  const hours = Math.min(168, Math.max(1, Math.floor(opts.hours) || 24));
  const interval = intervalFor(hours);
  if (!env.CF_ACCOUNT_ID || !env.CF_ANALYTICS_TOKEN) {
    return { configured: false, intervalMinutes: interval, rows: [] };
  }
  // blob1(device_id) は利用者由来の文字列になり得るため '' エスケープする
  const deviceFilter = opts.deviceId ? ` AND blob1 = '${opts.deviceId.replaceAll("'", "''")}'` : "";
  // _sample_interval 加重平均（サンプリングが起きても正しい平均になる）
  const query = `
    SELECT
      toUnixTimestamp(toStartOfInterval(timestamp, INTERVAL '${interval}' MINUTE)) AS t,
      blob1 AS device_id,
      sum(double1 * _sample_interval) / sum(_sample_interval) AS powerW,
      sum(double2 * _sample_interval) / sum(_sample_interval) AS tempC,
      sum(double3 * _sample_interval) / sum(_sample_interval) AS humidity
    FROM homectl_telemetry
    WHERE timestamp > NOW() - INTERVAL '${hours}' HOUR${deviceFilter}
    GROUP BY t, device_id
    ORDER BY t
    FORMAT JSON`;
  try {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}` },
        body: query,
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!res.ok) {
      return { configured: true, error: `SQL API HTTP ${res.status}`, intervalMinutes: interval, rows: [] };
    }
    const parsed = responseSchema.safeParse(await res.json());
    if (!parsed.success) {
      return { configured: true, error: "SQL API 応答のパースに失敗", intervalMinutes: interval, rows: [] };
    }
    return { configured: true, intervalMinutes: interval, rows: parsed.data.data };
  } catch (e) {
    return {
      configured: true,
      error: e instanceof Error ? e.message : "fetch failed",
      intervalMinutes: interval,
      rows: [],
    };
  }
}
