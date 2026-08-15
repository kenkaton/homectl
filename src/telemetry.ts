// Analytics Engine への時系列書き込み（§11）。
// blobs: [device_id, room, vendor] / doubles: [powerW, tempC, humidity] / index: device_id
import type { Device, DeviceState } from "./adapters/types";

export function writeTelemetry(
  dataset: AnalyticsEngineDataset | undefined,
  device: Device,
  state: DeviceState,
): void {
  if (!dataset) return;
  const has = (c: Device["capabilities"][number]["capability"]) =>
    device.capabilities.some((x) => x.capability === c);
  // 対象メトリクスを 1 つも持たない機器は書かない（0 行でデータセットを汚さない）
  if (!has("power_read") && !has("temperature_read") && !has("humidity_read")) return;
  const powerW = has("power_read") && typeof state.powerW === "number" ? state.powerW : 0;
  const tempC = has("temperature_read") && typeof state.temperature === "number" ? state.temperature : 0;
  const humidity = has("humidity_read") && typeof state.humidity === "number" ? state.humidity : 0;
  try {
    dataset.writeDataPoint({
      blobs: [device.id, device.room, device.vendor],
      doubles: [powerW, tempC, humidity],
      indexes: [device.id],
    });
  } catch (e) {
    // テレメトリは best-effort。本流（ポーリング・制御）を止めない
    console.error("telemetry write failed:", e instanceof Error ? e.message : String(e));
  }
}
