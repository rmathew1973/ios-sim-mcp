import { createHash } from "node:crypto";
import { runIdb } from "./idb.js";

export interface AXElement {
  AXFrame: string;
  AXUniqueId: string | null;
  frame: { x: number; y: number; width: number; height: number };
  role_description: string;
  AXLabel: string | null;
  AXValue: string | null;
  type: string;
  role: string;
  subrole: string | null;
  title: string | null;
  help: string | null;
  enabled: boolean;
  content_required: boolean;
  custom_actions: string[];
  children?: AXElement[];
}

export interface RefEntry {
  ref: string;
  el: AXElement;
  depth: number;
  centerX: number;
  centerY: number;
  parentRef: string | null;
}

export interface Snapshot {
  version: number;
  udid: string;
  capturedAt: number;
  appName: string;
  screenW: number;
  screenH: number;
  entries: RefEntry[];
  byRef: Map<string, RefEntry>;
  byAXId: Map<string, RefEntry>;
  treeHash: string;
}

const ACTIONABLE_ROLES = new Set([
  "AXButton",
  "AXLink",
  "AXTextField",
  "AXTextArea",
  "AXSearchField",
  "AXSecureTextField",
  "AXSwitch",
  "AXCheckBox",
  "AXRadioButton",
  "AXSlider",
  "AXMenuItem",
  "AXPopUpButton",
  "AXTab",
  "AXCell",
  "AXSegmentedControl",
]);

let versionCounter = 0;

function isDegenerate(snap: Snapshot): boolean {
  if (snap.entries.length === 0) return true;
  if (snap.entries.length === 1 && snap.entries[0].el.role === "AXApplication") {
    const root = snap.entries[0].el;
    return !root.children || root.children.length === 0;
  }
  return false;
}

export async function captureSnapshot(udid: string, opts: { allowDegenerate?: boolean; retries?: number; retryDelayMs?: number } = {}): Promise<Snapshot> {
  const retries = opts.retries ?? 4;
  const delay = opts.retryDelayMs ?? 120;
  let snap: Snapshot | null = null;
  for (let i = 0; i <= retries; i++) {
    const out = await runIdb(["ui", "describe-all", "--udid", udid, "--nested"]);
    const tree = JSON.parse(out) as AXElement[];
    snap = buildSnapshot(udid, tree);
    if (opts.allowDegenerate || !isDegenerate(snap)) return snap;
    if (i < retries) await new Promise((r) => setTimeout(r, delay));
  }
  return snap!;
}

export function snapshotIsDegenerate(snap: Snapshot): boolean {
  return isDegenerate(snap);
}

function buildSnapshot(udid: string, roots: AXElement[]): Snapshot {
  const entries: RefEntry[] = [];
  const byRef = new Map<string, RefEntry>();
  const byAXId = new Map<string, RefEntry>();
  let refSeq = 0;
  let appName = "";
  let screenW = 0;
  let screenH = 0;

  const walk = (el: AXElement, depth: number, parentRef: string | null) => {
    const ref = `e${++refSeq}`;
    const cx = el.frame.x + el.frame.width / 2;
    const cy = el.frame.y + el.frame.height / 2;
    const entry: RefEntry = { ref, el, depth, centerX: cx, centerY: cy, parentRef };
    entries.push(entry);
    byRef.set(ref, entry);
    if (el.AXUniqueId) byAXId.set(el.AXUniqueId, entry);
    if (el.role === "AXApplication") {
      appName = el.AXLabel || appName;
      screenW = Math.max(screenW, el.frame.width);
      screenH = Math.max(screenH, el.frame.height);
    }
    if (el.children) for (const c of el.children) walk(c, depth + 1, ref);
  };

  for (const root of roots) walk(root, 0, null);

  const hashInput = entries
    .map((e) => `${e.el.role}|${e.el.AXLabel ?? ""}|${e.el.AXUniqueId ?? ""}|${e.el.AXValue ?? ""}|${e.el.enabled}|${Math.round(e.centerX)},${Math.round(e.centerY)}`)
    .join("\n");
  const treeHash = createHash("sha1").update(hashInput).digest("hex").slice(0, 12);

  return {
    version: ++versionCounter,
    udid,
    capturedAt: Date.now(),
    appName,
    screenW,
    screenH,
    entries,
    byRef,
    byAXId,
    treeHash,
  };
}

export function isActionable(el: AXElement): boolean {
  if (!el.enabled) return false;
  if (ACTIONABLE_ROLES.has(el.role)) return true;
  if (el.custom_actions && el.custom_actions.length > 0) return true;
  return false;
}

function shortRole(role: string): string {
  return role.startsWith("AX") ? role.slice(2) : role;
}

function truncate(s: string | null, max = 80): string {
  if (!s) return "";
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + "…" : oneLine;
}

export interface RenderOpts {
  filter?: "all" | "actionable" | "interactive";
  maxElements?: number;
}

export function renderSnapshot(snap: Snapshot, opts: RenderOpts = {}): string {
  const filter = opts.filter ?? "interactive";
  const max = opts.maxElements ?? 400;
  const lines: string[] = [];
  lines.push(`# ${snap.appName || "(no app)"}  screen=${snap.screenW}x${snap.screenH}  v=${snap.version}  hash=${snap.treeHash}  elements=${snap.entries.length}`);

  let shown = 0;
  for (const e of snap.entries) {
    if (shown >= max) {
      lines.push(`… (${snap.entries.length - shown} more elements omitted; raise maxElements or refine filter)`);
      break;
    }
    const el = e.el;
    if (filter === "actionable" && !isActionable(el)) continue;
    if (filter === "interactive") {
      const hasLabel = !!(el.AXLabel || el.AXValue || el.title);
      const isContainerNoise = (el.role === "AXGroup" || el.role === "AXOther") && !hasLabel && el.custom_actions.length === 0;
      if (isContainerNoise) continue;
    }
    shown++;
    const indent = "  ".repeat(Math.min(e.depth, 8));
    const role = shortRole(el.role);
    const id = el.AXUniqueId ? ` #${el.AXUniqueId}` : "";
    const label = truncate(el.AXLabel || el.title);
    const value = el.AXValue ? `  ="${truncate(el.AXValue, 60)}"` : "";
    const enabled = el.enabled ? "" : " [disabled]";
    const actions = el.custom_actions.length ? `  actions=[${el.custom_actions.join(",")}]` : "";
    const pos = `@(${Math.round(e.centerX)},${Math.round(e.centerY)})`;
    lines.push(`${indent}${e.ref} ${role}${enabled} "${label}"${id}${value} ${pos}${actions}`);
  }
  return lines.join("\n");
}

export interface FindQuery {
  id?: string;
  label?: string;
  labelContains?: string;
  role?: string;
  enabled?: boolean;
  actionable?: boolean;
}

export function findInSnapshot(snap: Snapshot, q: FindQuery): RefEntry[] {
  const labelContainsLower = q.labelContains?.toLowerCase();
  const labelLower = q.label?.toLowerCase();
  const roleNorm = q.role
    ? q.role.startsWith("AX")
      ? q.role
      : `AX${q.role[0].toUpperCase()}${q.role.slice(1)}`
    : undefined;

  return snap.entries.filter((e) => {
    const el = e.el;
    if (q.id && el.AXUniqueId !== q.id) return false;
    if (labelLower !== undefined && (el.AXLabel ?? "").toLowerCase() !== labelLower) return false;
    if (labelContainsLower !== undefined) {
      const hay = `${el.AXLabel ?? ""} ${el.AXValue ?? ""} ${el.title ?? ""}`.toLowerCase();
      if (!hay.includes(labelContainsLower)) return false;
    }
    if (roleNorm && el.role !== roleNorm) return false;
    if (q.enabled !== undefined && el.enabled !== q.enabled) return false;
    if (q.actionable && !isActionable(el)) return false;
    return true;
  });
}
