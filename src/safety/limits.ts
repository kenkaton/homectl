// 安全層の設定は定数。GUI 化しない（§6）。
// 変更はこのファイルを編集して wrangler deploy（人間がレビューする遅いループ）。

export const LIMITS = {
  ac: {
    minSetTemp: 20,
    maxSetTemp: 30,
    maxOpsPerHour: 6, // コンプレッサ保護
  },
  global: {
    maxOpsPerDevicePerHour: 12,
    killSwitchKey: "kill_switch", // kv テーブル。"on" で全操作拒否
  },
  lock: {
    allowUnlock: false as const, // 型レベルで false 固定（解錠 API はコードごと存在しない）
  },
  // IR(assumed) 操作の閉ループ検証（D5）。via 機器の power_read で確認する
  verification: {
    delayMinutes: 5, // 送信 n 分後のアラームで検証
    onMinPowerW: 100, // ON が効いていれば via 消費電力がこれ以上（エアコンなら 200 でもよい）
    offMaxPowerW: 50, // OFF が効いていれば via 消費電力がこれ以下
    staleAfterMinutes: 15, // via のデータがこの時間より古いままなら検証失敗として通知
  },
} as const;
