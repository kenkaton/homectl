# homectl

SwitchBot / Nature Remo / SESAME を統合し、消費電力の可視化とルールベースの自動制御を行う
**自分専用**のホームエネマネ基盤。Cloudflare Workers + Durable Objects (SQLite) 上で動き、
Claude (MCP) から対話操作できる。

設計と設計判断の理由は [DESIGN.md](./DESIGN.md)（実装より先にこちらを読む）。

- 普段は忘れている。異常時だけ通知が来る（Slack / 差し替え可能）
- ダッシュボードは読み取り専用 1 枚。操作ボタンはない
- 臨時操作と問い合わせは Claude (MCP) 経由
- 挙動変更は `rules/*.ts` を編集して `wrangler deploy`（AI が書き、人間がレビュー）

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/kenkaton/homectl)

## セットアップ

前提: Cloudflare アカウント（Workers Free で可）と、使うベンダーの開発者トークン。

```sh
npm install
npx wrangler login
npm run setup        # 対話式: トークンを聞いて wrangler secret put する
npx wrangler deploy
```

デプロイ後、`https://<worker>.<subdomain>.workers.dev/dash` を一度開く（SiteDO と
5 分アラームが起動し、24 時間以内に機器が自動発見される。初回は数分で state_cache に入る）。

### secrets 一覧

| secret | 用途 | 必須 |
|---|---|---|
| `SWITCHBOT_TOKEN` / `SWITCHBOT_SECRET` | SwitchBot API v1.1 | 使うなら必須 |
| `REMO_TOKEN` | Nature Remo Cloud API | 使うなら必須 |
| `SESAME_API_KEY` / `SESAME_DEVICE_UUID` | SESAME 状態読み取り | 使うなら必須 |
| `SESAME_SECRET_KEY` | SESAME 施錠コマンドの署名 | 施錠を使うなら |
| `SLACK_WEBHOOK_URL` | 通知（`NOTIFIER=slack` 時） | 任意 |
| `WEBHOOK_KEY` | `/webhook/:vendor?key=` の共有鍵 | 推奨 |
| `CF_ACCOUNT_ID` / `CF_ANALYTICS_TOKEN` | Analytics Engine SQL API（履歴グラフ・get_power_history） | 任意 |

設定していないベンダーのアダプタは自動的に無効になる（コード変更不要）。

### 認可（Cloudflare Access）

ダッシュボードと MCP はコード側に認証がない。**Cloudflare Access で保護すること**:

1. Zero Trust → Access → Applications で `<worker ドメイン>` を追加
2. `/dash*` と `/mcp` を自分のメールだけ許可
3. `/webhook/*` は Service Auth ないしバイパスにして、代わりに `WEBHOOK_KEY` で守る

### SwitchBot Webhook（ポーリング補助・推奨）

SwitchBot はレート制限が厳しい（10,000 回/日）ため Webhook を優先する:

```sh
# 認証ヘッダの作り方は DESIGN.md §5 参照（token/sign/t/nonce）
curl -X POST https://api.switch-bot.com/v1.1/webhook/setupWebhook \
  -H "Authorization: $TOKEN" -H "sign: $SIGN" -H "t: $T" -H "nonce: $NONCE" \
  -H "Content-Type: application/json" \
  -d '{"action":"setupWebhook","url":"https://<worker>/webhook/switchbot?key=<WEBHOOK_KEY>","deviceList":"ALL"}'
```

受信すると即座に state_cache が更新され、該当部屋のルールが評価される。
新鮮なデータがある機器はポーリングが自動で間引かれる。

### Claude (MCP) から使う

Claude の MCP サーバー設定に `https://<worker>/mcp`（streamable HTTP）を追加する。
Access で保護している場合は Service Token を発行してヘッダを設定する。

ツール: `list_devices` / `get_state` / `get_power_history` / `set_state`（安全層経由・
blocked 理由つき）/ `explain_recent_actions` / `get_rate_budget` / `set_kill_switch` /
`update_device`。**解錠に相当するツールは存在しない。**

デプロイ直後にやると良い機器整理（Claude に頼む）:

- 「寝室のエアコンの名前を bedroom-ac、部屋を bedroom にして」（`update_device`）
- 「bedroom-ac の on_off を inferred にして、根拠機器はエアコンのプラグ」
  → 以後、IR 操作の 5 分後にプラグの実測電力で効いたか自動検証される（D5 の閉ループ）

## ルールを書く

```ts
// rules/night-lock.ts
import { defineRule } from "../src/rules/types";

export default defineRule({
  id: "night-lock",
  description: "23時以降に解錠されていたら施錠する",
  cooldownMinutes: 30,
  condition: (ctx) => {
    const jstHour = Math.floor(((ctx.now() + 9 * 3600e3) % 86400e3) / 3600e3);
    return jstHour >= 23 && ctx.state("玄関 SESAME").locked === false;
  },
  action: async (ctx) => {
    await ctx.lock(ctx.device("玄関 SESAME"));
  },
});
```

`rules/index.ts` の配列に 1 行足して `npx wrangler deploy`。

制約（ESLint でも強制）: ルールからの `fetch`・`Date`・`Math.random` は禁止
（時刻・乱数は `ctx` 経由）。機器は能力（capability）だけに依存し、ベンダーを知らない。
全操作は安全層（`src/safety/limits.ts` の定数）を迂回できない。

## 運用

- **キルスイッチ**: Claude に「キルスイッチ入れて」(`set_kill_switch`)。全操作が
  `blocked:kill_switch` になる。ダッシュボードにもバナーが出る
- **「なんで勝手に止まった?」**: Claude に聞く → `explain_recent_actions` が
  いつ・どのルールが・何を根拠に・何をして・検証がどうだったかを返す
- **通知**: 機器 2 時間無応答 / API 残枠 80%・95% / ルール例外 / IR 検証失敗 /
  キルスイッチ操作 — の異常時のみ。日次サマリーは送らない
- **通知先の差し替え**: `src/notify/<name>.ts` を書く → `src/notify/index.ts` に 1 行 →
  `NOTIFIER` var と secret を設定（3 手で完結）
- **新ベンダー対応**: `src/adapters/<name>.ts` を書く → レジストリに 1 行 → secrets 設定
  （3 手で完結）。先に Home Assistant 経由で足りないか検討すること（DESIGN.md §5）

## 開発

```sh
npm test            # vitest (workerd 上で実 DO・実 SQLite を使う)
npm run typecheck   # tsc --noEmit
npm run lint        # アーキテクチャ境界（アダプタ直import禁止等）も lint で強制
npx wrangler dev    # ローカル起動
```

## ライセンス / 免責

個人用。自分の責任で自分の家にだけ使うこと。
