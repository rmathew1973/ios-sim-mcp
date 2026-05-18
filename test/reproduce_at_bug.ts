#!/usr/bin/env bun
// Reproduce the reported bug: `type_text` drops `@` when typing emails.
// Signal: Settings → Search navigates to a "No Results for "X"" screen where X
// is exactly what iOS received. Fingerprint which characters fail.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const CASES = [
  "abcXYZ",
  "abc123",
  "abc@xyz",
  "@",
  "a-b_c",
  "a!b#c$",
  "qa-consumer2@geoland.test",
];

async function main() {
  const transport = new StdioClientTransport({
    command: "bun",
    args: ["run", new URL("../src/server.ts", import.meta.url).pathname],
  });
  const client = new Client({ name: "at-bug", version: "0.0.1" }, { capabilities: {} });
  await client.connect(transport);

  const call = async (name: string, args: any = {}) =>
    client.callTool({ name, arguments: args }).then((r: any) => ({
      text: (r.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n"),
      isError: !!r.isError,
    }));

  console.log(`Testing ${CASES.length} inputs via Settings → Search "No Results for X" signal\n`);

  for (const input of CASES) {
    // Fresh Settings each time guarantees a clean search field at a known location.
    await call("terminate_app", { bundle_id: "com.apple.Preferences" }).catch(() => {});
    await new Promise(r => setTimeout(r, 250));
    await call("launch_app", { bundle_id: "com.apple.Preferences" });
    await call("await_quiescent", { stable_ms: 300, timeout_ms: 4000 });
    await call("snapshot", { filter: "all", maxElements: 60 });
    const sf = await call("find", { role: "TextField", labelContains: "Search" });
    const ref = sf.text.match(/^(e\d+)/m)?.[1];
    if (!ref) { console.log(`✗ no search field for input ${JSON.stringify(input)}`); continue; }

    await call("type_text", { ref, text: input });
    await call("await_quiescent", { stable_ms: 350, timeout_ms: 2500 });
    await call("snapshot", { filter: "all", maxElements: 60 });
    const dump = await call("find", { labelContains: "No Results", limit: 3 });
    // iOS uses U+201C/U+201D curly quotes around the searched term.
    // Label format: StaticText "No Results for “qa-consumer2@geoland.test”"
    const m = dump.text.match(/No Results for “(.*?)”/);
    const got = m?.[1] ?? "(no 'No Results' label — iOS may have matched something)";
    // iOS often smart-capitalizes the first char; normalize for compare.
    const norm = (s: string) => s.toLowerCase();
    const ok = norm(got) === norm(input);
    console.log(`  input=${JSON.stringify(input).padEnd(35)} got=${JSON.stringify(got).padEnd(40)} ${ok ? "✓" : "✗ DROPPED/CHANGED"}`);
  }
  await client.close();
}

main().catch(e => { console.error("FAILED", e); process.exit(1); });
