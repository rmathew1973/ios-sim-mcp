# ios-sim-mcp

MCP server for driving the iOS Simulator the way Chrome MCP drives a browser: semantic AX tree with stable refs, fast snapshot/tap/type cycles, no screenshot-and-click loops.

## Architecture

**Layer 1 (current, shipping):** wraps `idb` (Facebook's iOS Device Bridge — talks to CoreSimulator's private framework, no WebDriverAgent bridge). Each call is ~100ms.

**Layer 2 (in progress):** `DYLD_INSERT_LIBRARIES` dylib injected at app launch via `SIMCTL_CHILD_DYLD_INSERT_LIBRARIES` (passed to `xcrun simctl launch` — idb's launch path doesn't forward env). Opt-in per launch (`launch_app({inject: true})`).
- **2a ✅** Proof-of-life — constructor runs, emits `os_log` lifecycle line. See [dylib/ios_sim_mcp_dylib.m](dylib/ios_sim_mcp_dylib.m) + [dylib/build.sh](dylib/build.sh). Subsystem: `com.hmbsoftware.ios-sim-mcp`, category: `lifecycle`. Smoke-tested via [test/inject.ts](test/inject.ts).
- **2b ✅** Unix socket + JSON-Lines RPC. Socket at `/tmp/ios-sim-mcp-<sanitized-bundle-id>.sock`, perms 0600. Per-connection serial read loop on a concurrent dispatch queue. Methods registered via `ism_register_method` (`ping`, `info`, `paste_text`). MCP side: [src/dylib_client.ts](src/dylib_client.ts) with line-buffered protocol, pending-call map, lazy connect with 4s deadline, auto-reconnect after relaunch. Tools: `dylib_ping`, `dylib_info`, `dylib_call`, `paste_text`. `type_text` auto-routes through `paste_text` when dylib is loaded. Measured: ~1ms per call once connected, 822ms cold first call (mostly socket-existence wait after launch). Smoke-tested via [test/dylib_2b.ts](test/dylib_2b.ts) + [test/paste_perfect.ts](test/paste_perfect.ts).
  - **paste_text** uses `UIPasteboard.generalPasteboard.string = text` + first-responder `[responder paste:nil]`, bouncing to the main queue. First-responder lookup walks `UIWindowScene.windows` (iOS 13+) preferring `isKeyWindow`, then falls back to `UIApplication.windows`. Solves three real input bugs: (1) iOS first-letter autocapitalization mangling lowercase emails (`qa-consumer2@geoland.test` → `Qa-consumer2@geoland.test` → login fails), (2) Unicode silently dropped through HID translation (`café` → nothing), (3) smart-quote substitution chewing `a"b'c` into `A`. Verified byte-perfect for emails, passwords, Unicode, and quote-containing strings.
- **2c ✅** `view_tree` + `view_hit_test`. Walks `UIWindowScene.windows` (with `UIApplication.windows` fallback) → recursive `subviews`, on the main thread (`dispatch_sync(main)`). Per node: class, window-coord frame, alpha/hidden/interactive, accessibility id+label+value, text content for `UILabel`/`UIButton`/`UITextField`/`UITextView`, and `vc_class` when this view is a `UIViewController`'s `viewIfLoaded`. Caps: default `max_nodes=1500`, `max_depth=30`; `hit_cap: true` in response when truncated. Skips invisible (hidden / α<0.01 / zero-size) unless `include_invisible: true`. Renderer: [src/view_tree.ts](src/view_tree.ts) with `class_filter` / `ax_id_contains` / `text_contains` filters (subtree ancestor preservation). Tools: `view_tree`, `view_hit_test`. Smoke-tested via [test/view_tree.ts](test/view_tree.ts). Sub-5ms response for a 105-node SwiftUI Settings tree.
  - **Critical SwiftUI caveat:** `accessibilityIdentifier` set in SwiftUI (`.accessibilityIdentifier("foo")`) lives on the SwiftUI AX tree, NOT on the bridged `UIView.accessibilityIdentifier`. So `view_tree`'s `ax_id_contains` filter won't find SwiftUI-set ids. Use the AX `snapshot` tool for SwiftUI ax-id lookups; use `view_tree` for SwiftUI when you need view class hierarchy, frames, or hit-testing. Native UIKit apps with explicit `accessibilityIdentifier` on `UIView` are found correctly by both.
  - `view_hit_test` returns the topmost hit via `[keyWindow hitTest:p withEvent:nil]` plus the full `nextResponder` chain (typically reaches `UIApplication` / `AppDelegate`). View controllers in the chain are tagged `is_vc: true` (rendered as `[VC]`).
- **2d** `URLProtocol`-based network interception with bodies (the big unlock).
- **2e** `JSContext` eval bridge.

**Layer 2 safety invariants (don't regress):**
- Constructor blocks dyld — must return ASAP. Accept loop runs on a separate dispatch queue.
- `SIGPIPE` is ignored globally + `SO_NOSIGPIPE` per-fd. Writing to a closed socket would otherwise kill the host app.
- All dispatch_async handlers wrap work in `@try` and `@autoreleasepool`.
- Method handlers run on a background queue. Any future UIKit access must `dispatch_sync(dispatch_get_main_queue(), …)`.
- Stale sockets from previous launches are `unlink()`'d before bind.
- Dylib does nothing if `[NSBundle mainBundle].bundleIdentifier` is empty (likely a helper/extension process — don't try to bind a socket for it).

Dylib is iOS-Simulator-flavored (`LC_BUILD_VERSION` platform 7, iOS 14+). Build: `./dylib/build.sh`. Output: `dylib/build/libios-sim-mcp.dylib` (arm64 only by default; x86_64 slice commented out). Default path resolved in server.ts as `path.resolve(__dirname, "../dylib/build/libios-sim-mcp.dylib")`.

**Layer 3 (current, shipping):** `xcrun simctl spawn <udid> log stream` piped into an in-memory ring buffer.

## Key files

- [src/server.ts](src/server.ts) — MCP stdio server, tool registrations, `ensureUdid()` auto-selection, target resolution by ref/id/point.
- [src/snapshot.ts](src/snapshot.ts) — calls `idb ui describe-all --nested`, walks tree, assigns `e1..eN` refs, builds `byRef`/`byAXId` maps, computes 12-char tree hash for quiescence detection. `captureSnapshot` retries up to 4× with 120ms delay when the result is a degenerate `AXApplication` with no children (real race right after `launch`).
- [src/actions.ts](src/actions.ts) — tap/type/swipe/key/button/launch/terminate/screenshot/await_quiescent. Every action invalidates the snapshot cache.
- [src/idb.ts](src/idb.ts) — `runIdb` subprocess wrapper with timeout, `listTargets` / `bootedSimulators`.
- [src/logs.ts](src/logs.ts) — `xcrun simctl spawn ... log stream --style compact` subprocess + 5000-line ring buffer.
- [src/state.ts](src/state.ts) — module-level state: selected `udid`, `lastSnapshot`, `logProc`, `logBuffer`.

## Quirks (don't relearn the hard way)

- **`--json` flag on `idb ui describe-all` is a no-op** — default output is already JSON. Don't pass `--json`; one test showed it returning only the root element.
- **Degenerate AX tree race**: for ~1s after `launch`, `describe-all --nested` returns just `[{role: "AXApplication", children: []}]`. Hash is stable so naive `await_quiescent` returns instantly with an empty tree. Fixed two ways: (1) `captureSnapshot` retries until non-degenerate, (2) `await_quiescent` resets stability timer if it sees a degenerate tree.
- **Scroll direction is reader-perspective** (`down` = see more below = finger drags up), not finger-perspective. Default 0.4s duration prevents iOS from interpreting the gesture's release point as a tap.
- **Snapshot is invalidated on every tap/swipe/type/launch/key/button.** `find` and `resolveTarget` will fall back to "no snapshot, call snapshot first" rather than acting on a stale tree.

## Tools

`list_simulators`, `use_simulator`, `snapshot`, `find`, `tap`, `type_text`, `key`, `button`, `swipe`, `scroll`, `launch_app`, `terminate_app`, `screenshot`, `await_quiescent`, `log_start`, `log_tail`, `log_stop`, `log_clear`.

`tap`, `swipe`, `scroll`, `type_text` accept `{ref}` (from latest snapshot) or `{id}` (AXUniqueId) or `{x,y}`. `type_text` with `ref`/`id` taps-then-types for ergonomics.

## Running

```
bun run src/server.ts          # stdio server
bun run test/smoke.ts          # full smoke test against booted sim
bun run test/text2.ts          # type_text + scroll regression test
```

Registered with Claude Code via:
```
claude mcp add -s user ios-sim -- bun run /Users/russellmathews/Projects/ios-sim-mcp/src/server.ts
```

## Where to go next

- **Layer 2 dylib** is the unlock — see top of file. Start with a `URLProtocol` interceptor that writes JSON-Lines to a Unix socket; that alone covers most "what did the app request?" debugging.
- **Per-app default IDs**: when an app has many similar buttons without `accessibilityIdentifier`, the snapshot becomes "Button '' @(...)" rows. Encourage devs (or auto-suggest) ID them. The user's global CLAUDE.md mandates this already.
- **`describe-point` shortcut**: useful for "what's under the cursor" debugging. Not exposed yet — `idb ui describe-point x y` works directly.
- **Screen recording**: `idb record-video` exists. Could be a `record_start`/`record_stop` pair.
