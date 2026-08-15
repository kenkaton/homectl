import { defineRule } from "../src/rules/types";

export default defineRule({
  id: "peak-shaving",
  description: "合計3kW超でエアコンを1度上げる（上限28度）",
  cooldownMinutes: 15, // 再発動抑止
  rooms: ["bedroom"], // Webhook（電力急変など）でも即時評価してよい部屋
  condition: (ctx) => ctx.totalPowerW() > 3000,
  action: async (ctx) => {
    const ac = ctx.device("bedroom-ac");
    const cur = ctx.state(ac).setTemp ?? 26;
    if (cur < 28) await ctx.setTemperature(ac, cur + 1);
  },
});
