// Worker entry — Hono: /mcp /dash /webhook/:vendor（§2）。
// 認可は Cloudflare Access に任せる（コード側は実装しない）。
// Webhook 経路だけは Access を外す運用のため、WEBHOOK_KEY による共有鍵チェックを持つ。
import { Hono } from "hono";
import type { Env } from "./env";

const app = new Hono<{ Bindings: Env }>();

function site(env: Env) {
  return env.SITE.get(env.SITE.idFromName("main")); // 唯一のインスタンス（D1）
}

app.get("/", (c) => c.redirect("/dash"));

// Phase 1: 状態が JSON で見える /dash（Phase 2 で読み取り専用 HTML に置き換え）
app.get("/dash", async (c) => c.json(await site(c.env).dashData()));

app.get("/dash/data.json", async (c) => c.json(await site(c.env).dashData()));

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
