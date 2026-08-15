// 時刻は全て epoch ms で保存し、表示・日付キー生成時のみ JST 変換する（§13）。

export const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** rate_budget の日付キー 'YYYY-MM-DD'（JST） */
export function jstDay(epochMs: number): string {
  return new Date(epochMs + JST_OFFSET_MS).toISOString().slice(0, 10);
}

/** 人間向け表示 'YYYY-MM-DD HH:mm:ss JST' */
export function jstDateTime(epochMs: number): string {
  const iso = new Date(epochMs + JST_OFFSET_MS).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} JST`;
}
