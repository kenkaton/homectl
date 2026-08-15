// Worker entry — Hono: /mcp /dash /webhook/:vendor（§2）。
// 認可は Cloudflare Access に任せる（コード側は実装しない）。
// Webhook 経路だけは Access を外す運用のため、WEBHOOK_KEY による共有鍵チェックを持つ。
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "./env";
import { dashPage } from "./dash/page";

const app = new Hono<{ Bindings: Env }>();

function site(env: Env) {
  return env.SITE.get(env.SITE.idFromName("main")); // 唯一のインスタンス（D1）
}

app.get("/", (c) => c.redirect("/dash"));

// 読み取り専用ダッシュボード（操作ボタンなし。§14）
app.get("/dash", (c) => c.html(dashPage()));

app.get("/dash/data.json", async (c) => c.json(await site(c.env).dashData()));

// Analytics Engine SQL API（未設定なら degrade — 落とさない）
const analyticsRowSchema = z.object({
  t: z.coerce.number(),
  device_id: z.string(),
  powerW: z.coerce.number(),
  tempC: z.coerce.number(),
  humidity: z.coerce.number(),
});
const analyticsResponseSchema = z.object({ data: z.array(analyticsRowSchema) });

app.get("/dash/history.json", async (c) => {
  const { CF_ACCOUNT_ID, CF_ANALYTICS_TOKEN } = c.env;
  if (!CF_ACCOUNT_ID || !CF_ANALYTICS_TOKEN) {
    return c.json({ configured: false, rows: [] });
  }
  const hours = Math.min(168, Math.max(1, Number(c.req.query("hours") ?? "24") || 24));
  // _sample_interval 加重平均（サンプリングが起きても正しい平均になる）
  const query = `
    SELECT
      toUnixTimestamp(toStartOfInterval(timestamp, INTERVAL '10' MINUTE)) AS t,
      blob1 AS device_id,
      sum(double1 * _sample_interval) / sum(_sample_interval) AS powerW,
      sum(double2 * _sample_interval) / sum(_sample_interval) AS tempC,
      sum(double3 * _sample_interval) / sum(_sample_interval) AS humidity
    FROM homectl_telemetry
    WHERE timestamp > NOW() - INTERVAL '${hours}' HOUR
    GROUP BY t, device_id
    ORDER BY t
    FORMAT JSON`;
  try {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/analytics_engine/sql`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${CF_ANALYTICS_TOKEN}` },
        body: query,
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!res.ok) {
      return c.json({ configured: true, error: `SQL API HTTP ${res.status}`, rows: [] });
    }
    const parsed = analyticsResponseSchema.safeParse(await res.json());
    if (!parsed.success) {
      return c.json({ configured: true, error: "SQL API 応答のパースに失敗", rows: [] });
    }
    return c.json({ configured: true, rows: parsed.data.data });
  } catch (e) {
    return c.json({ configured: true, error: e instanceof Error ? e.message : "fetch failed", rows: [] });
  }
});

// ベンダー Webhook 受信。パースは SiteDO 内のアダプタレジストリに委譲（Phase 5 で有効化）
app.post("/webhook/:vendor", async (c) => {
  if (c.env.WEBHOOK_KEY && c.req.query("key") !== c.env.WEBHOOK_KEY) {
    return c.text("forbidden", 403);
  }
  return site(c.env).fetch(c.req.raw);
});

// MCP サーバー（Phase 4 で実装）
app.all("/mcp", (c) => c.text("MCP server not implemented yet", 501));

export default app;
export { SiteDO } from "./site-do";
