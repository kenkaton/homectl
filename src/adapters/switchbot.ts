// SwitchBot API v1.1 アダプタ。
// 個社差（認証・機種→能力対応・状態の正規化）はこのファイルに完全に閉じる（D11）。
import { z } from "zod";
import type {
  Action,
  Device,
  DeviceCapability,
  DeviceState,
  ExecResult,
  Http,
  VendorAdapter,
  WebhookEvent,
} from "./types";
import { plainHttp } from "./http";
import type { Env } from "../env";

const BASE = "https://api.switch-bot.com/v1.1";

/** sign = HMAC-SHA256(token + t + nonce, secret) を Base64 → 大文字化 */
export async function switchbotSign(
  token: string,
  secret: string,
  t: string,
  nonce: string,
): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(token + t + nonce));
  let b64 = "";
  const bytes = new Uint8Array(mac);
  for (const b of bytes) b64 += String.fromCharCode(b);
  return btoa(b64).toUpperCase();
}

// ---- API 応答スキーマ（zod でパースしてから使う。§13） ----

const deviceListSchema = z.object({
  statusCode: z.number(),
  body: z
    .object({
      deviceList: z
        .array(
          z
            .object({
              deviceId: z.string(),
              deviceName: z.string().default(""),
              deviceType: z.string().default(""),
            })
            .passthrough(),
        )
        .default([]),
    })
    .default({ deviceList: [] }),
});

const statusSchema = z.object({
  statusCode: z.number(),
  message: z.string().default(""),
  body: z.record(z.unknown()).default({}),
});

const commandResultSchema = z.object({
  statusCode: z.number(),
  message: z.string().default(""),
});

// Webhook payload（署名なし仕様のため、形の検証のみ。到達経路は WEBHOOK_KEY で保護）
const webhookSchema = z.object({
  eventType: z.string().optional(),
  context: z
    .object({
      deviceType: z.string().default(""),
      deviceMac: z.string(),
      temperature: z.number().optional(),
      humidity: z.number().optional(),
      power: z.string().optional(),
      lockState: z.string().optional(),
      slidePosition: z.number().optional(),
      timeOfSample: z.number().optional(),
    })
    .passthrough(),
});

// ---- 機種 → 能力の宣言（D4/D5 の実装点） ----

const V = "verified" as const;
const A = "assumed" as const;
const cap = (c: DeviceCapability["capability"], f: DeviceCapability["feedback"]): DeviceCapability => ({
  capability: c,
  feedback: f,
});

function capabilitiesFor(deviceType: string): DeviceCapability[] {
  switch (deviceType) {
    case "Meter":
    case "MeterPlus":
    case "Meter Plus (JP)":
    case "MeterPro":
    case "MeterPro(CO2)":
    case "WoIOSensor":
    case "Hub 2":
      return [cap("temperature_read", V), cap("humidity_read", V)];
    case "Plug":
      return [cap("on_off", V)];
    case "Plug Mini (JP)":
    case "Plug Mini (US)":
      return [cap("on_off", V), cap("power_read", V)];
    case "Curtain":
    case "Curtain3":
      return [cap("curtain_position", V)];
    case "Bot":
      // Bot は物理スイッチを押すだけで実状態は原理的に不明
      return [cap("on_off", A)];
    case "Smart Lock":
    case "Smart Lock Pro":
      // 読み取りのみ。施解錠は SESAME 側の設計判断に合わせ SwitchBot でも実装しない
      return [cap("lock_state_read", V)];
    default:
      return []; // 未対応機種も一覧には出す（能力なし = ポーリング対象外）
  }
}

// status 応答 → 正規化状態
function normalizeStatus(body: Record<string, unknown>): DeviceState {
  const s: DeviceState = {};
  if (typeof body.temperature === "number") s.temperature = body.temperature;
  if (typeof body.humidity === "number") s.humidity = body.humidity;
  if (body.power === "on" || body.power === "off") s.power = body.power;
  // Plug Mini は消費電力を weight (W) というフィールドで返す
  if (typeof body.weight === "number") s.powerW = body.weight;
  if (typeof body.electricCurrent === "number") s.electricCurrent = body.electricCurrent;
  if (typeof body.voltage === "number") s.voltage = body.voltage;
  if (typeof body.lockState === "string") s.locked = body.lockState === "locked";
  // SwitchBot の slidePosition は 0=全開 なので curtainPos(100=全開) に反転
  if (typeof body.slidePosition === "number") s.curtainPos = 100 - body.slidePosition;
  if (typeof body.battery === "number") s.battery = body.battery;
  return s;
}

export class SwitchBotAdapter implements VendorAdapter {
  readonly vendor = "switchbot";
  readonly rateLimit = { perDay: 10_000 }; // 1日10,000回/トークン（超過は 401）
  readonly requiredSecrets = ["SWITCHBOT_TOKEN", "SWITCHBOT_SECRET"];

  constructor(
    private env: Env,
    private http: Http = plainHttp,
  ) {}

  private async headers(): Promise<Record<string, string>> {
    const token = this.env.SWITCHBOT_TOKEN ?? "";
    const secret = this.env.SWITCHBOT_SECRET ?? "";
    const t = String(Date.now());
    const nonce = crypto.randomUUID();
    return {
      Authorization: token,
      t,
      nonce,
      sign: await switchbotSign(token, secret, t, nonce),
      "Content-Type": "application/json; charset=utf8",
    };
  }

  private async api(path: string, init?: { method: string; body?: string }): Promise<unknown> {
    const req = new Request(`${BASE}${path}`, {
      method: init?.method ?? "GET",
      headers: await this.headers(),
      body: init?.body,
    });
    const res = await this.http(this.vendor, req);
    if (!res.ok) throw new Error(`switchbot ${path}: HTTP ${res.status}`);
    return res.json();
  }

  async discoverDevices(): Promise<Omit<Device, "id" | "room">[]> {
    const parsed = deviceListSchema.parse(await this.api("/devices"));
    if (parsed.statusCode !== 100) throw new Error(`switchbot /devices: statusCode ${parsed.statusCode}`);
    return parsed.body.deviceList.map((d) => ({
      vendor: this.vendor,
      vendorDeviceId: d.deviceId,
      name: d.deviceName || `${d.deviceType} ${d.deviceId.slice(-4)}`,
      capabilities: capabilitiesFor(d.deviceType),
    }));
  }

  async readState(device: Device): Promise<DeviceState> {
    const parsed = statusSchema.parse(await this.api(`/devices/${device.vendorDeviceId}/status`));
    if (parsed.statusCode !== 100) {
      throw new Error(`switchbot status ${device.vendorDeviceId}: statusCode ${parsed.statusCode}`);
    }
    return normalizeStatus(parsed.body);
  }

  async execute(device: Device, action: Action): Promise<ExecResult> {
    const command = this.toCommand(action);
    if (!command) return { ok: false, error: `unsupported action '${action.type}' for switchbot` };
    const parsed = commandResultSchema.parse(
      await this.api(`/devices/${device.vendorDeviceId}/commands`, {
        method: "POST",
        body: JSON.stringify({ commandType: "command", ...command }),
      }),
    );
    if (parsed.statusCode !== 100) {
      return { ok: false, error: `statusCode ${parsed.statusCode}: ${parsed.message}` };
    }
    return { ok: true, newState: this.optimisticState(action) };
  }

  private toCommand(action: Action): { command: string; parameter: string } | null {
    switch (action.type) {
      case "on_off":
        return { command: action.value ? "turnOn" : "turnOff", parameter: "default" };
      case "curtain_position":
        // curtainPos(100=全開) → slidePosition(0=全開)
        return { command: "setPosition", parameter: `0,ff,${100 - action.value}` };
      case "temperature_set":
      case "lock":
        return null;
    }
  }

  private optimisticState(action: Action): DeviceState {
    switch (action.type) {
      case "on_off":
        return { power: action.value ? "on" : "off" };
      case "curtain_position":
        return { curtainPos: action.value };
      default:
        return {};
    }
  }

  // SwitchBot Webhook はペイロード署名を持たないため、到達経路（WEBHOOK_KEY 付き URL）で保護し、
  // ここでは形の検証と正規化のみを行う。
  async parseWebhook(req: Request): Promise<WebhookEvent[]> {
    const parsed = webhookSchema.safeParse(await req.json());
    if (!parsed.success) return [];
    const c = parsed.data.context;
    const state = normalizeStatus(c as Record<string, unknown>);
    if (Object.keys(state).length === 0) return [];
    return [
      {
        vendorDeviceId: c.deviceMac,
        state,
        ts: typeof c.timeOfSample === "number" ? c.timeOfSample : Date.now(),
      },
    ];
  }
}
