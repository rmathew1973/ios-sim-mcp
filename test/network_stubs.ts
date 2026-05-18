#!/usr/bin/env bun
// Phase 2f smoke test: register stubs, verify they synthesize responses
// instead of forwarding, verify they show up in network_tail with
// stubbed:true, verify removal restores real-server behavior, verify
// delay_ms is honored.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function main() {
  const transport = new StdioClientTransport({
    command: "bun",
    args: ["run", new URL("../src/server.ts", import.meta.url).pathname],
  });
  const client = new Client({ name: "stubs-2f", version: "0.0.1" }, { capabilities: {} });
  await client.connect(transport);

  const call = async (name: string, args: any = {}) => {
    const t0 = Date.now();
    const r: any = await client.callTool({ name, arguments: args });
    const dt = Date.now() - t0;
    const text = (r.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
    console.log(`\n— ${name} (${dt}ms)${r.isError ? " [ERR]" : ""} —`);
    console.log(text.length > 1500 ? text.slice(0, 1500) + ` …(${text.length - 1500} more)` : text);
    return { text, isError: !!r.isError, dt };
  };

  let pass = 0, fail = 0;
  const expect = (cond: boolean, msg: string) => { if (cond) { pass++; console.log(`✓ ${msg}`); } else { fail++; console.log(`✗ ${msg}`); } };

  await call("terminate_app", { bundle_id: "com.apple.Preferences" }).catch(() => {});
  await new Promise(r => setTimeout(r, 250));
  await call("launch_app", { bundle_id: "com.apple.Preferences", inject: true, foreground_if_running: true });
  await call("await_quiescent", { stable_ms: 300, timeout_ms: 4000 });
  await call("network_start");

  // 1. Empty list initially
  const list0 = await call("network_stubs");
  expect(/no stubs/.test(list0.text), "starts with no stubs");

  // 2. Register a stub for /get that returns 503 with a custom body
  const stubAdd = await call("network_stub", {
    url_substring: "/get",
    status: 503,
    headers: { "X-Stub-Source": "ios-sim-mcp" },
    body: '{"stubbed":true,"reason":"backend down for test"}',
  });
  expect(!stubAdd.isError, "network_stub registered");
  const stubIdMatch = stubAdd.text.match(/"id":\s*(\d+)/);
  expect(!!stubIdMatch, "stub returned an id");
  const stubId = stubIdMatch ? parseInt(stubIdMatch[1], 10) : 0;

  // 3. List shows it
  const list1 = await call("network_stubs");
  expect(/url~"\/get"/.test(list1.text) && /503/.test(list1.text), "stub appears in list");

  // 4. Fire the request — stub should synthesize 503
  const fire1 = await call("network_self_test", { url: "https://httpbin.org/get" });
  expect(/"status":\s*503/.test(fire1.text), "stubbed request returns 503");

  // 5. Tail shows stubbed:true and stub_id
  const tail1 = await call("network_tail", { n: 5, full: true });
  expect(/"stubbed":\s*true/.test(tail1.text) || /stubbed/.test(tail1.text), "tail marks the record as stubbed");
  expect(/stubbed.*"reason":"backend down/.test(tail1.text) || /backend down for test/.test(tail1.text), "tail shows synthesized body");

  // 6. Remove the stub
  const removed = await call("network_unstub", { id: stubId });
  expect(/"removed":\s*true/.test(removed.text), "unstub returns removed:true");

  // 7. Fire again — should hit the real server and return 200
  const fire2 = await call("network_self_test", { url: "https://httpbin.org/get" });
  expect(/"status":\s*200/.test(fire2.text), "after unstub, request hits real server (200)");

  // 8. Method filter — stub only POST to /anything, then GET should pass through
  await call("network_stub", {
    url_substring: "/anything",
    method: "POST",
    status: 418,
    body: "I'm a stubbed teapot",
  });
  // GET to /anything should NOT be stubbed (will return real 200 from httpbin)
  const getReal = await call("network_self_test", { url: "https://httpbin.org/anything" });
  expect(/"status":\s*200/.test(getReal.text), "method filter: GET to stubbed-POST URL passes through");

  // 9. Delay_ms: stub /delay-test with delay 800ms; measure elapsed time
  await call("network_stub", {
    url_substring: "/get",
    status: 200,
    body: '{"slow":true}',
    delay_ms: 800,
  });
  const slow = await call("network_self_test", { url: "https://httpbin.org/get" });
  expect(slow.dt >= 700, `delay_ms honored (took ${slow.dt}ms, expected >=700)`);

  // 10. Clear all stubs
  const cleared = await call("network_unstub_all");
  expect(/cleared \d+/.test(cleared.text), "unstub_all reports a count");
  const list2 = await call("network_stubs");
  expect(/no stubs/.test(list2.text), "list is empty after unstub_all");

  await client.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main().catch(e => { console.error("FAILED", e); process.exit(1); });
