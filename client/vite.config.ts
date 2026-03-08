import fs from "fs";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const clientRoot = process.cwd();
  const workspaceRoot = path.resolve(__dirname, "..");
  const clientEnv = loadEnv(mode, clientRoot, "");
  const workspaceEnv = loadEnv(mode, workspaceRoot, "");
  const env = { ...workspaceEnv, ...clientEnv };
  const rootDotEnvPath = path.join(workspaceRoot, ".env");

  // Fall back to the workspace .env when the client runs in its own cwd.
  if (fs.existsSync(rootDotEnvPath)) {
    const dotEnvContents = fs.readFileSync(rootDotEnvPath, "utf8");
    for (const line of dotEnvContents.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const separatorIndex = trimmed.indexOf("=");
      if (separatorIndex === -1) continue;
      const key = trimmed.slice(0, separatorIndex).trim();
      const value = trimmed.slice(separatorIndex + 1).trim();
      if (!(key in env)) {
        env[key] = value;
      }
    }
  }

  const apiProxyTarget =
    env.VITE_API_PROXY_TARGET ||
    `http://127.0.0.1:${env.HUB_PORT || env.DASHBOARD_PORT || "3001"}`;

  return {
    server: {
      host: "::",
      port: 8080,
      hmr: {
        overlay: false,
      },
      proxy: {
        "/api": {
          target: apiProxyTarget,
          changeOrigin: true,
        },
      },
    },
    plugins: [react(), mode === "development" && componentTagger()].filter(Boolean),
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
  };
});
