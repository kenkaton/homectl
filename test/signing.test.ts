import { describe, expect, it } from "vitest";
import { switchbotSign } from "../src/adapters/switchbot";
import { jstDay } from "../src/util/time";

describe("SwitchBot 署名 (HMAC-SHA256 → Base64 → 大文字化)", () => {
  it("既知ベクタと一致する", async () => {
    // node:crypto の createHmac('sha256','secret456').update('token123'+'1700000000000'+'nonce-abc') で事前計算
    const sign = await switchbotSign("token123", "secret456", "1700000000000", "nonce-abc");
    expect(sign).toBe("0NZMEHNGDX1ZYGTZENINHQGQVZ2GH0UNELKKI51FEY4=");
  });

  it("token/t/nonce のどれが変わっても署名が変わる", async () => {
    const base = await switchbotSign("tok", "sec", "1", "n");
    expect(await switchbotSign("tok2", "sec", "1", "n")).not.toBe(base);
    expect(await switchbotSign("tok", "sec", "2", "n")).not.toBe(base);
    expect(await switchbotSign("tok", "sec", "1", "m")).not.toBe(base);
  });
});

describe("rate_budget の日付キー (JST)", () => {
  it("UTC 14:59 は JST 同日 / UTC 15:00 は JST 翌日", () => {
    expect(jstDay(Date.UTC(2026, 0, 1, 14, 59, 59))).toBe("2026-01-01");
    expect(jstDay(Date.UTC(2026, 0, 1, 15, 0, 0))).toBe("2026-01-02");
  });
});
