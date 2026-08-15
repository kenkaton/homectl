// テスト用の外向き fetch モック。
// vitest-pool-workers ではテストと main worker（DO 含む）が同一 isolate で動くため、
// vi.stubGlobal("fetch", ...) がベンダー API 呼び出しにもそのまま効く。
import { vi } from "vitest";

export type FetchRoute = (req: Request) => Response | object;

export interface FetchMock {
  /** "METHOD https://origin/path" ごとの呼び出し回数 */
  calls: Map<string, number>;
  /** 未マッチの fetch があった場合に throw させる（既定で有効） */
  restore(): void;
}

export function mockFetch(routes: Record<string, FetchRoute>): FetchMock {
  const calls = new Map<string, number>();
  vi.stubGlobal("fetch", async (input: Request | string | URL, init?: RequestInit): Promise<Response> => {
    const req = input instanceof Request ? new Request(input, init) : new Request(input, init);
    const u = new URL(req.url);
    const key = `${req.method} ${u.origin}${u.pathname}`;
    calls.set(key, (calls.get(key) ?? 0) + 1);
    const route = routes[key];
    if (!route) throw new Error(`unmocked fetch: ${key}`);
    const result = route(req);
    return result instanceof Response ? result : Response.json(result);
  });
  return { calls, restore: () => vi.unstubAllGlobals() };
}
