#!/usr/bin/env bun
// Top-level smoke-test runner. Spawns each phase's smoke test as a child bun
// process and reports a one-line pass/fail summary per test plus an overall
// count. Designed to be the single "is this whole thing working?" command.
//
// Requires:
//   - A booted iOS simulator
//   - dylib built at dylib/build/libios-sim-mcp.dylib (run dylib/build.sh)
//   - Internet access (network test hits httpbin.org)

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";

interface TestSpec {
  file: string;
  label: string;
  needsInternet?: boolean;
  needsDylib?: boolean;
}

const TESTS: TestSpec[] = [
  { file: "smoke.ts",          label: "Layer 1 — snapshot/find/tap/scroll/screenshot" },
  { file: "text2.ts",          label: "type_text via paste + scroll regression" },
  { file: "paste_perfect.ts",  label: "byte-perfect typing (paste vs keystroke)", needsDylib: true },
  { file: "inject.ts",         label: "Layer 2a — dylib load + os_log",           needsDylib: true },
  { file: "dylib_2b.ts",       label: "Layer 2b — Unix socket RPC round-trip",    needsDylib: true },
  { file: "view_tree.ts",      label: "Layer 2c — view_tree + view_hit_test",     needsDylib: true },
  { file: "network_2d.ts",     label: "Layer 2d — HTTP capture via URLProtocol",  needsDylib: true, needsInternet: true },
  { file: "eval_js.ts",        label: "Layer 2e — JavaScriptCore eval bridge",    needsDylib: true },
  { file: "network_stubs.ts",  label: "Layer 2f — HTTP stubbing (canned responses)", needsDylib: true, needsInternet: true },
  { file: "productionize.ts",  label: "Productionization — universal dylib, health, crash safety", needsDylib: true },
];

const DYLIB_PATH = path.resolve(import.meta.dir, "../dylib/build/libios-sim-mcp.dylib");
const TEST_DIR = import.meta.dir;

function runOne(spec: TestSpec): Promise<{ ok: boolean; durationMs: number; lastLine: string }> {
  return new Promise((resolve) => {
    const child = spawn("bun", ["run", path.join(TEST_DIR, spec.file)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const t0 = Date.now();
    child.stdout.on("data", (b) => (stdout += b.toString()));
    child.stderr.on("data", (b) => (stderr += b.toString()));
    child.on("close", (code) => {
      const dt = Date.now() - t0;
      const combined = (stdout + "\n" + stderr).trim();
      const lines = combined.split("\n").filter(Boolean);
      // Pick the last informative line (skip pure newlines, ANSI).
      const lastLine = lines.length ? lines[lines.length - 1] : "(no output)";
      resolve({ ok: code === 0, durationMs: dt, lastLine });
    });
  });
}

async function main() {
  console.log("ios-sim-mcp test runner");
  console.log("─".repeat(60));

  // Preflight
  if (!existsSync(DYLIB_PATH)) {
    console.log(`⚠ dylib not built at ${DYLIB_PATH}`);
    console.log(`  Run: ./dylib/build.sh`);
    console.log(`  Dylib-dependent tests will fail.\n`);
  }

  const results: Array<{ spec: TestSpec; ok: boolean; durationMs: number; lastLine: string }> = [];
  for (const spec of TESTS) {
    process.stdout.write(`  ${spec.file.padEnd(22)} ${spec.label.slice(0, 50).padEnd(52)} … `);
    if (spec.needsDylib && !existsSync(DYLIB_PATH)) {
      console.log("SKIP (no dylib)");
      results.push({ spec, ok: false, durationMs: 0, lastLine: "skipped: no dylib built" });
      continue;
    }
    const r = await runOne(spec);
    results.push({ spec, ...r });
    const stamp = r.ok ? "✓" : "✗";
    const dur = `${(r.durationMs / 1000).toFixed(1)}s`;
    console.log(`${stamp} ${dur.padStart(6)}  ${r.lastLine.slice(0, 50)}`);
  }

  console.log("─".repeat(60));
  const pass = results.filter(r => r.ok).length;
  const fail = results.length - pass;
  const totalSec = (results.reduce((acc, r) => acc + r.durationMs, 0) / 1000).toFixed(1);
  console.log(`${pass}/${results.length} passed in ${totalSec}s`);
  if (fail > 0) {
    console.log("\nFailures:");
    for (const r of results) if (!r.ok) console.log(`  ✗ ${r.spec.file}: ${r.lastLine}`);
    process.exit(1);
  }
}

main().catch((e) => { console.error("runner failed:", e); process.exit(1); });
