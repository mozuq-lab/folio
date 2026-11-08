import { defineConfig } from "vite";
import { configureToolEnvironment } from "./scripts/tool-environment.mjs";

export default defineConfig(async ({ command }) => {
  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  configureToolEnvironment(process.cwd());
  const { selfHostedCloudflareConfig } = await import("./scripts/vite/cloudflare-config");
  return selfHostedCloudflareConfig(command);
});
