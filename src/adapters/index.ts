// レジストリ — 有効化はここ 1 箇所のみ（明示列挙・動的読み込みしない。D11）。
// 新ベンダー追加は 3 手: adapters/<name>.ts を書く → ここに 1 行 → secrets 設定。
import type { Http, VendorAdapter } from "./types";
import type { Env } from "../env";
import { secretPresent } from "../env";
import { SwitchBotAdapter } from "./switchbot";

export function createAdapters(env: Env, http?: Http): Map<string, VendorAdapter> {
  const adapters: VendorAdapter[] = [
    new SwitchBotAdapter(env, http),
  ];
  return new Map(adapters.map((a) => [a.vendor, a]));
}

/** secrets が揃っているアダプタだけ（未契約ベンダーは自動的に無効） */
export function isConfigured(env: Env, adapter: VendorAdapter): boolean {
  return adapter.requiredSecrets.every((name) => secretPresent(env, name));
}
