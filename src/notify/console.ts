import type { Notifier, NotifyEvent } from "./types";

// NOTIFIER 未設定・通知先 secret 未設定でも落とさないためのフォールバック実装（§11）。
export class ConsoleNotifier implements Notifier {
  async send(event: NotifyEvent): Promise<void> {
    console.warn(`[notify:${event.level}] ${event.kind}: ${event.title}`, event.detail ?? "");
  }
}
