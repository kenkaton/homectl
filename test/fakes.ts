// テスト用のフェイク実装（アダプタ・通知）。
import type { Action, Device, DeviceState, ExecResult, VendorAdapter } from "../src/adapters/types";
import type { Notifier, NotifyEvent } from "../src/notify/types";

export class FakeAdapter implements VendorAdapter {
  readonly vendor: string = "fake";
  readonly requiredSecrets: string[] = [];
  executed: Array<{ deviceId: string; action: Action }> = [];
  failNext = false;

  async discoverDevices(): Promise<Omit<Device, "id" | "room">[]> {
    return [];
  }
  async readState(): Promise<DeviceState> {
    return {};
  }
  async execute(device: Device, action: Action): Promise<ExecResult> {
    if (this.failNext) {
      this.failNext = false;
      return { ok: false, error: "boom" };
    }
    this.executed.push({ deviceId: device.id, action });
    return { ok: true, newState: {} };
  }
}

export class MemoryNotifier implements Notifier {
  events: NotifyEvent[] = [];
  async send(event: NotifyEvent): Promise<void> {
    this.events.push(event);
  }
}

export const AC_DEVICE: Device = {
  id: "bedroom-ac",
  vendor: "fake",
  vendorDeviceId: "ac1",
  name: "寝室エアコン",
  room: "bedroom",
  capabilities: [
    { capability: "on_off", feedback: "inferred", via: "bedroom-plug" },
    { capability: "temperature_set", feedback: "assumed" },
  ],
};

export const PLUG_DEVICE: Device = {
  id: "bedroom-plug",
  vendor: "fake",
  vendorDeviceId: "p1",
  name: "エアコンプラグ",
  room: "bedroom",
  capabilities: [
    { capability: "on_off", feedback: "verified" },
    { capability: "power_read", feedback: "verified" },
  ],
};

export function insertDevice(sql: SqlStorage, d: Device): void {
  sql.exec(
    "INSERT INTO devices (id, vendor, vendor_device_id, name, room, capabilities) VALUES (?, ?, ?, ?, ?, ?)",
    d.id,
    d.vendor,
    d.vendorDeviceId,
    d.name,
    d.room,
    JSON.stringify(d.capabilities),
  );
}

export function insertState(sql: SqlStorage, deviceId: string, state: DeviceState, updatedAt: number): void {
  sql.exec(
    "INSERT INTO state_cache (device_id, state, updated_at, source) VALUES (?, ?, ?, 'poll') " +
      "ON CONFLICT(device_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at",
    deviceId,
    JSON.stringify(state),
    updatedAt,
  );
}
