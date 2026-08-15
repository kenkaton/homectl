# homectl — 個人用ホームエネマネ・機器統合基盤 設計書

Claude Code への実装指示書。この文書の設計判断には全て理由があるため、
変更したい場合は理由ごと再検討すること。

---

## 1. プロジェクト概要

### 目的
SwitchBot / Nature Remo / SESAME を統合し、消費電力の可視化と
ルールベースの自動制御を行う **自分専用** のシステム。
Cloudflare Workers + Durable Objects 上で動き、Claude (MCP) から対話操作できる。

### 前提（非目標を含む）
- **単一テナント**。ユーザーは自分だけ。マネタイズしない
- 他人が使う場合は各自が自分の Cloudflare アカウントにデプロイし、
  自分でベンダーと契約してトークンを取得する（Deploy to Cloudflare ボタン配布）
- マルチテナント化・課金・ユーザー管理・ロジック共有プラットフォームは **作らない**
- モバイルアプリ・GUI ルールビルダー・設定画面・ログイン画面は **作らない**
  （認証は Cloudflare Access に任せる）

### 体験の要約
- 普段は忘れている。異常時だけ Slack に通知が来る（通知先は差し替え可能）
- ダッシュボードは読み取り専用 1 枚。**操作ボタンは置かない**
- 臨時操作と問い合わせは Claude (MCP) 経由
- 挙動変更は `/rules/*.ts` を編集して `wrangler deploy`（AI が書き、人間がレビュー）

---

## 2. アーキテクチャ

```
[Claude/MCP] [ダッシュボード(RO)] [通知(Slack等)]
      │              │                ▲
      ▼              ▼                │
┌──────────────────────────────────────┐
│ Worker (entry)                        │
│  - /mcp     MCPサーバー               │
│  - /dash    ダッシュボードHTML        │
│  - /webhook ベンダーWebhook受信       │
└──────────────┬───────────────────────┘
               ▼
┌──────────────────────────────────────┐
│ SiteDO (Durable Object / SQLite)      │
│  唯一のインスタンス idFromName("main")│
│  - 機器レジストリ・状態キャッシュ     │
│  - ルール評価（速いループ）           │
│  - API残枠管理                        │
│  - 操作ログ（説明可能性）             │
│  - 5分アラーム                        │
└──────┬───────────────────────────────┘
       │ 安全層 (safety/) を必ず経由
       ▼
┌──────────────────────────────────────┐
│ アダプタ層 adapters/                  │
│  switchbot / remo / sesame            │
│  共通インターフェイスに正規化         │
└──────┬───────────────────────────────┘
       ▼
    実機器            → Analytics Engine（テレメトリ）
```

### 中核の設計判断（変更前に必読）

| # | 判断 | 理由 |
|---|------|------|
| D1 | DO は **拠点単位で 1 個**（機器単位にしない） | エネマネ判断は合計需要に対して行う。SwitchBot の API 残枠(1日10,000回)はトークン単位なので集中管理が必須。家庭規模なら 1 DO で処理能力は十分 |
| D2 | **2 つのクロック**を分離。速いループ(5分,決定的コード) / 遅いループ(人+AIがルール改訂) | LLM を制御パスに入れると遅い・高い・非決定的・説明不能。AI はルールを書く係、実行はコード |
| D3 | 安全層はユーザールールの **下** に置き、ルールから迂回不能にする | コピーしてきたルールや AI 生成ルールが暴走しても物理的被害を防ぐ。サンドボックスでは「許可された機器の乱打」は防げない |
| D4 | 機器は **能力(capability)** でモデル化。機種名でロジックを書かない | 新機器対応が宣言 1 つで済む。ルールの再利用性が上がる |
| D5 | 能力に **フィードバック信頼度** を持たせる (`verified` / `assumed` / `inferred`) | 赤外線(Nature Remo)はオープンループ。送信≠実行。別センサーで確認する閉ループが必須で、それをデータモデルに織り込む |
| D6 | Webhook 優先、ポーリングは補助 | SwitchBot は 1 日 10,000 回 = 毎分約 7 回しかない。連続ポーリングは即死 |
| D7 | DO のアラームは **既定 5 分** | 課金は wall-clock。5分なら月約8,760回で無料枠に余裕。1分にすると5倍 |
| D8 | DO から **外向き WebSocket を保持しない** | 保持するとハイバネートできず常時課金化する。全て短命の HTTP で完結させる |
| D9 | in-memory 状態は持たない。**全状態を SQLite に置き、コンストラクタで再構築** | ハイバネーション復帰時にコンストラクタが再実行され in-memory は消える。ここは事故多発地帯 |
| D10 | 全操作を操作ログに記録（いつ・どのルール・何を根拠に・何をした・検証結果） | 「なぜ勝手に止まった？」に即答できないと自動制御は信頼されない |
| D11 | ベンダー対応は `VendorAdapter` 実装 1 ファイル＋レジストリ 1 行に閉じる。コアは vendor を文字列キーとしか扱わない | 初期 3 社に閉じない。個社差がコアに漏れると追加コストが線形以上に増える |

---

## 3. 技術スタック

- **ランタイム**: Cloudflare Workers + Durable Objects (SQLite バックエンド)
  - Workers Free で開始可（SQLite DO は Free 対応）。Paid ($5/月) 移行も視野
  - `setAlarm()` は 1 回 = 1 行書き込み課金。乱発しない
- **言語**: TypeScript。フレームワークは **Hono**
- **テレメトリ**: Workers Analytics Engine（時系列）。長期保存が必要になったら R2
- **通知**: Notifier インターフェイスで抽象化（§11）。まず Slack を実装。
  差し替え・追加は実装ファイル 1 つと環境変数の変更のみで完結させる
- **MCP**: Workers 上に MCP サーバーを実装（streamable HTTP）。Claude から接続
- **秘密情報**: すべて `wrangler secret`。コード・リポジトリに一切書かない
- **認可**: ダッシュボードと MCP は Cloudflare Access で保護（コード側は実装不要）

### wrangler.jsonc の要点

```jsonc
{
  "name": "homectl",
  "main": "src/index.ts",
  "compatibility_date": "2026-08-01",
  "durable_objects": {
    "bindings": [{ "name": "SITE", "class_name": "SiteDO" }]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["SiteDO"] }  // 必ず SQLite で作る
  ],
  "analytics_engine_datasets": [
    { "binding": "TELEMETRY", "dataset": "homectl_telemetry" }
  ]
}
```

secrets: `SWITCHBOT_TOKEN` `SWITCHBOT_SECRET` `REMO_TOKEN`
`SESAME_API_KEY` `SESAME_DEVICE_UUID` `SLACK_WEBHOOK_URL`
（vars: `NOTIFIER=slack` — 通知実装の選択スイッチ）

---

## 4. データモデル

### 能力 (capability)

```typescript
type Capability =
  | "on_off"
  | "temperature_set"      // 設定温度
  | "temperature_read"     // 温度センサー
  | "humidity_read"
  | "power_read"           // 消費電力(W)
  | "lock_state_read"
  | "curtain_position";

type Feedback = "verified" | "assumed" | "inferred";
// verified: API で実状態が取れる
// assumed : 送っただけ。実状態不明（赤外線）
// inferred: 別センサー経由で推定（via に根拠機器を持つ）

interface DeviceCapability {
  capability: Capability;
  feedback: Feedback;
  via?: string;            // inferred のとき根拠となる deviceId
}

interface Device {
  id: string;              // 内部ID（安定・自分で採番）
  vendor: string;          // アダプタID（レジストリのキー。閉じた union にしない）
  vendorDeviceId: string;  // ベンダー側ID
  name: string;            // 表示名（例: 寝室エアコン）
  room: string;
  capabilities: DeviceCapability[];
}
```

### SiteDO 内の SQLite スキーマ

```sql
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

CREATE TABLE IF NOT EXISTS kv (                -- キルスイッチ等の雑多な旗
  key TEXT PRIMARY KEY, value TEXT NOT NULL
);
```

---

## 5. アダプタ層 — ベンダー非依存設計

コア（SiteDO・ルール・安全層・MCP）は個社を知らない。個社差は
`VendorAdapter` 実装 1 ファイルに完全に閉じ込める。

### インターフェイス

```typescript
// src/adapters/types.ts
export interface VendorAdapter {
  readonly vendor: string;                 // 一意ID。Device.vendor / rate_budget のキー
  readonly rateLimit?: { perDay: number }; // 宣言すると残枠管理が自動で効く
  readonly requiredSecrets: string[];      // setup.ts が対話取得に使う

  // 機器発見。能力と feedback 信頼度の宣言はここで行う（D4/D5 の実装点）
  discoverDevices(): Promise<Omit<Device, "id" | "room">[]>;

  // 状態読み取り（対応する能力の分だけ返す）
  readState(device: Device): Promise<Record<string, unknown>>;

  // 操作。必ず安全層経由で呼ばれる
  execute(device: Device, action: Action): Promise<ExecResult>;

  // Webhook 対応ベンダーのみ。署名検証はこの中で行う
  parseWebhook?(req: Request): Promise<WebhookEvent[]>;
}
```

### レジストリ

```typescript
// src/adapters/index.ts — 有効化はここ 1 箇所のみ（明示列挙・動的読み込みしない）
export function createAdapters(env: Env): Map<string, VendorAdapter> {
  const adapters: VendorAdapter[] = [
    new SwitchBotAdapter(env),
    new RemoAdapter(env),
    new SesameAdapter(env),
  ];
  return new Map(adapters.map((a) => [a.vendor, a]));
}
```

### ルール
- コア側に個社名の分岐（`if (vendor === "switchbot")` 等）を書いたら差し戻し
- `rules/` から `adapters/` の import 禁止（ルールは能力にのみ依存。D4）
- レート制限は `rateLimit` 宣言だけで `httpWithBudget` が自動適用。未宣言は無制限扱い
- Webhook は `/webhook/:vendor` がレジストリを引いて `parseWebhook` に委譲。
  ルーティング側は無変更
- **新ベンダー追加は 3 手で完結すること**:
  `adapters/<name>.ts` を書く → レジストリに 1 行 → secrets 設定。
  3 手で済まない場合はこの節への違反であり、設計を直す

### ロングテール対応（将来・任意）
- **Home Assistant アダプタ**: HA の REST/WebSocket API を叩く 1 アダプタで、
  HA が持つ 1000+ 統合（海外製品含む）を一括で取り込める。
  個社アダプタを新規に書く前に「HA 経由で足りないか」を必ず先に検討する
- **汎用 HTTP アダプタ**: URL テンプレート＋JSONPath で読み取り/操作を
  マッピングする脱出口。対応表にない機器はユーザーがこれで繋ぐ

### 初期実装 3 社の要点

#### SwitchBot API v1.1
- Base: `https://api.switch-bot.com/v1.1`
- 認証ヘッダ 4 点セット:
  - `Authorization: {token}`
  - `t`: 13 桁ミリ秒タイムスタンプ
  - `nonce`: UUID
  - `sign`: `HMAC-SHA256(token + t + nonce, secret)` を Base64 → **大文字化**
- 主要エンドポイント:
  - `GET /devices` 機器一覧
  - `GET /devices/{id}/status` 状態
  - `POST /devices/{id}/commands` 操作
  - Webhook 登録 API あり（イベント push。温湿度計・開閉センサー等が対応）
- **1 日 10,000 回/トークン。超過は 401**。全呼び出しを rate_budget 経由にする
- 残枠 80% で通知（notifier 経由）、95% でポーリング停止（Webhook とコマンドのみ残す）

#### Nature Remo Cloud API
- Base: `https://api.nature.global`、`Authorization: Bearer {token}`
- 主要:
  - `GET /1/devices` Remo 本体センサー（温度は `newest_events.te.val`）
  - `GET /1/appliances` 登録家電
  - `POST /1/appliances/{id}/aircon_settings` エアコン
  - `POST /1/signals/{id}/send` 任意信号
  - Remo E: `GET /1/echonetlite/appliances`（スマートメーター等の EPC）
- **赤外線はオープンループ**。全 IR 操作は feedback:"assumed" とし、
  `pending_verifications` に検証タスクを積む（例: エアコンONなら
  「5分後に該当プラグ/メーターの power_read が 200W 超」を期待）
- 失敗時は 1 回だけ再送。それでも失敗なら通知して停止（無限再送禁止）

#### SESAME (CANDY HOUSE Web API)
- 施錠状態の読み取りと施錠のみ実装する
- **解錠 API は実装自体を書かない**（安全層以前にコードとして存在させない）

---

## 6. 安全層（最重要・最初に作る）

`src/safety/limits.ts` — 設定は定数。GUI 化しない。

```typescript
export const LIMITS = {
  ac: {
    minSetTemp: 20,
    maxSetTemp: 30,
    maxOpsPerHour: 6,        // コンプレッサ保護
  },
  global: {
    maxOpsPerDevicePerHour: 12,
    killSwitchKey: "kill_switch",  // kv テーブル。"on" で全操作拒否
  },
  lock: {
    allowUnlock: false as const,   // 型レベルで false 固定
  },
} as const;
```

`src/safety/enforce.ts` — 全ての機器操作はこの関数を **必ず** 通る。
アダプタを直接呼ぶコードパスを作らないこと（ESLint ルールで
`adapters/*` の import を `safety/` と `SiteDO` 内部のみに制限する）。

チェック順: キルスイッチ → 機器別頻度 → 能力別制約 → 実行 → 操作ログ記録
→ (assumed なら) 検証タスク登録。ブロック時も操作ログに `blocked:<理由>` で残す。

---

## 7. ルールエンジン

### ルールの形

```typescript
// rules/peak-shaving.ts
import { defineRule } from "../src/rules/types";

export default defineRule({
  id: "peak-shaving",
  description: "合計3kW超でエアコンを1度上げる（上限28度）",
  cooldownMinutes: 15,               // 再発動抑止
  condition: (ctx) => ctx.totalPowerW() > 3000,
  action: async (ctx) => {
    const ac = ctx.device("bedroom-ac");
    const cur = ctx.state(ac).setTemp ?? 26;
    if (cur < 28) await ctx.setTemperature(ac, cur + 1);
  },
});
```

### 制約
- ルール内から `fetch` 禁止・LLM 呼び出し禁止・乱数と現在時刻は ctx 経由
  （決定的にし、テストで再現可能にする）
- `ctx` の操作系は全て安全層経由の薄いラッパー
- ルールは `rules/index.ts` で明示的に配列 export（動的読み込みしない）
- 例外は握り潰さず通知（notifier 経由）。当該ルールのみ次回まで skip、他は継続

### 評価タイミング
- 5 分アラームごと + Webhook 受信直後（該当 room のルールのみ）

---

## 8. ディレクトリ構成

```
homectl/
├── wrangler.jsonc
├── DESIGN.md                 # 本書
├── README.md                 # セットアップ手順・Deployボタン
├── scripts/
│   └── setup.ts              # 対話式: トークンを聞いて wrangler secret put
├── rules/
│   ├── index.ts              # ルール登録（明示列挙）
│   └── *.ts
├── src/
│   ├── index.ts              # Hono: /mcp /dash /webhook/:vendor
│   ├── site-do.ts            # SiteDO 本体
│   ├── safety/
│   │   ├── limits.ts
│   │   └── enforce.ts
│   ├── adapters/
│   │   ├── types.ts          # VendorAdapter・Action 等の型
│   │   ├── index.ts          # レジストリ（有効アダプタの明示列挙）
│   │   ├── switchbot.ts
│   │   ├── remo.ts
│   │   └── sesame.ts
│   ├── rules/
│   │   ├── types.ts          # defineRule / RuleContext
│   │   └── engine.ts
│   ├── mcp/
│   │   └── server.ts
│   ├── telemetry.ts          # Analytics Engine 書き込み
│   ├── notify/
│   │   ├── types.ts          # Notifier インターフェイス・イベント型
│   │   ├── index.ts          # env.NOTIFIER による実装選択（factory）
│   │   └── slack.ts          # Slack Incoming Webhook 実装
│   └── dash/
│       └── page.ts           # 読み取り専用HTML（1ファイル・依存なし）
└── test/
    ├── engine.test.ts
    ├── safety.test.ts        # 境界値: 上下限ちょうど・跨ぎ・頻度制限
    └── hibernation.test.ts   # コンストラクタ再構築の検証
```

---

## 9. SiteDO 実装上の注意（ハイバネーション対策）

1. **コンストラクタで SQLite から全て再構築**する。インスタンスフィールドは
   キャッシュに過ぎず、いつ消えても正しく動くこと
2. アラームハンドラ冒頭で `ensureNextAlarm()`（次回 5 分後を必ず張り直す。
   例外時もアラーム連鎖が切れないよう try/finally）
3. 外向き WebSocket・長時間 sleep・`setInterval` は使わない
4. 検証タスク (`pending_verifications`) はアラームごとに期限到来分だけ処理
5. テスト: `hibernation.test.ts` で「状態設定 → DO 再生成（コンストラクタ再実行）
   → 同じ判断が再現される」ことを必ず検証する

---

## 10. MCP サーバー

公開ツール（すべて SiteDO への RPC）:

| tool | 説明 |
|---|---|
| `list_devices` | 機器一覧（能力・信頼度込み） |
| `get_state` | 指定機器 or 全機器の最新状態とその取得時刻・取得元 |
| `get_power_history` | 期間指定の消費電力集計（Analytics Engine を SQL API で照会） |
| `set_state` | 操作。**安全層経由**。結果に blocked 理由も返す |
| `explain_recent_actions` | 直近の operation_log を人間可読に整形して返す |
| `get_rate_budget` | ベンダー別の本日残枠 |
| `set_kill_switch` | on/off |

- 解錠に相当するツールは定義しない
- `set_state` の応答には必ず「安全層の判定結果」を含め、Claude が
  ユーザーに理由を説明できるようにする

---

## 11. テレメトリと通知

### Analytics Engine（5 分ごと）
- blobs: [device_id, room, vendor], doubles: [powerW, tempC, humidity]
- ダッシュボードと `get_power_history` は SQL API で読む

### 通知（異常時のみ。日次サマリーは送らない）

通知先は差し替え可能にする。呼び出し側は具象実装を一切知らない。

```typescript
// src/notify/types.ts
export type NotifyLevel = "warn" | "alert";

export interface NotifyEvent {
  level: NotifyLevel;
  kind: "device_offline" | "rate_budget" | "rule_error"
      | "verification_failed" | "kill_switch";
  title: string;          // 1 行要約
  detail?: string;        // 補足（実測値・閾値など）
  deviceId?: string;
}

export interface Notifier {
  send(event: NotifyEvent): Promise<void>;
}
```

```typescript
// src/notify/index.ts — 実装選択はここ 1 箇所のみ
export function createNotifier(env: Env): Notifier {
  switch (env.NOTIFIER) {
    case "slack": return new SlackNotifier(env.SLACK_WEBHOOK_URL);
    default:      return new ConsoleNotifier();  // 未設定時も落とさない
  }
}
```

ルール:
- 呼び出し側（SiteDO・engine・enforce）は `Notifier` 型のみ import。
  `slack.ts` 等の具象を直接 import したらレビューで差し戻し
- メッセージの整形（Slack の Block Kit 等）は具象実装の内部に閉じる。
  イベント型にベンダー固有の構造を漏らさない
- `send()` の失敗でメインロジックを止めない（try/catch + console.error）。
  通知は best-effort
- 別サービス追加の手順は「`notify/<name>.ts` を書く → factory に 1 行足す →
  vars/secret を設定」の 3 手で完結すること

**Slack 実装（初期）**: Incoming Webhook に POST。level に応じて
絵文字プレフィックス（warn: ⚠️ / alert: 🚨）。detail はコードブロックで添付

対象イベント:
- 機器が 2 時間応答なし (`device_offline`, warn)
- rate_budget 80% (warn) / 95% (alert)
- ルール例外 (`rule_error`, alert)
- IR 検証失敗＝送ったのに効いていない (`verification_failed`, alert)
- キルスイッチ操作 (`kill_switch`, alert)

---

## 12. 実装フェーズ

各フェーズは独立して動作確認できる単位。**順番を守る**（特に安全層が
機器操作より先）。

- **Phase 1: 骨格 + 読み取り**
  Hono 雛形 / SiteDO(SQLite スキーマ・5 分アラーム) /
  アダプタ層の型と レジストリ / SwitchBot アダプタの read 系のみ /
  rate_budget / 状態が JSON で見える `/dash`
  → 完了条件: 温湿度が 5 分ごとに state_cache に入る
- **Phase 2: テレメトリ + ダッシュボード**
  Analytics Engine 書き込み / 読み取り専用グラフ 1 枚
  → 完了条件: 24 時間分の温度グラフが見える
- **Phase 3: 安全層 + ルールエンジン（操作はまだ 1 機器）**
  limits/enforce / engine / hibernation・safety テスト /
  Nature Remo アダプタ + エアコン制御 1 本 + IR 閉ループ検証 /
  notify 層（types + factory + Slack 実装）
  → 完了条件: peak-shaving 相当が動き、operation_log で説明できる
- **Phase 4: MCP**
  server.ts / 全ツール / Claude から接続確認
  → 完了条件: Claude に「なんで 15 時に止まった？」と聞いて答えが返る
- **Phase 5: 残りアダプタ**
  SESAME(施錠と状態のみ) / SwitchBot Webhook 受信 / ポーリング間引き
- **Phase 6: 配布**
  scripts/setup.ts / README / Deploy to Cloudflare ボタン

---

## 13. コーディング規約

- 全ベンダー呼び出しは共通の `httpWithBudget(vendor, req)` を経由
  （残枠カウント・タイムアウト 10s・リトライは冪等 GET のみ 1 回）
- 時刻は全て epoch ms で保存、表示時のみ JST 変換
- `any` 禁止。ベンダー応答は zod でパースしてから使う
- 秘密情報を console.log しない（トークンの部分文字列も不可）
- 依存は最小限: hono, zod のみを基本とする
- コミット単位はフェーズ内の完了条件ごと

## 14. 明示的にやらないこと（再掲・実装中に迷ったらここへ戻る）

- 解錠機能（コードごと書かない）
- LLM をルールの condition/action 内から呼ぶこと
- ダッシュボードへの操作ボタン設置
- マルチテナント対応の「将来のための抽象化」
- 機器単位の DO 分割
- DO からの常時接続保持
