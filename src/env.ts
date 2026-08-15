// Worker / DO で共有する環境バインディング。
// secrets は全て optional: 未設定ベンダーのアダプタは isConfigured() で自動的に無効化される。
import type { SiteDO } from "./site-do"; // 型のみ（実行時の循環はない）

export interface Env {
  SITE: DurableObjectNamespace<SiteDO>;
  TELEMETRY: AnalyticsEngineDataset;

  // vars
  NOTIFIER?: string;

  // vendor secrets
  SWITCHBOT_TOKEN?: string;
  SWITCHBOT_SECRET?: string;
  REMO_TOKEN?: string;
  SESAME_API_KEY?: string;
  SESAME_DEVICE_UUID?: string;
  SESAME_SECRET_KEY?: string; // 施錠コマンドの AES-CMAC 署名に必要（読み取りは API_KEY のみで可）

  // notifier secrets
  SLACK_WEBHOOK_URL?: string;

  // Webhook 受信 URL の共有鍵（?key=）。未設定なら検査しない
  WEBHOOK_KEY?: string;

  // Analytics Engine SQL API（履歴グラフ・get_power_history 用。未設定なら degrade）
  CF_ACCOUNT_ID?: string;
  CF_ANALYTICS_TOKEN?: string;
}

// secrets を名前で引く用（adapter の requiredSecrets 判定）
export function secretPresent(env: Env, name: string): boolean {
  const v = (env as unknown as Record<string, unknown>)[name];
  return typeof v === "string" && v.length > 0;
}
