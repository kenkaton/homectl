// アーキテクチャ境界を lint で強制する（DESIGN.md D3/D4/§6/§11）。
// - アダプタを直接 import できるのは safety/ と SiteDO（と adapters 自身・scripts/test）のみ
// - rules/ は src/rules/types 以外を import しない（能力にのみ依存）
// - notifier の具象（slack/console）は notify/index の factory からのみ import
import tseslint from "typescript-eslint";

const ADAPTER_IMPORT = {
  // adapters/types（型のみ）はどこからでも可。実装・レジストリの import を禁止する
  regex: "adapters(/(?!types$)[^/]*)?$",
  message: "機器操作は安全層(safety/enforce)経由。アダプタの直接 import は禁止 (DESIGN.md §6)",
};
const NOTIFIER_CONCRETE_IMPORT = {
  group: ["**/notify/slack", "**/notify/console"],
  message: "Notifier 具象は notify/index の factory 経由でのみ使う (DESIGN.md §11)",
};

export default tseslint.config(
  { ignores: ["node_modules/**", "dist/**", ".wrangler/**", "scripts/**"] },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error", // §13: any 禁止
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  // 既定: src/ ではアダプタ直 import・notifier 具象 import を禁止
  {
    files: ["src/**/*.ts"],
    ignores: ["src/adapters/**", "src/safety/**", "src/site-do.ts", "src/notify/index.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [ADAPTER_IMPORT, NOTIFIER_CONCRETE_IMPORT] }],
    },
  },
  // safety/ と SiteDO はアダプタを触ってよいが、notifier 具象は不可
  {
    files: ["src/safety/**/*.ts", "src/site-do.ts", "src/adapters/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [NOTIFIER_CONCRETE_IMPORT] }],
    },
  },
  // notify/index (factory) は具象を列挙してよいが、アダプタは不可
  {
    files: ["src/notify/index.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [ADAPTER_IMPORT] }],
    },
  },
  // rules/ は能力にのみ依存（D4）: src からは rules/types だけ import 可。
  // fetch / 時刻 / 乱数の直接使用も禁止（決定性。§7）
  {
    files: ["rules/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["../src/**", "!../src/rules", "!../src/rules/types"],
              message: "ルールは src/rules/types (defineRule/RuleContext) のみ import 可 (DESIGN.md §7)",
            },
          ],
        },
      ],
      "no-restricted-globals": [
        "error",
        { name: "fetch", message: "ルール内から fetch 禁止 (DESIGN.md §7)" },
        { name: "Date", message: "現在時刻は ctx.now() を使う (DESIGN.md §7)" },
      ],
      "no-restricted-properties": [
        "error",
        { object: "Math", property: "random", message: "乱数は ctx 経由 (DESIGN.md §7)" },
      ],
    },
  },
);
