// ルール登録 — 明示的に配列 export（動的読み込みしない。§7）。
// 新しいルールは rules/<name>.ts を書いてここに 1 行足し、wrangler deploy する。
import type { RuleDef } from "../src/rules/types";
import peakShaving from "./peak-shaving";

export const rules: RuleDef[] = [
  peakShaving,
];
