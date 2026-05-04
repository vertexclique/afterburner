import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
        // vitest-pool-workers requires nodejs_compat in its sandbox — the
        // production Worker doesn't use Node APIs so we keep it test-only.
        miniflare: {
          compatibilityFlags: ["nodejs_compat"],
        },
      },
    },
  },
});
