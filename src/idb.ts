import { spawn } from "node:child_process";

const IDB = process.env.IDB_BIN || "idb";

export class IdbError extends Error {
  constructor(message: string, public stderr: string, public code: number | null) {
    super(message);
  }
}

export async function runIdb(args: string[], opts: { input?: string; timeoutMs?: number } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(IDB, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const t = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new IdbError(`idb ${args[0]} timed out after ${opts.timeoutMs}ms`, stderr, null));
    }, opts.timeoutMs ?? 15000);
    child.stdout.on("data", (b) => (stdout += b.toString()));
    child.stderr.on("data", (b) => (stderr += b.toString()));
    child.on("error", (err) => {
      clearTimeout(t);
      reject(new IdbError(`idb spawn failed: ${err.message}`, stderr, null));
    });
    child.on("close", (code) => {
      clearTimeout(t);
      if (code === 0) resolve(stdout);
      else reject(new IdbError(`idb ${args.join(" ")} exited ${code}`, stderr, code));
    });
    if (opts.input) {
      child.stdin.write(opts.input);
      child.stdin.end();
    }
  });
}

export interface SimTarget {
  udid: string;
  name: string;
  state: string;
  os: string;
  type: string;
}

export async function listTargets(): Promise<SimTarget[]> {
  const out = await runIdb(["list-targets", "--json"]);
  const targets: SimTarget[] = [];
  for (const line of out.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const t = JSON.parse(trimmed);
      targets.push({
        udid: t.udid,
        name: t.name,
        state: t.state,
        os: t.os_version,
        type: t.type,
      });
    } catch {}
  }
  return targets;
}

export async function bootedSimulators(): Promise<SimTarget[]> {
  const all = await listTargets();
  return all.filter((t) => t.state === "Booted" && t.type === "simulator");
}
