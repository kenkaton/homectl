// Worker entry — Hono: /mcp /dash /webhook/:vendor（§2）。
// 認可は Cloudflare Access に任せる（コード側は実装しない）。
// Webhook 経路だけは Access を外す運用のため、WEBHOOK_KEY による共有鍵チェックを持つ。
import { Hono } from "hono";
import type { Env } from "./env";
import { dashPage } from "./dash/page";
import { queryHistory } from "./analytics";
import { handleMcp } from "./mcp/server";

const app = new Hono<{ Bindings: Env }>();

function site(env: Env) {
  return env.SITE.get(env.SITE.idFromName("main")); // 唯一のインスタンス（D1）
}

app.get("/", (c) => c.redirect("/dash"));

// 読み取り専用ダッシュボード（操作ボタンなし。§14）
app.get("/dash", (c) => c.html(dashPage()));

app.get("/dash/data.json", async (c) => c.json(await site(c.env).dashData()));

app.get("/dash/history.json", async (c) => {
  const hours = Number(c.req.query("hours") ?? "24") || 24;
  return c.json(await queryHistory(c.env, { hours }));
});

// ベンダー Webhook 受信。パースは SiteDO 内のアダプタレジストリに委譲（Phase 5 で有効化）
app.post("/webhook/:vendor", async (c) => {
  if (c.env.WEBHOOK_KEY && c.req.query("key") !== c.env.WEBHOOK_KEY) {
    return c.text("forbidden", 403);
  }
  return site(c.env).fetch(c.req.raw);
});

// MCP サーバー（streamable HTTP。認可は Cloudflare Access に任せる）
app.all("/mcp", (c) => handleMcp(c.req.raw, c.env));

export default app;
export { SiteDO } from "./site-do";
