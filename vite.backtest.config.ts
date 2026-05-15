// @ts-nocheck
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainPublicDir = path.resolve(__dirname, "../../../public");

// Intercepts specific files so the worktree's own results take priority over
// the main project's public/. Used for dashboard-results.json only — all other
// files (candle caches, charts, etc.) are served directly from mainPublicDir.
function backtestResultsOverridePlugin() {
  const overrides: Record<string, string> = {
    "/market/dashboard-results.json": path.join(__dirname, "public/market/dashboard-results.json"),
    "/market/paper-trading-1m-daily-results.json": path.join(__dirname, "public/market/paper-trading-1m-daily-results.json"),
  };

  return {
    name: "backtest-results-override",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const filePath = overrides[req.url?.split("?")[0] ?? ""];
        if (!filePath) return next();
        try {
          const content = await readFile(filePath, "utf8");
          res.setHeader("Content-Type", "application/json");
          res.setHeader("Cache-Control", "no-store");
          res.end(content);
        } catch {
          next();
        }
      });
    },
  };
}

// Read-only backtest instance on port 5174.
// - Candle data served from main project's public/ (read-only, no writes)
// - dashboard-results.json served from this worktree (new branch results)
// - strategy-refresh API is intentionally omitted to prevent data writes
export default defineConfig({
  plugins: [backtestResultsOverridePlugin(), react()],
  publicDir: mainPublicDir,
  server: {
    host: "127.0.0.1",
    port: 5174,
    strictPort: true,
  },
});
