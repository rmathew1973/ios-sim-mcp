#!/usr/bin/env bun
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function main() {
  const transport = new StdioClientTransport({
    command: "bun",
    args: ["run", new URL("../src/server.ts", import.meta.url).pathname],
  });
  const client = new Client({ name: "t2", version: "0.0.1" }, { capabilities: {} });
  await client.connect(transport);

  const call = async (name: string, args: any = {}) => {
    const t0 = Date.now();
    const r: any = await client.callTool({ name, arguments: args });
    const dt = Date.now() - t0;
    const text = (r.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
    console.log(`\n— ${name} (${dt}ms)${r.isError ? " [ERR]" : ""} —`);
    console.log(text.length > 1500 ? text.slice(0, 1500) + ` …(${text.length - 1500} more)` : text);
    return text;
  };

  await call("launch_app", { bundle_id: "com.apple.Preferences", foreground_if_running: true });
  await call("await_quiescent", { stable_ms: 250, timeout_ms: 4000 });
  await call("snapshot", { filter: "interactive", maxElements: 20 });
  // Type into search field directly (tap-then-type by ref)
  await call("type_text", { ref: "e14", text: "wifi" });
  await call("await_quiescent", { stable_ms: 300, timeout_ms: 2500 });
  await call("snapshot", { filter: "interactive", maxElements: 20 });

  // Scroll regression test: scroll down on Settings root, then check we did NOT navigate
  await call("scroll", { direction: "down", distance: 400 });
  await call("await_quiescent", { stable_ms: 250, timeout_ms: 2000 });
  await call("snapshot", { filter: "interactive", maxElements: 25 });

  await call("button", { name: "HOME" });
  await client.close();
}

main().catch(e => { console.error("FAILED", e); process.exit(1); });
