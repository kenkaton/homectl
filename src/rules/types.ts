// ルールの形（§7）。rules/*.ts はこのモジュールだけを import する（ESLint で強制）。
// - fetch / LLM 呼び出し禁止、乱数と現在時刻は ctx 経由（決定的にし、テストで再現可能に）
// - ctx の操作系は全て安全層（safety/enforce）経由の薄いラッパー
import type { Device, DeviceState } from "../adapters/types";
import type { ActionOutcome } from "../safety/enforce";

export type { Device, DeviceState, ActionOutcome };

export interface RuleContext {
  /** 現在時刻 (epoch ms)。Date.now() の代わりにこれを使う */
  now(): number;
  /** 乱数 [0,1)。Math.random() の代わりにこれを使う */
  random(): number;
  /** 機器を内部 id または表示名で引く。見つからなければ throw（rule_error として通知される） */
  device(idOrName: string): Device;
  /** 状態キャッシュの最新値（無ければ空オブジェクト） */
  state(device: Device | string): DeviceState;
  /** power_read を持つ全機器の消費電力合計 (W) */
  totalPowerW(): number;
  /** 指定部屋の機器一覧 */
  room(name: string): Device[];
  /** 操作ログの reason に残す発動根拠を明示する（任意。未指定なら自動収集した実測値） */
  because(reason: string): void;

  // ---- 操作（全て安全層経由。blocked でも throw せず outcome で返る） ----
  setTemperature(device: Device, tempC: number): Promise<ActionOutcome>;
  setOnOff(device: Device, on: boolean): Promise<ActionOutcome>;
  setCurtainPosition(device: Device, position: number): Promise<ActionOutcome>;
  /** 施錠のみ。解錠は存在しない（§14） */
  lock(device: Device): Promise<ActionOutcome>;
}

export interface RuleDef {
  id: string;
  description: string;
  /** 再発動抑止（分）。発動（condition 成立）からこの時間は再評価しない */
  cooldownMinutes?: number;
  /**
   * このルールが関係する部屋。Webhook 受信直後の即時評価は「該当 room のルールのみ」
   * 行うため（§7）、宣言したルールだけが Webhook で走る。未宣言なら 5 分アラームでのみ評価。
   */
  rooms?: string[];
  condition(ctx: RuleContext): boolean;
  action(ctx: RuleContext): Promise<void> | void;
}

export function defineRule(def: RuleDef): RuleDef {
  return def;
}
