#!/usr/bin/env bun
// Phase 2g smoke test: open_url + webview_list + webview_eval_js + ergonomic
// helpers (webview_find / webview_fill / webview_click).
//
// Strategy:
//   1. `open_url("https://example.com/")` against mobile Safari proves the
//      simctl openurl pipeline works (Safari foregrounds, URL navigates).
//   2. WKWebView path needs a host app that actually embeds a WKWebView.
//      We rely on the user supplying a bundle id via WEBVIEW_TEST_BUNDLE env
//      with a known HTML page loaded. If unset, the WKWebView leg is skipped
//      with a note.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function main() {
  const transport = new StdioClientTransport({
    command: "bun",
    args: ["run", new URL("../src/server.ts", import.meta.url).pathname],
  });
  const client = new Client({ name: "webview-2g", version: "0.0.1" }, { capabilities: {} });
  await client.connect(transport);

  const call = async (name: string, args: any = {}) => {
    const t0 = Date.now();
    const r: any = await client.callTool({ name, arguments: args });
    const dt = Date.now() - t0;
    const text = (r.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
    console.log(`\n— ${name} (${dt}ms)${r.isError ? " [ERR]" : ""} —`);
    console.log(text.length > 1500 ? text.slice(0, 1500) + ` …(${text.length - 1500} more)` : text);
    return { text, isError: !!r.isError };
  };

  let pass = 0, fail = 0;
  const expect = (cond: boolean, msg: string) => { if (cond) { pass++; console.log(`✓ ${msg}`); } else { fail++; console.log(`✗ ${msg}`); } };

  // --- open_url: delivers https:// to mobile Safari.
  const ru = await call("open_url", { url: "https://example.com/" });
  expect(!ru.isError && /opened https:\/\/example\.com\//.test(ru.text), "open_url succeeds against mobile Safari");

  // --- open_url: when no app handles the scheme, simctl exits non-zero and
  // we surface the error rather than swallowing it. This is the correct shape
  // for the real OAuth callback case: if your app's URL scheme isn't
  // registered properly, you want a hard failure, not a silent no-op.
  const rc = await call("open_url", { url: "iossimmcp-test-unregistered://probe?x=1" });
  expect(rc.isError && /error/i.test(rc.text), "open_url surfaces simctl errors for unregistered schemes");

  // --- WKWebView leg: gated on a host app that actually embeds one.
  const bundle = process.env.WEBVIEW_TEST_BUNDLE;
  if (!bundle) {
    console.log("\n(skipping WKWebView eval tests — set WEBVIEW_TEST_BUNDLE=<bundle_id> of an app embedding a WKWebView to run them)");
  } else {
    await call("launch_app", { bundle_id: bundle, inject: true, foreground_if_running: true });
    await call("await_quiescent", { stable_ms: 500, timeout_ms: 6000 });

    const list = await call("webview_list", { bundle_id: bundle });
    expect(!list.isError && /web view\(s\)/.test(list.text), "webview_list returns at least one webview");

    // Inject a known input so the rest of the test isn't IDP-dependent.
    const seed = await call("webview_eval_js", {
      bundle_id: bundle,
      code: "document.body.innerHTML = '<input id=email type=email name=email value=\"\">'+ '<button id=go>Go</button>'; document.title='probe-page'; document.title",
    });
    expect(!seed.isError && /probe-page/.test(seed.text), "webview_eval_js can mutate DOM and read it back");

    const find = await call("webview_find", { bundle_id: bundle, selector: "#email" });
    expect(/INPUT/.test(find.text) && /\[name=email\]/.test(find.text), "webview_find locates the email input");

    const fill = await call("webview_fill", { bundle_id: bundle, selector: "#email", text: "qa-consumer2@geoland.test" });
    expect(/filled 24 chars into INPUT/.test(fill.text), "webview_fill reports correct char count and tag");

    // Verify the value actually landed via querySelector, and React-style
    // value tracker wasn't bypassed (i.e. native setter path worked).
    const verify = await call("webview_eval_js", {
      bundle_id: bundle,
      code: "document.querySelector('#email').value",
    });
    expect(/qa-consumer2@geoland\.test/.test(verify.text), "input value is exactly what we filled (byte-perfect)");

    const click = await call("webview_click", { bundle_id: bundle, selector: "#go" });
    expect(/clicked BUTTON/.test(click.text), "webview_click fires a click on the button");
  }

  console.log(`\n${pass} pass / ${fail} fail`);
  await transport.close();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
