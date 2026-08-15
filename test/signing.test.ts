import { describe, expect, it } from "vitest";
import { switchbotSign } from "../src/adapters/switchbot";
import { aesCmac, sesameCommandSign } from "../src/adapters/sesame";
import { jstDay } from "../src/util/time";

const hex = (s: string) => {
  const clean = s.replace(/\s/g, "");
  return new Uint8Array([...clean.matchAll(/../g)].map((m) => parseInt(m[0], 16)));
};
const toHex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

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

describe("AES-CMAC (RFC 4493 テストベクタ)", () => {
  const KEY = hex("2b7e1516 28aed2a6 abf71588 09cf4f3c");

  it("空メッセージ", async () => {
    expect(toHex(await aesCmac(KEY, new Uint8Array(0)))).toBe("bb1d6929e95937287fa37d129b756746");
  });

  it("16 バイト（ちょうど 1 ブロック）", async () => {
    const msg = hex("6bc1bee2 2e409f96 e93d7e11 7393172a");
    expect(toHex(await aesCmac(KEY, msg))).toBe("070a16b46b4d4144f79bdd9dd04a287c");
  });

  it("40 バイト（端数ブロック）", async () => {
    const msg = hex(
      "6bc1bee2 2e409f96 e93d7e11 7393172a ae2d8a57 1e03ac9c 9eb76fac 45af8e51 30c81c46 a35ce411",
    );
    expect(toHex(await aesCmac(KEY, msg))).toBe("dfa66747de9ae63030ca32611497c827");
  });

  it("64 バイト（ちょうど 4 ブロック）", async () => {
    const msg = hex(
      "6bc1bee2 2e409f96 e93d7e11 7393172a ae2d8a57 1e03ac9c 9eb76fac 45af8e51" +
        "30c81c46 a35ce411 e5fbc119 1a0a52ef f69f2445 df4f9b17 ad2b417b e66c3710",
    );
    expect(toHex(await aesCmac(KEY, msg))).toBe("51f0bebf7e3b9d92fc49741779363cfe");
  });

  it("SESAME コマンド署名: 32 桁 hex で、秒が変われば変わる", async () => {
    const key = "2b7e151628aed2a6abf7158809cf4f3c";
    const a = await sesameCommandSign(key, 1_700_000_000_000);
    const b = await sesameCommandSign(key, 1_700_000_999_000);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
    // 同一秒なら同一署名（決定的）
    expect(await sesameCommandSign(key, 1_700_000_000_500)).toBe(a);
  });
});

describe("rate_budget の日付キー (JST)", () => {
  it("UTC 14:59 は JST 同日 / UTC 15:00 は JST 翌日", () => {
    expect(jstDay(Date.UTC(2026, 0, 1, 14, 59, 59))).toBe("2026-01-01");
    expect(jstDay(Date.UTC(2026, 0, 1, 15, 0, 0))).toBe("2026-01-02");
  });
});
