#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DYLIB_PATH = path.resolve(__dirname, "../dylib/build/libios-sim-mcp.dylib");

import { bootedSimulators, listTargets } from "./idb.js";
import { state, requireUdid } from "./state.js";
import { captureSnapshot, renderSnapshot, findInSnapshot, isActionable, type RefEntry } from "./snapshot.js";
import * as actions from "./actions.js";
import { startLogStream, stopLogStream, tailLogs, clearLogs } from "./logs.js";

const HID_KEYS: Record<string, number> = {
  RETURN: 40, ENTER: 40,
  ESCAPE: 41, ESC: 41,
  DELETE: 42, BACKSPACE: 42,
  TAB: 43,
  SPACE: 44,
  CAPS_LOCK: 57,
  F1: 58, F2: 59, F3: 60, F4: 61, F5: 62, F6: 63,
  F7: 64, F8: 65, F9: 66, F10: 67, F11: 68, F12: 69,
  RIGHT: 79, LEFT: 80, DOWN: 81, UP: 82,
  LEFT_CONTROL: 224, LEFT_SHIFT: 225, LEFT_ALT: 226, LEFT_GUI: 227,
};

async function ensureUdid(): Promise<string> {
  if (state.udid) return state.udid;
  const booted = await bootedSimulators();
  if (booted.length === 1) {
    state.udid = booted[0].udid;
    return state.udid;
  }
  if (booted.length === 0) throw new Error("No booted iOS simulators. Boot one via Xcode or `xcrun simctl boot <udid>`.");
  throw new Error(`Multiple booted simulators (${booted.map(b => `${b.name}=${b.udid}`).join(", ")}). Call use_simulator first.`);
}

async function freshSnapshot(force = false) {
  const udid = await ensureUdid();
  if (!force && state.lastSnapshot && state.lastSnapshot.udid === udid) {
    return state.lastSnapshot;
  }
  const snap = await captureSnapshot(udid);
  state.lastSnapshot = snap;
  return snap;
}

function resolveTarget(args: { ref?: string; id?: string; x?: number; y?: number }): { x: number; y: number; via: string } {
  if (args.x !== undefined && args.y !== undefined) return { x: args.x, y: args.y, via: `point(${args.x},${args.y})` };
  const snap = state.lastSnapshot;
  if (!snap) throw new Error("No cached snapshot. Call snapshot first, or pass {x,y}.");
  let entry: RefEntry | undefined;
  if (args.ref) entry = snap.byRef.get(args.ref);
  else if (args.id) entry = snap.byAXId.get(args.id);
  if (!entry) {
    if (args.ref) throw new Error(`Unknown ref "${args.ref}" in snapshot v${snap.version}. Re-snapshot if the UI changed.`);
    if (args.id) throw new Error(`No element with AXUniqueId "${args.id}" in snapshot v${snap.version}.`);
    throw new Error("Pass one of: ref, id, or (x,y).");
  }
  return { x: entry.centerX, y: entry.centerY, via: `${entry.ref}/${entry.el.AXUniqueId ?? entry.el.AXLabel ?? entry.el.role}` };
}

function txt(s: string) { return { content: [{ type: "text" as const, text: s }] }; }
function err(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  return { content: [{ type: "text" as const, text: `ERROR: ${msg}` }], isError: true };
}

const server = new McpServer({ name: "ios-sim-mcp", version: "0.1.0" });

server.registerTool("list_simulators", {
  description: "List iOS simulators (booted and shutdown). Returns udid, name, state, os_version.",
  inputSchema: { bootedOnly: z.boolean().optional() },
}, async ({ bootedOnly }) => {
  try {
    const all = await listTargets();
    const sims = all.filter(t => t.type === "simulator");
    const filtered = bootedOnly ? sims.filter(s => s.state === "Booted") : sims;
    if (!filtered.length) return txt("(no simulators found)");
    const lines = filtered.map(s => `${s.state === "Booted" ? "●" : "○"} ${s.name}  os=${s.os}  udid=${s.udid}`);
    if (state.udid) lines.unshift(`[selected: ${state.udid}]`);
    return txt(lines.join("\n"));
  } catch (e) { return err(e); }
});

server.registerTool("use_simulator", {
  description: "Select a specific simulator by UDID for subsequent calls. If only one is booted, auto-selection happens on first action — you only need this when multiple are booted.",
  inputSchema: { udid: z.string() },
}, async ({ udid }) => {
  try {
    state.udid = udid;
    state.lastSnapshot = null;
    return txt(`Selected ${udid}`);
  } catch (e) { return err(e); }
});

server.registerTool("snapshot", {
  description: "Capture the simulator's accessibility tree and return it with stable refs (e1, e2, ...). Subsequent tap/type/swipe accept refs. Default filter 'interactive' hides decorative containers; use 'all' for everything, 'actionable' for only tappable controls. Always call this before acting on UI.",
  inputSchema: {
    filter: z.enum(["all", "interactive", "actionable"]).optional(),
    maxElements: z.number().int().positive().optional(),
    force: z.boolean().optional(),
  },
}, async ({ filter, maxElements, force }) => {
  try {
    const snap = await freshSnapshot(force ?? true);
    return txt(renderSnapshot(snap, { filter: filter ?? "interactive", maxElements }));
  } catch (e) { return err(e); }
});

server.registerTool("find", {
  description: "Search the most recent snapshot for elements. Combine fields with AND. 'id' matches AXUniqueId exactly. 'label' is exact match; 'labelContains' is case-insensitive substring across label/value/title. 'role' accepts 'Button', 'TextField' etc (with or without AX prefix). Auto-snapshots if none cached.",
  inputSchema: {
    id: z.string().optional(),
    label: z.string().optional(),
    labelContains: z.string().optional(),
    role: z.string().optional(),
    actionable: z.boolean().optional(),
    limit: z.number().int().positive().optional(),
  },
}, async (q) => {
  try {
    if (!state.lastSnapshot) await freshSnapshot(true);
    const snap = state.lastSnapshot!;
    const matches = findInSnapshot(snap, q);
    const lim = q.limit ?? 25;
    const shown = matches.slice(0, lim);
    if (!matches.length) {
      const ageMs = Date.now() - snap.capturedAt;
      const hint = snap.entries.length <= 1
        ? " — snapshot looks empty, the screen may have changed; call snapshot first"
        : ageMs > 5000 ? ` — snapshot is ${Math.round(ageMs/1000)}s old, consider re-snapshotting` : "";
      return txt(`(no matches in snapshot v${snap.version}, ${snap.entries.length} elements${hint})`);
    }
    const lines = shown.map(e => {
      const el = e.el;
      const id = el.AXUniqueId ? ` #${el.AXUniqueId}` : "";
      const label = (el.AXLabel || el.title || "").replace(/\s+/g, " ").trim();
      return `${e.ref} ${el.role.replace(/^AX/, "")} "${label.slice(0,80)}"${id} @(${Math.round(e.centerX)},${Math.round(e.centerY)})${isActionable(el) ? "" : " (non-actionable)"}`;
    });
    if (matches.length > lim) lines.push(`… ${matches.length - lim} more (raise limit)`);
    return txt(lines.join("\n"));
  } catch (e) { return err(e); }
});

server.registerTool("tap", {
  description: "Tap an element. Pass one of: {ref} from latest snapshot, {id} for AXUniqueId, or {x,y} for raw coordinates. Optional 'duration' (seconds) makes it a long-press.",
  inputSchema: {
    ref: z.string().optional(),
    id: z.string().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    duration: z.number().positive().optional(),
  },
}, async (args) => {
  try {
    const udid = await ensureUdid();
    const { x, y, via } = resolveTarget(args);
    await actions.tapPoint(udid, x, y, args.duration);
    return txt(`tapped ${via}${args.duration ? ` (${args.duration}s)` : ""}`);
  } catch (e) { return err(e); }
});

server.registerTool("type_text", {
  description: "Type text via the simulator keyboard. By default the currently focused field receives it. Pass ref/id to tap a field first, then type. Newlines/tabs aren't interpreted — use the key tool for RETURN/TAB. If you type and nothing visibly changes, the field probably wasn't focused: tap it then re-snapshot.",
  inputSchema: {
    text: z.string(),
    ref: z.string().optional(),
    id: z.string().optional(),
  },
}, async ({ text, ref, id }) => {
  try {
    const udid = await ensureUdid();
    if (ref || id) {
      const t = resolveTarget({ ref, id });
      await actions.tapPoint(udid, t.x, t.y);
      await new Promise(r => setTimeout(r, 200));
    }
    await actions.typeText(udid, text);
    return txt(`typed ${text.length} chars${ref || id ? ` into ${ref ?? id}` : ""}`);
  } catch (e) { return err(e); }
});

server.registerTool("key", {
  description: "Press a single key. Pass either {name} (RETURN, ESCAPE, DELETE, TAB, SPACE, F1-F12, UP/DOWN/LEFT/RIGHT) or {code} (raw HID usage code).",
  inputSchema: { name: z.string().optional(), code: z.number().int().optional() },
}, async ({ name, code }) => {
  try {
    const udid = await ensureUdid();
    let kc = code;
    if (kc === undefined && name) {
      kc = HID_KEYS[name.toUpperCase()];
      if (kc === undefined) throw new Error(`Unknown key name "${name}". Known: ${Object.keys(HID_KEYS).join(", ")}`);
    }
    if (kc === undefined) throw new Error("Pass name or code.");
    await actions.pressKey(udid, kc);
    return txt(`pressed key ${name ?? code}`);
  } catch (e) { return err(e); }
});

server.registerTool("button", {
  description: "Press a hardware button: HOME, LOCK, SIDE_BUTTON, SIRI, APPLE_PAY.",
  inputSchema: { name: z.string() },
}, async ({ name }) => {
  try {
    const udid = await ensureUdid();
    await actions.pressButton(udid, name);
    return txt(`pressed button ${name.toUpperCase()}`);
  } catch (e) { return err(e); }
});

server.registerTool("swipe", {
  description: "Swipe from one point to another. Pass from_ref/from_id or from_x+from_y AND to_ref/to_id or to_x+to_y. Optional duration (seconds) and delta (px step).",
  inputSchema: {
    from_ref: z.string().optional(),
    from_id: z.string().optional(),
    from_x: z.number().optional(),
    from_y: z.number().optional(),
    to_ref: z.string().optional(),
    to_id: z.string().optional(),
    to_x: z.number().optional(),
    to_y: z.number().optional(),
    duration: z.number().positive().optional(),
    delta: z.number().positive().optional(),
  },
}, async (a) => {
  try {
    const udid = await ensureUdid();
    const from = resolveTarget({ ref: a.from_ref, id: a.from_id, x: a.from_x, y: a.from_y });
    const to = resolveTarget({ ref: a.to_ref, id: a.to_id, x: a.to_x, y: a.to_y });
    await actions.swipe(udid, from.x, from.y, to.x, to.y, { duration: a.duration, delta: a.delta });
    return txt(`swiped ${from.via} -> ${to.via}`);
  } catch (e) { return err(e); }
});

server.registerTool("scroll", {
  description: "Scroll a scrollable view. Direction is reader-perspective: 'down' reveals content below (finger drags up); 'up' reveals content above. Optional 'ref' or 'id' to anchor the gesture on a specific scrollable; otherwise uses screen center. 'distance' px (default 300). Default 0.4s duration ensures iOS treats it as a pan, not a tap.",
  inputSchema: {
    direction: z.enum(["up", "down", "left", "right"]),
    ref: z.string().optional(),
    id: z.string().optional(),
    distance: z.number().positive().optional(),
    duration: z.number().positive().optional(),
  },
}, async ({ direction, ref, id, distance, duration }) => {
  try {
    const udid = await ensureUdid();
    let cx: number, cy: number;
    if (ref || id) {
      const t = resolveTarget({ ref, id });
      cx = t.x; cy = t.y;
    } else {
      const snap = state.lastSnapshot ?? await freshSnapshot(true);
      cx = snap.screenW / 2; cy = snap.screenH / 2;
    }
    const d = distance ?? 300;
    let fx = cx, fy = cy, tx = cx, ty = cy;
    // direction = reader perspective. "down" means see-more-below, so finger drags UP.
    if (direction === "down") { fy = cy + d/2; ty = cy - d/2; }
    if (direction === "up")   { fy = cy - d/2; ty = cy + d/2; }
    if (direction === "right") { fx = cx + d/2; tx = cx - d/2; }
    if (direction === "left")  { fx = cx - d/2; tx = cx + d/2; }
    await actions.swipe(udid, fx, fy, tx, ty, { duration: duration ?? 0.4 });
    return txt(`scrolled ${direction} ${d}px around (${Math.round(cx)},${Math.round(cy)})`);
  } catch (e) { return err(e); }
});

server.registerTool("launch_app", {
  description: "Launch an app by bundle id (com.example.App). 'foreground_if_running' terminates first. 'inject' loads the Layer 2 dylib (default path: dylib/build/libios-sim-mcp.dylib relative to the server) via SIMCTL_CHILD_DYLD_INSERT_LIBRARIES — currently just emits a lifecycle log line; future phases add a Unix socket. 'inject_dylib' overrides the dylib path. Inject requires the dylib to be built (run dylib/build.sh).",
  inputSchema: {
    bundle_id: z.string(),
    foreground_if_running: z.boolean().optional(),
    inject: z.boolean().optional(),
    inject_dylib: z.string().optional(),
  },
}, async ({ bundle_id, foreground_if_running, inject, inject_dylib }) => {
  try {
    const udid = await ensureUdid();
    if (foreground_if_running) {
      try { await actions.terminateApp(udid, bundle_id); } catch {}
    }
    let dylib: string | undefined;
    if (inject_dylib) dylib = inject_dylib;
    else if (inject) dylib = DEFAULT_DYLIB_PATH;
    if (dylib) {
      try { await fs.access(dylib); }
      catch { throw new Error(`Dylib not found at ${dylib}. Run dylib/build.sh first.`); }
    }
    await actions.launchApp(udid, bundle_id, { injectDylib: dylib, terminateRunning: foreground_if_running });
    return txt(`launched ${bundle_id}${dylib ? ` (injected ${path.basename(dylib)})` : ""}`);
  } catch (e) { return err(e); }
});

server.registerTool("terminate_app", {
  description: "Terminate an app by bundle id.",
  inputSchema: { bundle_id: z.string() },
}, async ({ bundle_id }) => {
  try {
    const udid = await ensureUdid();
    await actions.terminateApp(udid, bundle_id);
    return txt(`terminated ${bundle_id}`);
  } catch (e) { return err(e); }
});

server.registerTool("screenshot", {
  description: "Capture a screenshot. If 'path' is provided, saves PNG and returns the path. Otherwise saves to a temp file and returns both the path and the image inline. Use sparingly — the AX tree is faster and richer for control flow.",
  inputSchema: { path: z.string().optional() },
}, async ({ path: outPath }) => {
  try {
    const udid = await ensureUdid();
    const target = outPath ?? path.join(os.tmpdir(), `ios-sim-${Date.now()}.png`);
    await actions.screenshot(udid, target);
    if (outPath) return txt(`saved screenshot -> ${target}`);
    const bytes = await fs.readFile(target);
    return {
      content: [
        { type: "text" as const, text: `screenshot saved -> ${target}` },
        { type: "image" as const, data: bytes.toString("base64"), mimeType: "image/png" },
      ],
    };
  } catch (e) { return err(e); }
});

server.registerTool("await_quiescent", {
  description: "Block until the accessibility tree stops changing (UI settles). Returns when the tree hash is identical for 'stable_ms' (default 250) consecutive ms, or 'timeout_ms' elapses (default 5000). Use after launch_app, navigation, or async loads instead of sleep.",
  inputSchema: {
    stable_ms: z.number().int().positive().optional(),
    timeout_ms: z.number().int().positive().optional(),
    poll_ms: z.number().int().positive().optional(),
  },
}, async ({ stable_ms, timeout_ms, poll_ms }) => {
  try {
    const udid = await ensureUdid();
    const r = await actions.awaitQuiescent(udid, { stableMs: stable_ms, timeoutMs: timeout_ms, pollMs: poll_ms });
    return txt(`${r.stable ? "stable" : "TIMEOUT"} hash=${r.finalHash} samples=${r.samples} elapsed=${r.elapsedMs}ms`);
  } catch (e) { return err(e); }
});

server.registerTool("log_start", {
  description: "Start streaming os_log from the simulator into an in-memory buffer (5000 lines max). Optional bundle_id filters by subsystem substring. Level: default|info|debug.",
  inputSchema: {
    bundle_id: z.string().optional(),
    level: z.enum(["default", "info", "debug"]).optional(),
    predicate: z.string().optional(),
  },
}, async (opts) => {
  try {
    const udid = await ensureUdid();
    startLogStream(udid, { bundleId: opts.bundle_id, level: opts.level, predicate: opts.predicate });
    return txt(`log stream started${opts.bundle_id ? ` (filter: ${opts.bundle_id})` : ""}`);
  } catch (e) { return err(e); }
});

server.registerTool("log_tail", {
  description: "Return the last N lines from the log buffer (default 100). Requires log_start first.",
  inputSchema: { lines: z.number().int().positive().optional() },
}, async ({ lines }) => {
  try {
    if (!state.logProc && state.logBuffer.length === 0) return txt("(log stream not started; call log_start first)");
    const ls = tailLogs(lines ?? 100);
    return txt(ls.length ? ls.join("\n") : "(buffer empty)");
  } catch (e) { return err(e); }
});

server.registerTool("log_stop", {
  description: "Stop the log stream subprocess. Buffer is preserved until log_clear or log_start.",
  inputSchema: {},
}, async () => {
  try { stopLogStream(); return txt("log stream stopped"); } catch (e) { return err(e); }
});

server.registerTool("log_clear", {
  description: "Clear the in-memory log buffer.",
  inputSchema: {},
}, async () => {
  try { clearLogs(); return txt("log buffer cleared"); } catch (e) { return err(e); }
});

const transport = new StdioServerTransport();
await server.connect(transport);
