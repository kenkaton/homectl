// Slack Incoming Webhook 実装（§11）。
// メッセージ整形はこの中に閉じる — イベント型にベンダー固有構造を漏らさない。
import type { Notifier, NotifyEvent } from "./types";

export class SlackNotifier implements Notifier {
  constructor(private webhookUrl: string | undefined) {}

  async send(event: NotifyEvent): Promise<void> {
    if (!this.webhookUrl) {
      // secret 未設定でも落とさない（notifySafe が console に流す）
      throw new Error("SLACK_WEBHOOK_URL is not set");
    }
    const emoji = event.level === "alert" ? "🚨" : "⚠️";
    let text = `${emoji} *${event.title}*`;
    if (event.deviceId) text += `\n機器: ${event.deviceId}`;
    if (event.detail) text += `\n\`\`\`${event.detail}\`\`\``;
    const res = await fetch(this.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`slack webhook: HTTP ${res.status}`);
  }
}
