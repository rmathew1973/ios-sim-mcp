#!/usr/bin/env bun
// Phase 2b smoke test: launch Settings injected, round-trip ping + info over
// the Unix socket, verify the dylib responds and the metadata is sane.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function main() {
  const transport = new StdioClientTransport({
    command: "bun",
    args: ["run", new URL("../src/server.ts", import.meta.url).pathname],
  });
  const client = new Client({ name: "dylib-2b", version: "0.0.1" }, { capabilities: {} });
  await client.connect(transport);

  const call = async (name: string, args: any = {}) => {
    const t0 = Date.now();
    const r: any = await client.callTool({ name, arguments: args });
    const dt = Date.now() - t0;
    const text = (r.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
    console.log(`\n— ${name} (${dt}ms)${r.isError ? " [ERR]" : ""} —`);
    console.log(text.length > 2000 ? text.slice(0, 2000) + ` …(${text.length - 2000} more)` : text);
    return { text, isError: !!r.isError };
  };

  let failures = 0;
  const expect = (cond: boolean, msg: string) => { if (!cond) { failures++; console.log(`✗ ${msg}`); } else console.log(`✓ ${msg}`); };

  await call("terminate_app", { bundle_id: "com.apple.Preferences" }).catch(() => {});
  await new Promise(r => setTimeout(r, 250));
  await call("launch_app", { bundle_id: "com.apple.Preferences", inject: true, foreground_if_running: true });

  // Round 1: ping with echo
  const ping = await call("dylib_ping", { echo: "hello-2b" });
  expect(!ping.isError, "ping succeeded");
  expect(/"pong":\s*true/.test(ping.text), "response carries pong:true");
  expect(/"echo":\s*"hello-2b"/.test(ping.text), "echo round-trip preserved");
  expect(/RTT \d+ms/.test(ping.text), "RTT measured");

  // Round 2: info
  const info = await call("dylib_info", {});
  expect(!info.isError, "info succeeded");
  expect(/"bundle_id":\s*"com\.apple\.Preferences"/.test(info.text), "info reports bundle_id");
  expect(/"phase":\s*"2[a-z]"/.test(info.text), "info reports a Layer-2 phase tag");
  expect(/"methods":\s*\[/.test(info.text), "info reports methods array");

  // Round 3: generic dylib_call to an unknown method, expect a graceful error w/ available list
  const bad = await call("dylib_call", { method: "totally_not_a_method" });
  expect(bad.isError, "unknown method surfaces as error");
  expect(/unknown method/.test(bad.text), "error message names the issue");

  // Round 4: 10 pings in a row to confirm the socket is reusable + measure throughput
  const t0 = Date.now();
  for (let i = 0; i < 10; i++) {
    const r: any = await client.callTool({ name: "dylib_ping", arguments: { echo: `i=${i}` } });
    expect(!r.isError, `loop ping ${i} ok`);
  }
  const dtTotal = Date.now() - t0;
  console.log(`\n10 sequential pings took ${dtTotal}ms (avg ${Math.round(dtTotal / 10)}ms each, includes MCP overhead)`);

  await client.close();
  if (failures) { console.log(`\n✗ ${failures} expectation(s) failed`); process.exit(1); }
  console.log("\n✓ Phase 2b verified end-to-end");
}

main().catch(e => { console.error("FAILED", e); process.exit(1); });
