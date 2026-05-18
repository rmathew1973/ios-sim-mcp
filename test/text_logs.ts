#!/usr/bin/env bun
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function main() {
  const transport = new StdioClientTransport({
    command: "bun",
    args: ["run", new URL("../src/server.ts", import.meta.url).pathname],
  });
  const client = new Client({ name: "text-logs-test", version: "0.0.1" }, { capabilities: {} });
  await client.connect(transport);

  const call = async (name: string, args: any = {}) => {
    const t0 = Date.now();
    const r: any = await client.callTool({ name, arguments: args });
    const dt = Date.now() - t0;
    const text = (r.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
    console.log(`\n— ${name} (${dt}ms)${r.isError ? " [ERROR]" : ""} —`);
    console.log(text.length > 1500 ? text.slice(0, 1500) + `\n…(${text.length - 1500} more)` : text);
    return { r, text };
  };

  // Logs: start streaming, launch an app, see what we get
  await call("log_start", { level: "default" });
  await call("launch_app", { bundle_id: "com.apple.Preferences", foreground_if_running: true });
  await call("await_quiescent", { stable_ms: 250, timeout_ms: 4000 });
  await call("snapshot", { filter: "actionable", maxElements: 20 });

  // Text input via the Settings search field
  await call("find", { role: "TextField" });
  await call("tap", { labelContains: "Search" }); // wrong shape on purpose — tap doesn't take labelContains
  // try again properly: find the search field by AX id "Search" or AXLabel "Search"
  await call("find", { label: "Search" });
  // tap by ref from latest find via re-snapshot
  await call("snapshot", { filter: "all", maxElements: 50 });
  await call("find", { labelContains: "Search", role: "TextField" });
  await call("tap", { id: "Search" }); // many Settings have AXUniqueId of the field itself
  await call("await_quiescent", { stable_ms: 200, timeout_ms: 2000 });
  await call("type_text", { text: "wifi" });
  await call("await_quiescent", { stable_ms: 300, timeout_ms: 2500 });
  await call("snapshot", { filter: "interactive", maxElements: 25 });

  // Scroll regression test — make sure scroll doesn't navigate to a child page
  await call("key", { name: "RETURN" });
  await call("button", { name: "HOME" });
  await call("await_quiescent", { stable_ms: 200, timeout_ms: 2000 });

  await call("log_tail", { lines: 15 });
  await call("log_stop");

  await client.close();
  console.log("\n✓ done");
}

main().catch(e => { console.error("FAILED", e); process.exit(1); });
