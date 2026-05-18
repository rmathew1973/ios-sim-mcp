#!/usr/bin/env bun
// Phase 2-productionize: verify the universal dylib loads, dylib_health
// reports cleanly in both available and unavailable states, error messages
// guide the caller, and the @try wraps make the dylib robust to misbehavior.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn } from "node:child_process";

async function main() {
  // Verify the dylib is genuinely universal.
  const lipoInfo = await new Promise<string>((resolve) => {
    const p = spawn("xcrun", ["lipo", "-info", new URL("../dylib/build/libios-sim-mcp.dylib", import.meta.url).pathname]);
    let buf = "";
    p.stdout.on("data", (b) => buf += b.toString());
    p.on("close", () => resolve(buf.trim()));
  });
  console.log("dylib arches:", lipoInfo);

  const transport = new StdioClientTransport({
    command: "bun",
    args: ["run", new URL("../src/server.ts", import.meta.url).pathname],
  });
  const client = new Client({ name: "prod", version: "0.0.1" }, { capabilities: {} });
  await client.connect(transport);

  const call = async (name: string, args: any = {}) => {
    const r: any = await client.callTool({ name, arguments: args });
    const text = (r.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
    console.log(`\n— ${name}${r.isError ? " [ERR]" : ""} —\n${text.slice(0, 1200)}`);
    return { text, isError: !!r.isError };
  };

  let pass = 0, fail = 0;
  const expect = (c: boolean, m: string) => { if (c) { pass++; console.log(`✓ ${m}`); } else { fail++; console.log(`✗ ${m}`); } };

  expect(/x86_64.*arm64|arm64.*x86_64/.test(lipoInfo), "universal dylib has both arm64 + x86_64 slices");

  // 1. dylib_health BEFORE any inject:true launch — should report unavailable gracefully
  const healthBefore = await call("dylib_health");
  expect(!healthBefore.isError, "dylib_health does not throw when dylib unavailable");
  expect(/"available":\s*false/.test(healthBefore.text), "dylib_health reports available:false");
  expect(/inject:true|reason/.test(healthBefore.text), "dylib_health includes a helpful reason");

  // 2. Try a dylib-only tool without inject — verify error message is actionable
  const noInject = await call("view_tree");
  expect(noInject.isError, "view_tree without inject errors");
  expect(/inject:true|launch_app|bundle_id/.test(noInject.text), "error message tells caller how to fix it");

  // 3. Launch injected and re-check health
  await call("terminate_app", { bundle_id: "com.apple.Preferences" }).catch(() => {});
  await new Promise(r => setTimeout(r, 250));
  await call("launch_app", { bundle_id: "com.apple.Preferences", inject: true, foreground_if_running: true });
  await call("await_quiescent", { stable_ms: 300, timeout_ms: 4000 });

  const healthAfter = await call("dylib_health");
  expect(/"available":\s*true/.test(healthAfter.text), "dylib_health reports available:true after inject");
  expect(/"bundle_id":\s*"com\.apple\.Preferences"/.test(healthAfter.text), "health reports bundle_id");
  expect(/"phase":\s*"2f"/.test(healthAfter.text), "health reports phase 2f");
  expect(/"methods_count":\s*\d+/.test(healthAfter.text), "health reports method count");

  // 4. Trigger an intentional bad-params exception to confirm @try wrap surfaces clean error
  const badCall = await call("dylib_call", { method: "view_set_text", params: {} }); // missing required text
  expect(badCall.isError, "missing-required-param errors instead of crashing host app");

  // 5. View tree should still work after the failed call (proves nothing died)
  const treeAfter = await call("view_tree", { max_lines: 5 });
  expect(!treeAfter.isError, "view_tree still works after a failed dylib_call");

  await client.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main().catch(e => { console.error("FAILED", e); process.exit(1); });
