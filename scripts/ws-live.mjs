import { build } from "esbuild";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root    = process.cwd();
const outdir  = path.join(root, ".tmp", "scripts");
const outfile = path.join(outdir, "ws-live.bundle.mjs");

await mkdir(outdir, { recursive: true });
await build({
  bundle: true,
  entryPoints: [path.join(root, "scripts", "ws-live.ts")],
  format: "esm",
  outfile,
  platform: "node",
  target: "node20",
  packages: "external",
});

try {
  await import(pathToFileURL(outfile).href);
} finally {
  // keep bundle alive (ws-live is a long-running process, cleanup on exit)
}
