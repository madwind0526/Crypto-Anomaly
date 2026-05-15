import { build } from "esbuild";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Allow LOOP_INTERVAL_MS to be passed as a CLI arg for Windows compatibility:
//   node scripts/anomaly-variants-sim.mjs --loop=60000
const loopArg = process.argv.find(a => a.startsWith("--loop="));
if (loopArg) {
  process.env.LOOP_INTERVAL_MS = loopArg.split("=")[1];
}

const root = process.cwd();
const outdir = path.join(root, ".tmp", "scripts");
const outfile = path.join(outdir, "anomaly-variants-sim.bundle.mjs");

await mkdir(outdir, { recursive: true });
await build({
  bundle: true,
  entryPoints: [path.join(root, "scripts", "anomaly-variants-sim.ts")],
  format: "esm",
  outfile,
  platform: "node",
  target: "node20",
  packages: "bundle",
});

const loopMs = Number(process.env.LOOP_INTERVAL_MS ?? 0);
try {
  await import(pathToFileURL(outfile).href);
} finally {
  if (!loopMs) await rm(outfile, { force: true });
}
