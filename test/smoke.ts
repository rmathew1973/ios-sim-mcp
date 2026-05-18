#!/usr/bin/env bun
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function ms() { return Date.now(); }

async function main() {
  const transport = new StdioClientTransport({
    command: "bun",
    args: ["run", new URL("../src/server.ts", import.meta.url).pathname],
  });
  const client = new Client({ name: "smoke", version: "0.0.1" }, { capabilities: {} });
  await client.connect(transport);

  const tools = await client.listTools();
  console.log(`✓ connected. tools: ${tools.tools.map(t => t.name).join(", ")}`);

  const call = async (name: string, args: any = {}) => {
    const t0 = ms();
    const r: any = await client.callTool({ name, arguments: args });
    const dt = ms() - t0;
    const text = (r.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
    const hasImg = (r.content ?? []).some((c: any) => c.type === "image");
    const err = r.isError ? " [ERROR]" : "";
    console.log(`\n— ${name} (${dt}ms)${err}${hasImg ? " [+image]" : ""} —`);
    console.log(text.length > 1200 ? text.slice(0, 1200) + `\n…(${text.length - 1200} more chars)` : text);
    return { r, dt, text };
  };

  await call("list_simulators", { bootedOnly: true });
  await call("launch_app", { bundle_id: "com.apple.Preferences", foreground_if_running: true });
  await call("await_quiescent", { stable_ms: 200, timeout_ms: 3000 });
  await call("snapshot", { filter: "interactive", maxElements: 30 });
  await call("find", { labelContains: "General", actionable: true });
  await call("tap", { id: "com.apple.settings.general" });
  await call("await_quiescent", { stable_ms: 200, timeout_ms: 3000 });
  await call("snapshot", { filter: "actionable", maxElements: 20 });
  await call("find", { labelContains: "About", actionable: true });
  await call("tap", { id: "About" });
  await call("await_quiescent", { stable_ms: 200, timeout_ms: 3000 });
  await call("snapshot", { filter: "interactive", maxElements: 25 });
  await call("scroll", { direction: "down", distance: 400 });
  await call("await_quiescent", { stable_ms: 200, timeout_ms: 2000 });
  await call("snapshot", { filter: "interactive", maxElements: 25 });
  // back out
  await call("find", { labelContains: "General", role: "Button" });
  // Settings back button uses AXLabel "General" while we're in About — try via find then tap by ref
  await call("button", { name: "HOME" });
  await call("await_quiescent", { stable_ms: 200, timeout_ms: 3000 });
  await call("screenshot", {});

  await client.close();
  console.log("\n✓ smoke test complete");
}

main().catch(e => { console.error("FAILED", e); process.exit(1); });
