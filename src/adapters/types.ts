// アダプタ層の共通型。コアはここにある型（と vendor 文字列キー）しか知らない（D11）。

export type Capability =
  | "on_off"
  | "temperature_set" // 設定温度
  | "temperature_read" // 温度センサー
  | "humidity_read"
  | "power_read" // 消費電力(W)
  | "lock_state_read"
  | "curtain_position";

export type Feedback = "verified" | "assumed" | "inferred";
// verified: API で実状態が取れる
// assumed : 送っただけ。実状態不明（赤外線）
// inferred: 別センサー経由で推定（via に根拠機器を持つ）

export interface DeviceCapability {
  capability: Capability;
  feedback: Feedback;
  via?: string; // inferred のとき根拠となる deviceId
}

export interface Device {
  id: string; // 内部ID（安定・自分で採番）
  vendor: string; // アダプタID（レジストリのキー。閉じた union にしない）
  vendorDeviceId: string; // ベンダー側ID
  name: string; // 表示名（例: 寝室エアコン）
  room: string;
  capabilities: DeviceCapability[];
}

// 機器への操作。解錠(unlock)はここに存在しない — 型レベルで作らない（§14）。
export type Action =
  | { type: "on_off"; value: boolean }
  | { type: "temperature_set"; value: number }
  | { type: "curtain_position"; value: number } // 0-100 (100=全開)
  | { type: "lock" };

export interface ExecResult {
  ok: boolean;
  error?: string;
  // 実行後にベンダー応答から判明した状態（あれば state_cache にマージされる）
  newState?: DeviceState;
}

// state_cache に入る正規化済み状態。能力→キーの対応:
//   on_off→power / temperature_set→setTemp / temperature_read→temperature
//   humidity_read→humidity / power_read→powerW / lock_state_read→locked
//   curtain_position→curtainPos
// 値は JSON スカラーに限定（RPC 境界でそのまま運べる形に保つ）
export type StateValue = string | number | boolean | null;
export interface DeviceState {
  power?: "on" | "off";
  setTemp?: number;
  temperature?: number;
  humidity?: number;
  powerW?: number;
  locked?: boolean;
  curtainPos?: number;
  [extra: string]: StateValue | undefined; // ベンダー付随情報（battery 等）。ルールは既知キーのみ使う
}

export interface WebhookEvent {
  vendorDeviceId: string;
  state: DeviceState; // 部分更新（届いた分だけ）
  ts: number; // epoch ms
}

// 全ベンダー呼び出しが経由する HTTP クライアント（§13）。
// DO 内では httpWithBudget（残枠カウント・10s タイムアウト・冪等 GET のみ 1 回リトライ）が注入される。
export type Http = (vendor: string, req: Request) => Promise<Response>;

export interface VendorAdapter {
  readonly vendor: string; // 一意ID。Device.vendor / rate_budget のキー
  readonly rateLimit?: { perDay: number }; // 宣言すると残枠管理が自動で効く
  readonly requiredSecrets: string[]; // setup.ts が対話取得に使う / 未設定時の自動無効化

  // 機器発見。能力と feedback 信頼度の宣言はここで行う（D4/D5 の実装点）
  discoverDevices(): Promise<Omit<Device, "id" | "room">[]>;

  // 状態読み取り（対応する能力の分だけ返す）
  readState(device: Device): Promise<DeviceState>;

  // 操作。必ず安全層経由で呼ばれる
  execute(device: Device, action: Action): Promise<ExecResult>;

  // Webhook 対応ベンダーのみ。署名検証はこの中で行う
  parseWebhook?(req: Request): Promise<WebhookEvent[]>;
}
