// MCP-side client for the Layer 2 dylib's Unix-socket JSON-Lines RPC.
//
// Lifecycle:
//   - Created lazily on first dylib_* tool call against a bundle id.
//   - Cached in state.dylibClients keyed by bundle id.
//   - Auto-evicted when the socket closes (e.g. app exit or relaunch).
//   - Reconnect happens on next call (DylibClient.connect retries until socket
//     appears or deadline elapses).

import { Socket } from "node:net";
import { promises as fs } from "node:fs";

export interface DylibCallOpts { timeoutMs?: number; }
export interface DylibClientOpts {
  bundleId: string;
  socketPath?: string;
  connectTimeoutMs?: number;
  defaultCallTimeoutMs?: number;
}

interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  method: string;
}

function defaultSocketPath(bundleId: string): string {
  // Mirror the dylib's sanitization in ism_socket_path_for_bundle.
  const safe = bundleId.replace(/[\\/\\\\:?*"<>| ]/g, "_");
  return `/tmp/ios-sim-mcp-${safe}.sock`;
}

export class DylibClient {
  readonly bundleId: string;
  readonly socketPath: string;
  private readonly connectTimeoutMs: number;
  private readonly defaultCallTimeoutMs: number;

  private socket: Socket | null = null;
  private buffer = "";
  private pending = new Map<number, Pending>();
  private nextId = 1;

  constructor(opts: DylibClientOpts) {
    this.bundleId = opts.bundleId;
    this.socketPath = opts.socketPath ?? defaultSocketPath(opts.bundleId);
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 4000;
    this.defaultCallTimeoutMs = opts.defaultCallTimeoutMs ?? 5000;
  }

  isConnected(): boolean { return this.socket !== null; }

  async connect(): Promise<void> {
    if (this.socket) return;
    const deadline = Date.now() + this.connectTimeoutMs;
    let lastErr: Error | null = null;
    while (Date.now() < deadline) {
      try { await fs.access(this.socketPath); }
      catch { await sleep(80); continue; }
      try { await this.openSocket(); return; }
      catch (e) { lastErr = e as Error; await sleep(80); }
    }
    const tail = lastErr
      ? `: ${lastErr.message}`
      : `\nLikely causes:\n` +
        `  1. App was not launched with inject:true (use launch_app({bundle_id, inject:true}))\n` +
        `  2. App crashed before the dylib's socket constructor ran (check log_tail for ios-sim-mcp lifecycle line)\n` +
        `  3. Dylib not built — run dylib/build.sh and relaunch`;
    throw new Error(
      `Could not connect to dylib socket at ${this.socketPath} within ${this.connectTimeoutMs}ms${tail}`,
    );
  }

  private openSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = new Socket();
      const onErrInitial = (e: Error) => { sock.destroy(); reject(e); };
      sock.once("error", onErrInitial);
      sock.once("connect", () => {
        sock.off("error", onErrInitial);
        this.socket = sock;
        sock.on("data", (b) => this.onData(b));
        sock.on("close", () => this.onClose());
        sock.on("error", () => { /* fail individual calls, not the process */ });
        resolve();
      });
      sock.connect(this.socketPath);
    });
  }

  private onData(b: Buffer) {
    this.buffer += b.toString("utf8");
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (!line.trim()) continue;
      let msg: any;
      try { msg = JSON.parse(line); } catch { continue; }
      const id = msg?.id;
      if (typeof id !== "number") continue;
      const pending = this.pending.get(id);
      if (!pending) continue;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      if (msg.error !== undefined) pending.reject(new Error(String(msg.error)));
      else pending.resolve(msg.result);
    }
  }

  private onClose() {
    this.socket = null;
    this.buffer = "";
    const err = new Error("dylib socket closed before response");
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  async call(method: string, params: any = {}, opts: DylibCallOpts = {}): Promise<any> {
    if (!this.socket) throw new Error(`Not connected to dylib for ${this.bundleId}`);
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params }) + "\n";
    const timeoutMs = opts.timeoutMs ?? this.defaultCallTimeoutMs;
    const promise = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`dylib call ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
    });
    this.socket.write(payload);
    return promise;
  }

  close(): void {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("client closed"));
    }
    this.pending.clear();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
