// SESAME (CANDY HOUSE Web API) アダプタ。
// 施錠状態の読み取りと施錠のみ実装する。解錠 API は実装自体を書かない（§5/§14）—
// 解錠コマンド定数・分岐はこのファイルのどこにも存在しない。
import { z } from "zod";
import type {
  Action,
  Device,
  DeviceState,
  ExecResult,
  Http,
  VendorAdapter,
} from "./types";
import { plainHttp } from "./http";
import type { Env } from "../env";

const BASE = "https://app.candyhouse.co/api";
const CMD_LOCK = 82; // 施錠。これ以外のコマンド定数は定義しない

const statusSchema = z
  .object({
    CHSesame2Status: z.string(), // "locked" | "unlocked" | "moved"
    batteryPercentage: z.number().optional(),
  })
  .passthrough();

// ---- AES-CMAC (RFC 4493) ----
// SESAME のコマンド署名に必要。WebCrypto に CMAC は無いため、
// AES-CBC(IV=0) の 1 ブロック暗号化で AES-ECB を代用して実装する。

async function aesEncryptBlock(key: CryptoKey, block: Uint8Array): Promise<Uint8Array> {
  // CBC の先頭ブロックは E(IV xor P) = E(P)（IV=0 のとき）。出力の先頭 16 バイトだけ使う
  const out = await crypto.subtle.encrypt(
    { name: "AES-CBC", iv: new Uint8Array(16) },
    key,
    block as unknown as BufferSource,
  );
  return new Uint8Array(out, 0, 16); // 末尾の PKCS#7 パディングブロックは捨てる

}

function shiftLeftOne(b: Uint8Array): Uint8Array {
  const out = new Uint8Array(16);
  let carry = 0;
  for (let i = 15; i >= 0; i--) {
    const v = (b[i] ?? 0) & 0xff;
    out[i] = ((v << 1) | carry) & 0xff;
    carry = v >> 7;
  }
  return out;
}

function xorBlock(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = (a[i] ?? 0) ^ (b[i] ?? 0);
  return out;
}

function deriveSubkey(base: Uint8Array): Uint8Array {
  const shifted = shiftLeftOne(base);
  if (((base[0] ?? 0) & 0x80) !== 0) shifted[15] = (shifted[15] ?? 0) ^ 0x87;
  return shifted;
}

export async function aesCmac(keyBytes: Uint8Array, message: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", keyBytes as unknown as BufferSource, { name: "AES-CBC" }, false, [
    "encrypt",
  ]);
  const k1 = deriveSubkey(await aesEncryptBlock(key, new Uint8Array(16)));
  const k2 = deriveSubkey(k1);

  const n = Math.max(1, Math.ceil(message.length / 16));
  const lastLen = message.length === 0 ? 0 : message.length - (n - 1) * 16;
  let last: Uint8Array;
  if (message.length > 0 && lastLen === 16) {
    last = xorBlock(message.slice((n - 1) * 16), k1);
  } else {
    const padded = new Uint8Array(16);
    padded.set(message.slice((n - 1) * 16));
    padded[lastLen] = 0x80;
    last = xorBlock(padded, k2);
  }

  let x: Uint8Array = new Uint8Array(16);
  for (let i = 0; i < n - 1; i++) {
    x = await aesEncryptBlock(key, xorBlock(x, message.slice(i * 16, (i + 1) * 16)));
  }
  return aesEncryptBlock(key, xorBlock(x, last));
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/[^0-9a-fA-F]/g, "");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** SESAME コマンド署名: AES-CMAC(secret, uint32LE(現在秒) のバイト 1..3) を hex で */
export async function sesameCommandSign(secretKeyHex: string, nowMs: number): Promise<string> {
  const seconds = Math.floor(nowMs / 1000);
  const buf = new Uint8Array(4);
  new DataView(buf.buffer).setUint32(0, seconds, true); // little-endian
  const message = buf.slice(1, 4); // 下位バイトを落とした 3 バイト（公式仕様）
  return bytesToHex(await aesCmac(hexToBytes(secretKeyHex), message));
}

export class SesameAdapter implements VendorAdapter {
  readonly vendor = "sesame";
  readonly requiredSecrets = ["SESAME_API_KEY", "SESAME_DEVICE_UUID"];
  // 施錠コマンドにのみ必要（読み取りは API キーだけで可）
  readonly optionalSecrets = ["SESAME_SECRET_KEY"];

  constructor(
    private env: Env,
    private http: Http = plainHttp,
  ) {}

  async discoverDevices(): Promise<Omit<Device, "id" | "room">[]> {
    // この API に一覧エンドポイントは無い。secret で指定された 1 台を登録する
    const uuid = this.env.SESAME_DEVICE_UUID;
    if (!uuid) return [];
    return [
      {
        vendor: this.vendor,
        vendorDeviceId: uuid,
        name: "SESAME",
        capabilities: [{ capability: "lock_state_read", feedback: "verified" }],
      },
    ];
  }

  async readState(device: Device): Promise<DeviceState> {
    const res = await this.http(
      this.vendor,
      new Request(`${BASE}/sesame2/${device.vendorDeviceId}`, {
        headers: { "x-api-key": this.env.SESAME_API_KEY ?? "" },
      }),
    );
    if (!res.ok) throw new Error(`sesame status: HTTP ${res.status}`);
    const parsed = statusSchema.parse(await res.json());
    const s: DeviceState = { locked: parsed.CHSesame2Status === "locked" };
    if (typeof parsed.batteryPercentage === "number") s.battery = parsed.batteryPercentage;
    return s;
  }

  async execute(device: Device, action: Action): Promise<ExecResult> {
    if (action.type !== "lock") {
      // 施錠以外は何であれ実装しない（解錠はここに分岐すら存在しない）
      return { ok: false, error: `unsupported action '${action.type}' for sesame (lock only)` };
    }
    const secret = this.env.SESAME_SECRET_KEY;
    if (!secret) {
      return { ok: false, error: "SESAME_SECRET_KEY が未設定（施錠コマンドの署名に必要）" };
    }
    const res = await this.http(
      this.vendor,
      new Request(`${BASE}/sesame2/${device.vendorDeviceId}/cmd`, {
        method: "POST",
        headers: { "x-api-key": this.env.SESAME_API_KEY ?? "", "Content-Type": "application/json" },
        body: JSON.stringify({
          cmd: CMD_LOCK,
          history: btoa("homectl"),
          sign: await sesameCommandSign(secret, Date.now()),
        }),
      }),
    );
    if (!res.ok) return { ok: false, error: `sesame cmd: HTTP ${res.status}` };
    return { ok: true, newState: { locked: true } };
  }
}
