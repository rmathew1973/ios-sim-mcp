#!/usr/bin/env bun
// Phase 2e smoke test: eval_js bridges + return-value coercion + state
// persistence + exception handling + reset.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function main() {
  const transport = new StdioClientTransport({
    command: "bun",
    args: ["run", new URL("../src/server.ts", import.meta.url).pathname],
  });
  const client = new Client({ name: "eval-2e", version: "0.0.1" }, { capabilities: {} });
  await client.connect(transport);

  const call = async (name: string, args: any = {}) => {
    const t0 = Date.now();
    const r: any = await client.callTool({ name, arguments: args });
    const dt = Date.now() - t0;
    const text = (r.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
    console.log(`\n— ${name} (${dt}ms)${r.isError ? " [ERR]" : ""} —`);
    console.log(text.length > 1800 ? text.slice(0, 1800) + ` …(${text.length - 1800} more)` : text);
    return { text, isError: !!r.isError };
  };

  let pass = 0, fail = 0;
  const expect = (cond: boolean, msg: string) => { if (cond) { pass++; console.log(`✓ ${msg}`); } else { fail++; console.log(`✗ ${msg}`); } };

  await call("terminate_app", { bundle_id: "com.apple.Preferences" }).catch(() => {});
  await new Promise(r => setTimeout(r, 250));
  await call("launch_app", { bundle_id: "com.apple.Preferences", inject: true, foreground_if_running: true });
  await call("await_quiescent", { stable_ms: 300, timeout_ms: 4000 });

  // 1. Arithmetic — primitive number return.
  const r1 = await call("eval_js", { code: "1 + 2 * 3" });
  expect(!r1.isError && /kind=number/.test(r1.text) && /\b7\b/.test(r1.text), "arithmetic returns number");

  // 2. String concat.
  const r2 = await call("eval_js", { code: "['hello', 'world'].join(' ')" });
  expect(/kind=string/.test(r2.text) && /hello world/.test(r2.text), "string return");

  // 3. Bridged: bundle identifier.
  const r3 = await call("eval_js", { code: "bundle.bundleIdentifier" });
  expect(/com\.apple\.Preferences/.test(r3.text), "bundle.bundleIdentifier reads through to bundle");

  // 4. Bridged: app.windows.length.
  const r4 = await call("eval_js", { code: "app.windows.length" });
  expect(/kind=number/.test(r4.text), "app.windows.length returns a number");

  // 5. Bridged: process.processName.
  const r5 = await call("eval_js", { code: "process.processName" });
  expect(/Preferences/.test(r5.text), "process.processName == Preferences");

  // 6. ObjC bridged object: key_window() returns a UIWindow described as objc.
  const r6 = await call("eval_js", { code: "key_window()" });
  expect(/kind=objc/.test(r6.text) || /UIWindow/.test(r6.text), "key_window() returns an objc-bridged window");

  // 7. State persistence: define a fn in one call, use it in next.
  const r7a = await call("eval_js", { code: "function double(x){return x*2;}; 'defined'" });
  expect(/defined/.test(r7a.text), "function definition returns sentinel");
  const r7b = await call("eval_js", { code: "double(21)" });
  expect(/kind=number/.test(r7b.text) && /\b42\b/.test(r7b.text), "persisted function call returns 42");

  // 8. Exception: syntax error returns clean exception.
  const r8 = await call("eval_js", { code: "this is not js!!" });
  expect(/EXCEPTION/.test(r8.text), "syntax error reported as exception");

  // 9. Exception: thrown runtime error.
  const r9 = await call("eval_js", { code: "throw new Error('boom')" });
  expect(/EXCEPTION/.test(r9.text) && /boom/.test(r9.text), "runtime throw reported with message");

  // 10. Defaults round-trip — set then read back. JSC turns `setObject:forKey:`
  //     into `setObjectForKey(value, key)` (selector colons → camelCase).
  await call("eval_js", { code: "defaults.setObjectForKey('ios-sim-mcp-was-here', 'ism_test_key')" });
  const r10 = await call("eval_js", { code: "defaults.stringForKey('ism_test_key')" });
  expect(/ios-sim-mcp-was-here/.test(r10.text), "NSUserDefaults set/get round-trips through JS");

  // 11. Reset clears state.
  await call("eval_js_reset");
  const r11 = await call("eval_js", { code: "typeof double" });
  expect(/undefined/.test(r11.text), "after reset, previously-defined function is gone");

  // 12. Helper: find a known view class in Settings.
  const r12 = await call("eval_js", { code: "var v = find_view_by_class('UIWindow'); v ? v.constructor.name || 'found' : 'missing'" });
  expect(/kind=string/.test(r12.text) && !/missing/.test(r12.text), "find_view_by_class('UIWindow') returns a view");

  await client.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main().catch(e => { console.error("FAILED", e); process.exit(1); });
