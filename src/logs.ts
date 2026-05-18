import { spawn } from "node:child_process";
import { state } from "./state.js";

export interface LogStreamOpts {
  bundleId?: string;
  level?: "default" | "info" | "debug";
  predicate?: string;
}

export function startLogStream(udid: string, opts: LogStreamOpts = {}): void {
  stopLogStream();
  state.logBuffer = [];
  const args = ["simctl", "spawn", udid, "log", "stream", "--style", "compact"];
  if (opts.level) args.push("--level", opts.level);
  const predicateParts: string[] = [];
  if (opts.bundleId) predicateParts.push(`subsystem contains "${opts.bundleId.replace(/"/g, '\\"')}"`);
  if (opts.predicate) predicateParts.push(`(${opts.predicate})`);
  if (predicateParts.length) {
    args.push("--predicate", predicateParts.join(" AND "));
  }
  const proc = spawn("xcrun", args, { stdio: ["ignore", "pipe", "pipe"] });
  let stdoutBuf = "";
  let stderrBuf = "";
  proc.stdout.on("data", (b) => {
    stdoutBuf += b.toString();
    const idx = stdoutBuf.lastIndexOf("\n");
    if (idx === -1) return;
    const complete = stdoutBuf.slice(0, idx);
    stdoutBuf = stdoutBuf.slice(idx + 1);
    for (const line of complete.split("\n")) {
      if (!line) continue;
      state.logBuffer.push(line);
      if (state.logBuffer.length > state.logMax) state.logBuffer.shift();
    }
  });
  proc.stderr.on("data", (b) => {
    stderrBuf += b.toString();
    if (stderrBuf.length > 2000) stderrBuf = stderrBuf.slice(-2000);
  });
  proc.on("exit", () => {
    if (state.logProc === proc) state.logProc = null;
  });
  state.logProc = proc;
}

export function stopLogStream(): void {
  if (state.logProc) {
    state.logProc.kill("SIGTERM");
    state.logProc = null;
  }
}

export function tailLogs(n: number): string[] {
  if (n >= state.logBuffer.length) return state.logBuffer.slice();
  return state.logBuffer.slice(state.logBuffer.length - n);
}

export function clearLogs(): void {
  state.logBuffer = [];
}
