import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        // テスト用のダミー secrets（実トークンは絶対に書かない）
        bindings: {
          SWITCHBOT_TOKEN: "test-sb-token",
          SWITCHBOT_SECRET: "test-sb-secret",
        },
      },
    }),
  ],
});
