import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const outputDir = path.join(root, "public", "market");
const paperPath = path.join(outputDir, "paper-trading-1m-daily-results.json");
const statusPath = path.join(root, "data", "local", "anomaly-watchdog-status.json");
const childScript = path.join(root, "scripts", "anomaly-variants-sim.mjs");

const durationMs = Number(process.env.ANOMALY_WATCHDOG_HOURS ?? 24) * 60 * 60 * 1000;
const staleMs = Number(process.env.ANOMALY_WATCHDOG_STALE_MINUTES ?? 10) * 60 * 1000;
const checkMs = Number(process.env.ANOMALY_WATCHDOG_CHECK_SECONDS ?? 60) * 1000;
const loopMs = Number(process.env.LOOP_INTERVAL_MS ?? 60_000);
const restartDelayMs = Number(process.env.ANOMALY_WATCHDOG_RESTART_DELAY_SECONDS ?? 15) * 1000;
const continuous = process.env.ANOMALY_WATCHDOG_CONTINUOUS !== "false";
const startedAt = Date.now();
let child = null;
let restartCount = 0;
let runCount = 0;
let stopping = false;

await mkdir(path.dirname(statusPath), { recursive: true });
await writeStatus("starting");

process.on("SIGINT", () => shutdown("SIGINT", 130));
process.on("SIGTERM", () => shutdown("SIGTERM", 143));

while (!stopping) {
  runCount += 1;
  const exitCode = await runChild(runCount);
  if (stopping) break;
  if (!continuous) break;
  restartCount += 1;
  await writeStatus("restarting", {
    restartCount,
    runCount,
    lastExitCode: exitCode,
    nextRestartAt: new Date(Date.now() + restartDelayMs).toISOString(),
  });
  await sleep(restartDelayMs);
}

await writeStatus(continuous ? "stopped" : "completed", { restartCount, runCount });

async function runChild(currentRunCount) {
  const runDeadline = Date.now() + durationMs;
  await writeStatus("running", {
    restartCount,
    runCount: currentRunCount,
    currentRunDeadline: new Date(runDeadline).toISOString(),
  });
  return await new Promise((resolve) => {
    let lastSeenMtime = getPaperResultMtimeMs();
    let lastFreshAt = Date.now();
    child = spawn(process.execPath, [childScript, `--loop=${loopMs}`], { cwd: root, stdio: "inherit" });
    const timer = setInterval(async () => {
      if (!child || stopping) return;
      const currentMtime = getPaperResultMtimeMs();
      const staleFor = Date.now() - lastFreshAt;
      if (currentMtime !== null && (lastSeenMtime === null || currentMtime > lastSeenMtime)) {
        lastSeenMtime = currentMtime;
        lastFreshAt = Date.now();
        await writeStatus("running", {
          restartCount,
          runCount: currentRunCount,
          childPid: child.pid,
          currentRunDeadline: new Date(runDeadline).toISOString(),
          lastSeenMtime,
          staleForMs: 0,
        });
        return;
      }
      await writeStatus("running", {
        restartCount,
        runCount: currentRunCount,
        childPid: child.pid,
        currentRunDeadline: new Date(runDeadline).toISOString(),
        lastSeenMtime,
        staleForMs: staleFor,
      });
      if (staleFor < staleMs) return;
      await writeStatus("stale-restart", {
        restartCount,
        runCount: currentRunCount,
        childPid: child.pid,
        staleForMs: staleFor,
        lastSeenMtime,
      });
      child.kill("SIGTERM");
      setTimeout(() => child?.kill("SIGKILL"), 10_000).unref();
    }, checkMs);

    child.on("exit", (code, signal) => {
      clearInterval(timer);
      child = null;
      resolve(code ?? signal ?? 0);
    });
    child.on("error", async (error) => {
      clearInterval(timer);
      child = null;
      await writeStatus("child-error", { error: String(error) });
      resolve(1);
    });
  });
}

function getPaperResultMtimeMs() {
  if (!existsSync(paperPath)) return null;
  return statSync(paperPath).mtimeMs;
}

async function shutdown(reason, exitCode) {
  stopping = true;
  if (child) child.kill("SIGTERM");
  await writeStatus("stopped", { reason, restartCount, runCount });
  process.exit(exitCode);
}

async function writeStatus(status, extra = {}) {
  await writeFile(statusPath, `${JSON.stringify({
    status,
    pid: process.pid,
    childPid: child?.pid ?? null,
    startedAt: new Date(startedAt).toISOString(),
    mode: continuous ? "continuous" : "single",
    updatedAt: new Date().toISOString(),
    ...extra,
  }, null, 2)}\n`, "utf8");
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
