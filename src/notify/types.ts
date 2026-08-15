// 通知の抽象。呼び出し側（SiteDO・engine・enforce）はこの型のみ import する（§11）。
// 具象実装（slack.ts 等）を直接 import したらレビューで差し戻し（ESLint でも制限）。

export type NotifyLevel = "warn" | "alert";

export interface NotifyEvent {
  level: NotifyLevel;
  kind: "device_offline" | "rate_budget" | "rule_error" | "verification_failed" | "kill_switch";
  title: string; // 1 行要約
  detail?: string; // 補足（実測値・閾値など）
  deviceId?: string;
}

export interface Notifier {
  send(event: NotifyEvent): Promise<void>;
}

/** 通知は best-effort。send() の失敗でメインロジックを止めない（§11） */
export async function notifySafe(notifier: Notifier, event: NotifyEvent): Promise<void> {
  try {
    await notifier.send(event);
  } catch (e) {
    console.error("notifier failed:", e instanceof Error ? e.message : String(e));
  }
}
