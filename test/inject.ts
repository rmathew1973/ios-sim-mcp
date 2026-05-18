#!/usr/bin/env bun
// Phase 2a smoke test: launch Settings with the dylib injected, confirm the
// constructor's os_log line appears in the Layer 3 log stream.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function main() {
  const transport = new StdioClientTransport({
    command: "bun",
    args: ["run", new URL("../src/server.ts", import.meta.url).pathname],
  });
  const client = new Client({ name: "inject-test", version: "0.0.1" }, { capabilities: {} });
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

  // Filter for our dylib's subsystem so the buffer isn't drowned in unrelated noise.
  await call("log_start", { predicate: 'subsystem == "com.hmbsoftware.ios-sim-mcp"', level: "debug" });
  await call("terminate_app", { bundle_id: "com.apple.Preferences" }).catch(() => {});
  await new Promise(r => setTimeout(r, 300));
  await call("launch_app", { bundle_id: "com.apple.Preferences", inject: true, foreground_if_running: true });
  await new Promise(r => setTimeout(r, 1200)); // give os_log time to flush
  const { text } = await call("log_tail", { lines: 50 });
  await call("log_stop");
  await client.close();

  if (/ios-sim-mcp dylib loaded/.test(text)) {
    console.log("\n✓ Phase 2a verified: dylib constructor ran inside Settings");
    process.exit(0);
  } else {
    console.log("\n✗ FAILED: did not see 'ios-sim-mcp dylib loaded' in log output");
    process.exit(1);
  }
}

main().catch(e => { console.error("FAILED", e); process.exit(1); });
