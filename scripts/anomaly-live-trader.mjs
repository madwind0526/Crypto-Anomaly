import { build } from "esbuild";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const outdir = path.join(root, ".tmp", "scripts");
const outfile = path.join(outdir, "anomaly-live-trader.bundle.mjs");

await mkdir(outdir, { recursive: true });
await build({
  bundle: true,
  entryPoints: [path.join(root, "scripts", "anomaly-live-trader.ts")],
  format: "esm",
  outfile,
  platform: "node",
  target: "node20",
  packages: "bundle",
});

try {
  await import(pathToFileURL(outfile).href);
} finally {
  // keep bundle while process runs (long-lived)
}
