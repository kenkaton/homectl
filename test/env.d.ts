import type { Env as AppEnv } from "../src/env";

declare global {
  // cloudflare:test の env / DO をこのプロジェクトの Env 型にマージする
  namespace Cloudflare {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface Env extends AppEnv {}
  }
}

export {};
