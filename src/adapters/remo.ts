// Nature Remo Cloud API アダプタ。
// 赤外線はオープンループ — 送信≠実行。IR 系能力は全て feedback:"assumed" で宣言し、
// 閉ループ検証（pending_verifications）はコア側が via 機器で行う（D5）。
import { z } from "zod";
import type {
  Action,
  Device,
  DeviceCapability,
  DeviceState,
  ExecResult,
  Http,
  VendorAdapter,
} from "./types";
import { plainHttp } from "./http";
import type { Env } from "../env";

const BASE = "https://api.nature.global";
const CACHE_TTL_MS = 30_000; // readState は機器単位で呼ばれるため、一覧 API 応答を短時間共有する

// ---- API 応答スキーマ（§13: zod でパースしてから使う） ----

const devicesSchema = z.array(
  z
    .object({
      id: z.string(),
      name: z.string().default("Remo"),
      newest_events: z
        .object({
          te: z.object({ val: z.number() }).passthrough().optional(), // 温度
          hu: z.object({ val: z.number() }).passthrough().optional(), // 湿度
        })
        .passthrough()
        .default({}),
    })
    .passthrough(),
);

const appliancesSchema = z.array(
  z
    .object({
      id: z.string(),
      type: z.string(),
      nickname: z.string().default(""),
      settings: z
        .object({
          temp: z.string().default(""),
          mode: z.string().default(""),
          button: z.string().default(""),
        })
        .passthrough()
        .nullish(),
      device: z.object({ id: z.string() }).passthrough(),
      smart_meter: z
        .object({
          echonetlite_properties: z
            .array(z.object({ epc: z.number(), val: z.string() }).passthrough())
            .default([]),
        })
        .passthrough()
        .nullish(),
    })
    .passthrough(),
);

type RemoDevice = z.infer<typeof devicesSchema>[number];
type RemoAppliance = z.infer<typeof appliancesSchema>[number];

const EPC_INSTANT_POWER = 231; // ECHONET Lite: 瞬時電力計測値 (W)

const V = "verified" as const;
const A = "assumed" as const;

export class RemoAdapter implements VendorAdapter {
  readonly vendor = "remo";
  // 実際の制限は 30 リクエスト/5 分（≈8,640/日）。日次換算で宣言して残枠管理に載せる
  readonly rateLimit = { perDay: 8_000 };
  readonly requiredSecrets = ["REMO_TOKEN"];

  private cache: { at: number; devices: RemoDevice[]; appliances: RemoAppliance[] } | null = null;

  constructor(
    private env: Env,
    private http: Http = plainHttp,
  ) {}

  private async api(path: string, init?: { method: string; form?: Record<string, string> }): Promise<unknown> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.env.REMO_TOKEN ?? ""}` };
    let body: string | undefined;
    if (init?.form) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(init.form).toString();
    }
    const res = await this.http(this.vendor, new Request(`${BASE}${path}`, { method: init?.method ?? "GET", headers, body }));
    if (!res.ok) throw new Error(`remo ${path}: HTTP ${res.status}`);
    return res.json();
  }

  /** /1/devices と /1/appliances を短 TTL で共有（ポーリング 1 周 = 2 呼び出しに抑える） */
  private async fetchAll(): Promise<{ devices: RemoDevice[]; appliances: RemoAppliance[] }> {
    const now = Date.now();
    if (this.cache && now - this.cache.at < CACHE_TTL_MS) return this.cache;
    const [devices, appliances] = await Promise.all([
      this.api("/1/devices").then((d) => devicesSchema.parse(d)),
      this.api("/1/appliances").then((a) => appliancesSchema.parse(a)),
    ]);
    this.cache = { at: now, devices, appliances };
    return this.cache;
  }

  async discoverDevices(): Promise<Omit<Device, "id" | "room">[]> {
    const { devices, appliances } = await this.fetchAll();
    const found: Omit<Device, "id" | "room">[] = [];
    for (const d of devices) {
      const caps: DeviceCapability[] = [];
      if (d.newest_events.te) caps.push({ capability: "temperature_read", feedback: V });
      if (d.newest_events.hu) caps.push({ capability: "humidity_read", feedback: V });
      found.push({ vendor: this.vendor, vendorDeviceId: d.id, name: d.name, capabilities: caps });
    }
    for (const a of appliances) {
      const caps: DeviceCapability[] = [];
      if (a.type === "AC") {
        // 赤外線送信のみ。実状態は取れない → assumed。
        // 検証したい場合は update_device で feedback:"inferred" + via:<プラグ/メーターid> に上書きする
        caps.push({ capability: "on_off", feedback: A }, { capability: "temperature_set", feedback: A });
      }
      if (a.smart_meter?.echonetlite_properties.some((p) => p.epc === EPC_INSTANT_POWER)) {
        caps.push({ capability: "power_read", feedback: V });
      }
      found.push({
        vendor: this.vendor,
        vendorDeviceId: a.id,
        name: a.nickname || `${a.type} ${a.id.slice(0, 8)}`,
        capabilities: caps,
      });
    }
    return found;
  }

  async readState(device: Device): Promise<DeviceState> {
    const { devices, appliances } = await this.fetchAll();
    const d = devices.find((x) => x.id === device.vendorDeviceId);
    if (d) {
      const s: DeviceState = {};
      if (d.newest_events.te) s.temperature = d.newest_events.te.val;
      if (d.newest_events.hu) s.humidity = d.newest_events.hu.val;
      return s;
    }
    const a = appliances.find((x) => x.id === device.vendorDeviceId);
    if (a) {
      const s: DeviceState = {};
      if (a.type === "AC" && a.settings) {
        // settings は「最後に送った内容」= assumed の根拠。実状態ではないことに注意
        s.power = a.settings.button === "power-off" ? "off" : "on";
        const t = Number(a.settings.temp);
        if (Number.isFinite(t) && a.settings.temp !== "") s.setTemp = t;
      }
      const power = a.smart_meter?.echonetlite_properties.find((p) => p.epc === EPC_INSTANT_POWER);
      if (power) {
        const w = Number(power.val);
        if (Number.isFinite(w)) s.powerW = w;
      }
      return s;
    }
    throw new Error(`remo: unknown device ${device.vendorDeviceId}`);
  }

  async execute(device: Device, action: Action): Promise<ExecResult> {
    const form = this.toAirconForm(action);
    if (!form) return { ok: false, error: `unsupported action '${action.type}' for remo` };
    const path = `/1/appliances/${device.vendorDeviceId}/aircon_settings`;
    // 失敗時は 1 回だけ再送。それでも失敗なら error を返して停止（無限再送禁止。§5）
    try {
      await this.api(path, { method: "POST", form });
    } catch (firstError) {
      try {
        await this.api(path, { method: "POST", form });
      } catch {
        const msg = firstError instanceof Error ? firstError.message : String(firstError);
        return { ok: false, error: `${msg} (retried once)` };
      }
    }
    this.cache = null; // settings が変わったので一覧キャッシュを破棄
    return { ok: true, newState: this.optimisticState(action) };
  }

  private toAirconForm(action: Action): Record<string, string> | null {
    switch (action.type) {
      case "on_off":
        return { button: action.value ? "" : "power-off" }; // "" = 電源ON
      case "temperature_set":
        return { temperature: String(action.value) };
      case "curtain_position":
      case "lock":
        return null;
    }
  }

  private optimisticState(action: Action): DeviceState {
    switch (action.type) {
      case "on_off":
        return { power: action.value ? "on" : "off" };
      case "temperature_set":
        return { setTemp: action.value };
      default:
        return {};
    }
  }
}
