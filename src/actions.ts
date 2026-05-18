import { spawn } from "node:child_process";
import { runIdb } from "./idb.js";
import { state } from "./state.js";
import { captureSnapshot, snapshotIsDegenerate } from "./snapshot.js";

function runCmd(cmd: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => (stdout += b.toString()));
    child.stderr.on("data", (b) => (stderr += b.toString()));
    child.on("error", (err) => reject(new Error(`${cmd}: ${err.message}`)));
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${cmd} ${args.join(" ")} exited ${code}: ${stderr.trim() || stdout.trim()}`));
    });
  });
}

function invalidate() {
  state.lastSnapshot = null;
}

export async function tapPoint(udid: string, x: number, y: number, duration?: number): Promise<void> {
  const args = ["ui", "tap", "--udid", udid, String(Math.round(x)), String(Math.round(y))];
  if (duration !== undefined) args.push("--duration", String(duration));
  await runIdb(args);
  invalidate();
}

export async function swipe(
  udid: string,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  opts: { duration?: number; delta?: number } = {}
): Promise<void> {
  const args = [
    "ui",
    "swipe",
    "--udid",
    udid,
    String(Math.round(x1)),
    String(Math.round(y1)),
    String(Math.round(x2)),
    String(Math.round(y2)),
  ];
  if (opts.duration !== undefined) args.push("--duration", String(opts.duration));
  if (opts.delta !== undefined) args.push("--delta", String(opts.delta));
  await runIdb(args);
  invalidate();
}

export async function typeText(udid: string, text: string): Promise<void> {
  await runIdb(["ui", "text", "--udid", udid, text]);
  invalidate();
}

export async function pressKey(udid: string, keycode: number): Promise<void> {
  await runIdb(["ui", "key", "--udid", udid, String(keycode)]);
  invalidate();
}

export async function pressButton(udid: string, name: string): Promise<void> {
  await runIdb(["ui", "button", "--udid", udid, name.toUpperCase()]);
  invalidate();
}

export interface LaunchOpts {
  args?: string[];
  injectDylib?: string;
  terminateRunning?: boolean;
}

export async function launchApp(udid: string, bundleId: string, opts: LaunchOpts = {}): Promise<void> {
  if (opts.injectDylib) {
    // Bypass idb: simctl is the documented path for SIMCTL_CHILD_* env passthrough.
    const env = { ...process.env, SIMCTL_CHILD_DYLD_INSERT_LIBRARIES: opts.injectDylib };
    const args = ["simctl", "launch"];
    if (opts.terminateRunning) args.push("--terminate-running-process");
    args.push(udid, bundleId, ...(opts.args ?? []));
    await runCmd("xcrun", args, env);
  } else {
    await runIdb(["launch", "--udid", udid, bundleId, ...(opts.args ?? [])]);
  }
  invalidate();
}

export async function terminateApp(udid: string, bundleId: string): Promise<void> {
  await runIdb(["terminate", "--udid", udid, bundleId]);
  invalidate();
}

export async function screenshot(udid: string, outPath: string): Promise<void> {
  await runIdb(["screenshot", "--udid", udid, outPath]);
}

export async function awaitQuiescent(
  udid: string,
  opts: { stableMs?: number; timeoutMs?: number; pollMs?: number } = {}
): Promise<{ stable: boolean; finalHash: string; samples: number; elapsedMs: number }> {
  const stableMs = opts.stableMs ?? 250;
  const timeoutMs = opts.timeoutMs ?? 5000;
  const pollMs = opts.pollMs ?? 120;
  const start = Date.now();
  let lastHash = "";
  let stableSince = 0;
  let samples = 0;
  while (Date.now() - start < timeoutMs) {
    const snap = await captureSnapshot(udid, { allowDegenerate: true });
    samples++;
    const degenerate = snapshotIsDegenerate(snap);
    if (!degenerate && snap.treeHash === lastHash) {
      if (Date.now() - stableSince >= stableMs) {
        state.lastSnapshot = snap;
        return { stable: true, finalHash: snap.treeHash, samples, elapsedMs: Date.now() - start };
      }
    } else {
      lastHash = degenerate ? "" : snap.treeHash;
      stableSince = Date.now();
    }
    state.lastSnapshot = snap;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return { stable: false, finalHash: lastHash, samples, elapsedMs: Date.now() - start };
}
