// 通知実装の選択はここ 1 箇所のみ（§11）。
// 別サービス追加は 3 手: notify/<name>.ts を書く → ここに 1 行 → vars/secret 設定。
import type { Notifier } from "./types";
import { ConsoleNotifier } from "./console";
import { SlackNotifier } from "./slack";
import type { Env } from "../env";

export function createNotifier(env: Env): Notifier {
  switch (env.NOTIFIER) {
    case "slack":
      return new SlackNotifier(env.SLACK_WEBHOOK_URL);
    default:
      return new ConsoleNotifier(); // 未設定・不明値でも落とさない
  }
}
