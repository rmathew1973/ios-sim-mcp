#!/usr/bin/env bun
// Phase 2c smoke test: launch Settings injected, dump view_tree, exercise
// filters, and hit-test a known control's coords from the AX snapshot to
// confirm the responder chain reaches the expected view.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function main() {
  const transport = new StdioClientTransport({
    command: "bun",
    args: ["run", new URL("../src/server.ts", import.meta.url).pathname],
  });
  const client = new Client({ name: "vt-2c", version: "0.0.1" }, { capabilities: {} });
  await client.connect(transport);

  const call = async (name: string, args: any = {}) => {
    const t0 = Date.now();
    const r: any = await client.callTool({ name, arguments: args });
    const dt = Date.now() - t0;
    const text = (r.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
    console.log(`\n— ${name} (${dt}ms)${r.isError ? " [ERR]" : ""} —`);
    console.log(text.length > 3500 ? text.slice(0, 3500) + ` …(${text.length - 3500} more chars)` : text);
    return { text, isError: !!r.isError };
  };

  let pass = 0, fail = 0;
  const expect = (c: boolean, m: string) => { if (c) { pass++; console.log(`✓ ${m}`); } else { fail++; console.log(`✗ ${m}`); } };

  await call("terminate_app", { bundle_id: "com.apple.Preferences" }).catch(() => {});
  await new Promise(r => setTimeout(r, 250));
  await call("launch_app", { bundle_id: "com.apple.Preferences", inject: true, foreground_if_running: true });
  await call("await_quiescent", { stable_ms: 350, timeout_ms: 4000 });

  // 1. Full view_tree dump (filtered output naturally; tree is huge)
  const full = await call("view_tree", { max_nodes: 1500, max_lines: 80, show_frames: true });
  expect(!full.isError, "view_tree returns without error");
  expect(/UIWindow/.test(full.text), "tree contains UIWindow");
  expect(/keyWindow/.test(full.text), "tree marks the key window");
  expect(/rootVC=/.test(full.text), "tree annotates root VC");

  // 2. Filter by class — find every UILabel/UIButton on screen
  const buttons = await call("view_tree", { class_filter: "Button", max_lines: 60 });
  expect(!buttons.isError, "class_filter ok");
  expect(/Button/.test(buttons.text), "filtered view shows Button-class views");

  // 3. Filter by ax_id — Settings is a SwiftUI app (UIHostingController etc.)
  //    and SwiftUI does NOT propagate accessibilityIdentifier to the bridged
  //    UIView. So ax_id_contains will return empty here; that's expected, not
  //    a bug in view_tree. Native-UIKit apps with explicit .accessibilityIdentifier
  //    do match. Use the AX `snapshot` tool for SwiftUI ax-id lookups.
  const generalRow = await call("view_tree", { ax_id_contains: "settings.general", max_lines: 40 });
  expect(!generalRow.isError, "ax_id_contains executes cleanly even on SwiftUI apps");

  // 4. Filter by text — find the "General" label
  const generalText = await call("view_tree", { text_contains: "General", max_lines: 40 });
  expect(/General/.test(generalText.text), "text_contains finds visible 'General'");

  // 5. hit_test at the General row's center (from AX snapshot earlier we know
  //    it's around y=406 with x=201). Confirm the topmost view's responder
  //    chain includes a UIViewController.
  const hit = await call("view_hit_test", { x: 201, y: 406 });
  expect(!hit.isError, "hit_test runs");
  expect(/hit at \(201,406\)/.test(hit.text), "hit_test reports coords");
  expect(/responder chain:/.test(hit.text), "hit_test includes responder chain");
  expect(/\[VC\]/.test(hit.text), "responder chain contains a view controller");

  await client.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main().catch(e => { console.error("FAILED", e); process.exit(1); });
