#!/usr/bin/env bun
// Verify paste_text gives byte-perfect input (no iOS autocorrect / capitalization).
// Targets the Settings app injected with the dylib. Uses the Search field as the
// observation point: iOS shows "No Results for "X"" with X = exactly what arrived.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const CASES = [
  // Lowercase first char — must NOT be auto-capitalized by paste path.
  "qa-consumer2@geoland.test",
  "lowercase",
  // Symbols that the HID translation can mishandle.
  "p@$$w0rd!#%",
  // Unicode that no keyboard can produce reliably.
  "café — résumé",
  // Mixed quote / smart-punct risk.
  'a"b\'c',
];

async function main() {
  const transport = new StdioClientTransport({
    command: "bun",
    args: ["run", new URL("../src/server.ts", import.meta.url).pathname],
  });
  const client = new Client({ name: "paste-perfect", version: "0.0.1" }, { capabilities: {} });
  await client.connect(transport);

  const call = async (name: string, args: any = {}) =>
    client.callTool({ name, arguments: args }).then((r: any) => ({
      text: (r.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n"),
      isError: !!r.isError,
    }));

  const compare = (label: string, input: string, got: string) => {
    const ok = got === input;
    console.log(`  ${label.padEnd(11)} input=${JSON.stringify(input).padEnd(35)} got=${JSON.stringify(got).padEnd(35)} ${ok ? "✓" : "✗"}`);
    return ok;
  };

  let pass = 0, fail = 0;
  for (const input of CASES) {
    console.log(`\n[${JSON.stringify(input)}]`);

    // Fresh injected Settings each time.
    await call("terminate_app", { bundle_id: "com.apple.Preferences" }).catch(() => {});
    await new Promise(r => setTimeout(r, 250));
    await call("launch_app", { bundle_id: "com.apple.Preferences", inject: true, foreground_if_running: true });
    await call("await_quiescent", { stable_ms: 300, timeout_ms: 4000 });
    await call("snapshot", { filter: "all", maxElements: 60 });
    const sf = await call("find", { role: "TextField", labelContains: "Search" });
    const ref = sf.text.match(/^(e\d+)/m)?.[1];
    if (!ref) { console.log("  ✗ search field not found"); fail++; continue; }

    // PASTE path — should be byte-perfect.
    await call("type_text", { ref, text: input, via: "paste" });
    await call("await_quiescent", { stable_ms: 350, timeout_ms: 2500 });
    await call("snapshot", { filter: "all", maxElements: 60 });
    const pasteDump = await call("find", { labelContains: "No Results", limit: 2 });
    const pasted = pasteDump.text.match(/No Results for “(.*?)”/)?.[1] ?? "(no label)";
    if (compare("paste", input, pasted)) pass++; else fail++;

    // KEYSTROKE path — for comparison; expected to mangle (esp. first-letter cap).
    await call("terminate_app", { bundle_id: "com.apple.Preferences" }).catch(() => {});
    await new Promise(r => setTimeout(r, 200));
    await call("launch_app", { bundle_id: "com.apple.Preferences", inject: true, foreground_if_running: true });
    await call("await_quiescent", { stable_ms: 300, timeout_ms: 4000 });
    await call("snapshot", { filter: "all", maxElements: 60 });
    const sf2 = await call("find", { role: "TextField", labelContains: "Search" });
    const ref2 = sf2.text.match(/^(e\d+)/m)?.[1];
    if (!ref2) continue;
    await call("type_text", { ref: ref2, text: input, via: "keystroke" });
    await call("await_quiescent", { stable_ms: 350, timeout_ms: 2500 });
    await call("snapshot", { filter: "all", maxElements: 60 });
    const ksDump = await call("find", { labelContains: "No Results", limit: 2 });
    const typed = ksDump.text.match(/No Results for “(.*?)”/)?.[1] ?? "(no label)";
    compare("keystroke", input, typed); // informational only; don't bump pass/fail
  }

  await client.close();
  console.log(`\nPaste path: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main().catch(e => { console.error("FAILED", e); process.exit(1); });
