#!/usr/bin/env bun
// Verify that network_start can be called multiple times without double-
// swizzling or otherwise destabilizing the URLProtocol chain. This protects
// against a class of regression where `ism_install_network_swizzles` would
// stash its own (already-swizzled) IMP as "original" on a second install,
// causing infinite recursion on the next URLSession config fetch.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function main() {
  const transport = new StdioClientTransport({
    command: "bun",
    args: ["run", new URL("../src/server.ts", import.meta.url).pathname],
  });
  const client = new Client({ name: "swiz", version: "0.0.1" }, { capabilities: {} });
  await client.connect(transport);

  const call = async (name: string, args: any = {}) => {
    const r: any = await client.callTool({ name, arguments: args });
    const text = (r.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
    return { text, isError: !!r.isError };
  };

  let pass = 0, fail = 0;
  const expect = (c: boolean, m: string) => { if (c) { pass++; console.log(`✓ ${m}`); } else { fail++; console.log(`✗ ${m}`); } };

  await call("terminate_app", { bundle_id: "com.apple.Preferences" }).catch(() => {});
  await new Promise(r => setTimeout(r, 250));
  await call("launch_app", { bundle_id: "com.apple.Preferences", inject: true, foreground_if_running: true });
  await call("await_quiescent", { stable_ms: 300, timeout_ms: 4000 });

  // 1. First start
  const s1 = await call("network_start");
  expect(!s1.isError, "first network_start succeeds");

  // 2. Second start — must not double-swizzle, must not throw
  const s2 = await call("network_start");
  expect(!s2.isError, "second network_start is idempotent");

  // 3. Third start with different options — accepts new config without re-swizzling
  const s3 = await call("network_start", { filter_url_substring: "httpbin", max_body_bytes: 32768 });
  expect(!s3.isError, "third start with new options succeeds");

  // 4. Fire a real request — verify the chain still works (would hang or
  //    recurse infinitely if the swizzle stashed its own IMP as "original")
  const t = await call("network_self_test", { url: "https://httpbin.org/get" });
  expect(/"status":\s*200/.test(t.text), "request still completes (no recursion)");

  // 5. Stop and restart — verify clean uninstall/reinstall cycle
  await call("network_stop");
  await call("network_start");
  const t2 = await call("network_self_test", { url: "https://httpbin.org/get" });
  expect(/"status":\s*200/.test(t2.text), "stop+start cycle still works");

  await call("network_stop");
  await client.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main().catch(e => { console.error("FAILED", e); process.exit(1); });
