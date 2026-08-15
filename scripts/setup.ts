// 対話式セットアップ: 各アダプタが宣言する requiredSecrets / optionalSecrets を聞いて
// `wrangler secret put` に流し込む（§8）。新ベンダー追加時にこのファイルの変更は不要 —
// レジストリ（src/adapters/index.ts）の宣言だけで質問が増える。
// 実行: npm run setup   （事前に `npx wrangler login` を済ませておく）
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";
import { createAdapters } from "../src/adapters/index";
import type { Env } from "../src/env";

// 行キュー方式の入力（TTY でもパイプでも取りこぼさない。EOF 以降は全てスキップ扱い）
const pending: string[] = [];
let waiter: ((line: string) => void) | null = null;
let eof = false;
const rl = createInterface({ input: stdin });
rl.on("line", (line) => {
  if (waiter) {
    const w = waiter;
    waiter = null;
    w(line);
  } else {
    pending.push(line);
  }
});
rl.on("close", () => {
  eof = true;
  if (waiter) {
    const w = waiter;
    waiter = null;
    w("");
  }
});

function readAnswer(): Promise<string> {
  const buffered = pending.shift();
  if (buffered !== undefined) return Promise.resolve(buffered);
  if (eof) return Promise.resolve("");
  return new Promise((resolve) => {
    waiter = resolve;
  });
}

// 通知・配布まわりの追加 secret（アダプタ非依存のもの）
const EXTRA_SECRETS: Array<{ name: string; note: string }> = [
  { name: "SLACK_WEBHOOK_URL", note: "Slack Incoming Webhook URL（通知先。未設定なら console のみ）" },
  { name: "WEBHOOK_KEY", note: "ベンダー Webhook 受信 URL の共有鍵 ?key=（推奨: ランダム文字列）" },
  { name: "CF_ACCOUNT_ID", note: "Analytics Engine SQL API 用アカウントID（履歴グラフに必要）" },
  { name: "CF_ANALYTICS_TOKEN", note: "Analytics 読み取り権限の API トークン（履歴グラフに必要）" },
];

function putSecret(name: string, value: string): boolean {
  const res = spawnSync("npx", ["wrangler", "secret", "put", name], {
    input: value,
    stdio: ["pipe", "inherit", "inherit"],
  });
  return res.status === 0;
}

async function ask(name: string, note: string): Promise<void> {
  stdout.write(`  ${name}（空 Enter でスキップ）\n    ${note}\n  > `);
  const value = (await readAnswer()).trim();
  if (!value) {
    console.log(`  ... ${name} はスキップ\n`);
    return;
  }
  if (!putSecret(name, value)) {
    console.error(`  !!! ${name} の設定に失敗（wrangler login 済みか確認）`);
  }
  console.log("");
}

async function main(): Promise<void> {
  console.log("homectl セットアップ — 各ベンダーのトークンを wrangler secret として保存します。");
  console.log("契約していないベンダーは空 Enter でスキップしてください（アダプタは自動で無効になります）。\n");

  // ダミー env でアダプタを列挙（コンストラクタは secret を読まない）
  const adapters = createAdapters({} as Env);
  for (const adapter of adapters.values()) {
    console.log(`■ ${adapter.vendor}`);
    for (const name of adapter.requiredSecrets) {
      await ask(name, `${adapter.vendor} の必須 secret`);
    }
    for (const name of adapter.optionalSecrets ?? []) {
      await ask(name, `${adapter.vendor} の任意 secret（一部機能にのみ必要）`);
    }
  }

  console.log("■ 通知・ダッシュボード");
  for (const s of EXTRA_SECRETS) {
    await ask(s.name, s.note);
  }

  rl.close();
  console.log(`完了。次の手順:
  1. npx wrangler deploy
  2. https://<worker>/dash を一度開く（SiteDO と 5 分アラームが起動する）
  3. Cloudflare Access で /dash と /mcp を保護し、/webhook/* だけバイパスさせる
  4. (SwitchBot) Webhook を登録: README の「SwitchBot Webhook」参照
  5. Claude に MCP サーバー https://<worker>/mcp を追加`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
