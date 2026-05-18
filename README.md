# ios-sim-mcp

An MCP server that drives the iOS Simulator the way Chrome's DevTools MCP drives a browser: **semantic accessibility-tree snapshots with stable element refs**, sub-200ms operations, and no screenshot-and-eyeball-coordinates loops.

Built because every existing iOS-simulator automation tool either crawls (Appium, screenshot-based agents) or requires pre-written scripts. This one lets an LLM drive a simulator interactively — find an element by label or ID, tap it by ref, wait for the UI to settle, repeat — at roughly the speed a human would.

## Why this exists

Most existing iOS-sim MCPs work by taking a screenshot, asking the model to identify coordinates, then tapping pixels. That's slow (image bytes in context), expensive (vision tokens), and fragile (any layout shift breaks it).

iOS apps already expose a structured accessibility tree — the same one VoiceOver uses. If you query that tree, you get every interactive element with its label, role, AX identifier, frame, and enabled state. You can find what you want semantically, refer to it by a stable ref, and act on it directly. That's what Chrome MCP does for the DOM, and it's what this does for `UIView` hierarchies in the iOS Simulator.

## How it works

Three layers, two shipping today:

| Layer | Status | Tech | What it gives you |
|-------|--------|------|-------------------|
| 1 — AX tree + actions | ✅ shipping | `idb` (Facebook's CoreSimulator bridge) | snapshot, find, tap, type, swipe, scroll, launch, screenshot — all ~100ms |
| 2a — Dylib proof-of-life | ✅ shipping | `DYLD_INSERT_LIBRARIES` via `SIMCTL_CHILD_*` | constructor runs in the target app before `main()`; logs lifecycle via `os_log` |
| 2b — In-process RPC | ✅ shipping | Unix socket + JSON-Lines | round-trip into a running app at **~1ms per call** |
| 2c — View introspection | ✅ shipping | Main-thread UIView walk | `view_tree`, `view_hit_test` — class hierarchy, frames, responder chains, VC annotations |
| 2d — Network interception | ✅ shipping | `URLProtocol` + `URLSessionConfiguration` swizzle | capture every HTTP request/response (headers, bodies, timing) inside the app — no cert install, no mitmproxy |
| 2e — JS eval | ✅ shipping | `JSContext` + `JSExport` bridges | `eval_js({code})` with `app` / `key_window()` / `defaults` / `pasteboard` / `bundle` / `process` / view-finder helpers — Chrome's `Runtime.evaluate` equivalent |
| 2f — Network stubbing | ✅ shipping | Same URLProtocol, synthesized response | register canned responses by URL substring + optional method; supports custom status/headers/body + `delay_ms` for slow-network simulation |
| 3 — System logs | ✅ shipping | `xcrun simctl spawn log stream` | streaming os_log into a 5000-line ring buffer |

`idb` talks directly to CoreSimulator's private framework — no WebDriverAgent, no HTTP hop into the simulator process — which is why the per-call latency is closer to a local subprocess than to a network round trip.

## Requirements

- macOS with Xcode + iOS Simulator
- [`idb`](https://github.com/facebook/idb) (`brew tap facebook/fb && brew install idb-companion && pipx install fb-idb`)
- [Bun](https://bun.sh) (`curl -fsSL https://bun.sh/install | bash`)
- A booted simulator (`xcrun simctl boot <udid>` or open it in Xcode)

## Install

### Quickest path (npm + npx)

```bash
# Register with Claude Code, one line:
claude mcp add -s user ios-sim -- npx -y ios-sim-mcp
```

`npx` will fetch the package on first run. Verify:

```bash
claude mcp list | grep ios-sim     # ios-sim: ... ✓ Connected
```

Layer 2 dylib ships prebuilt as a universal binary (arm64 + x86_64) — works on both Apple Silicon and Intel Macs out of the box.

### From source

```bash
git clone https://github.com/rmathew1973/ios-sim-mcp.git
cd ios-sim-mcp
bun install
./dylib/build.sh         # builds the Layer 2 dylib (only needed if you'll use inject:true)
```

Then register:

```bash
claude mcp add -s user ios-sim -- bun run "$(pwd)/src/server.ts"
```

### Register with Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "ios-sim": {
      "command": "npx",
      "args": ["-y", "ios-sim-mcp"]
    }
  }
}
```

Or, if installed from source, point at the local path:

```json
{
  "mcpServers": {
    "ios-sim": {
      "command": "/Users/YOU/.bun/bin/bun",
      "args": ["run", "/absolute/path/to/ios-sim-mcp/src/server.ts"]
    }
  }
}
```

Quit and reopen Claude Desktop.

### Register with anything else (generic MCP client)

It's a standard stdio MCP server. Run `bun run src/server.ts` and pipe JSON-RPC. See [`test/smoke.ts`](test/smoke.ts) for a working client example.

## Tools

| Tool | What it does |
|------|--------------|
| `list_simulators` | List simulators with UDID, state, OS version |
| `use_simulator` | Pick a specific UDID (auto-selected if only one is booted) |
| `snapshot` | Capture the AX tree, assign refs `e1..eN`, return compact text rendering. Filters: `interactive` (default), `actionable`, `all` |
| `find` | Search the snapshot by `id` (AXUniqueId), `label`, `labelContains`, `role`, `actionable` |
| `tap` | Tap by `{ref}`, `{id}`, or `{x,y}`. Optional `duration` makes it a long-press |
| `type_text` | Type into the focused field. Optional `{ref}` or `{id}` taps-then-types. Auto-routes through paste when the dylib is loaded for byte-perfect input — no iOS autocorrect, no first-letter capitalization. `via: "keystroke"` forces the typing path; `via: "paste"` forces the paste path |
| `paste_text` | Byte-perfect text via `UIPasteboard` + first-responder `paste:`. Requires the dylib injected. The right answer for emails, passwords, OAuth tokens, anything case-sensitive |
| `view_tree` | Walk the running app's `UIView` hierarchy on the main thread. Reports class names, frames in window coords, alpha/hidden/interactive, text content, and annotates view-controller boundaries. Strictly richer than `snapshot` — sees custom-drawn views, transient overlays, SwiftUI internals. Filter by `class_filter` / `ax_id_contains` / `text_contains`. Requires dylib injected |
| `view_hit_test` | "What view actually receives a tap at (x,y)?" Returns the topmost view plus the full responder chain up to `UIApplication`. The right debugging tool when a `tap` isn't doing what you expect. Requires dylib injected |
| `network_start` / `network_stop` / `network_status` | Install/remove an `URLProtocol` interceptor + swizzle `URLSessionConfiguration` so every `URLSession`-based HTTP request flowing through the app is recorded. Options: `max_records`, `max_body_bytes`, `filter_url_substring`. Requires dylib injected |
| `network_tail` | Return the most recent N captured records. Default: one line per request (id, method, status, timing, sizes, URL). `full=true` includes headers + body previews inline. Page forward via `since_id` |
| `network_get_body` | Fetch the full request or response body (up to `max_body_bytes`, default 256KB) for a specific record id. Returns base64 + UTF-8 decode for text bodies |
| `network_clear` | Drop the ring buffer and all retained bodies |
| `network_self_test` | Fire an HTTP request from inside the app to verify the capture path end-to-end |
| `network_stub` / `network_stubs` / `network_unstub` / `network_unstub_all` | Register canned HTTP responses by URL substring (+ optional method). Synthesizes status/headers/body without forwarding; `delay_ms` simulates slow networks. Stubbed requests still appear in `network_tail` with `stubbed:true` |
| `eval_js` | Run arbitrary JavaScript in a persistent `JSContext` inside the injected app. Bridged globals: `app`, `key_window()`, `all_windows()`, `defaults`, `pasteboard`, `bundle`, `process`, `notif_center`, `first_responder()`, `find_view_by_ax_id`, `find_view_by_class`, `find_vc_by_class`, `post_notification`, `cls`, `log`. State persists across calls. Requires dylib injected |
| `eval_js_reset` | Drop the JSContext and rebuild bridges on next eval — forgets your defined vars/fns |
| `key` | Press a key by name (RETURN, ESC, DELETE, TAB, SPACE, F1–F12, arrows) or raw HID code |
| `button` | Hardware button: HOME, LOCK, SIDE_BUTTON, SIRI, APPLE_PAY |
| `swipe` | Swipe between two refs/ids/points. Optional `duration` and `delta` |
| `scroll` | Reader-perspective scroll: `down` reveals content below. Optional anchor element |
| `launch_app` | Launch by bundle id. Optional `foreground_if_running` terminates first |
| `terminate_app` | Terminate by bundle id |
| `screenshot` | PNG to disk or inline. Use sparingly — the AX tree is faster and richer |
| `await_quiescent` | Block until the AX-tree hash is identical for `stable_ms` (default 250) or `timeout_ms` (default 5000). Use after launches and navigation instead of sleep |
| `log_start` / `log_tail` / `log_stop` / `log_clear` | Stream `os_log` into a 5000-line ring buffer. Filter by `bundle_id` substring, `level`, or NSPredicate |

## Example session

```
> snapshot
# Settings  screen=402x874  v=5  elements=15
  e3 Button "Apple Account" #com.apple.settings.primaryAppleAccount @(201,213)
  e5 Button "General" #com.apple.settings.general @(201,406)
  e6 Button "Accessibility" #com.apple.settings.accessibility @(201,458)
  e14 TextField "Search" ="Search" @(201,822)
  ...

> tap {id: "com.apple.settings.general"}
tapped e5/com.apple.settings.general

> await_quiescent {stable_ms: 250}
stable hash=8326196f25c8 samples=4 elapsed=1731ms

> snapshot
# Settings  v=10  elements=13
  e2 Button "Settings" #BackButton @(38,84)
  e6 Button "About" #About @(201,418)
  ...

> type_text {ref: "e14", text: "wifi"}
typed 4 chars into e14
```

Measured on iPhone 17 Pro / iOS 26.5 / M-series Mac:

- `snapshot`: 127–190 ms
- `tap`: 100 ms
- `find`: <1 ms (in-memory against cached snapshot)
- `await_quiescent`: 400 ms – 2.5 s (real UI settle time)

## Design notes

- **Snapshots are versioned and cached.** Any action (`tap`, `swipe`, `type_text`, `launch_app`, `button`, `key`) invalidates the cache so stale refs can't survive a state change. `find` and ref resolution will tell you to re-snapshot rather than acting on old data.
- **Refs are stable within a snapshot, not across snapshots.** `e5` in `v=10` is not the same element as `e5` in `v=11`. AXUniqueIds (the iOS `accessibilityIdentifier`) are stable across snapshots and are the preferred way to target a control across UI changes.
- **`await_quiescent` ignores degenerate AX trees.** For ~1s after `launch_app`, `idb` returns just the `AXApplication` root with no children. A naive hash-stability check would return instantly with an empty tree. The implementation resets the stability timer whenever it sees a degenerate snapshot.
- **`scroll` is reader-perspective.** `down` means "see what's below" (finger drags up), matching mouse-wheel/page-down conventions, not finger-direction. Default 0.4s gesture duration prevents iOS from interpreting the release point as a tap on the underlying element.

## Tip: add accessibility identifiers to your own apps

This MCP is fastest and most reliable when interactive controls have `accessibilityIdentifier` set:

```swift
Button("Sign In") { ... }
  .accessibilityIdentifier("login_submit_button")
```

Then `tap({id: "login_submit_button"})` is O(1) and survives label changes, localization, and layout shifts.

## Layer 2 dylib (optional, opt-in per launch)

`launch_app({bundle_id, inject: true})` loads a small dylib into the target app via `SIMCTL_CHILD_DYLD_INSERT_LIBRARIES`. The dylib opens a Unix socket at `/tmp/ios-sim-mcp-<bundle-id>.sock` and serves JSON-Lines RPC. You can then talk into the running app:

```ts
dylib_ping({ echo: "hi" })          // pong from com.apple.Preferences (RTT 1ms)
dylib_info({})                       // {pid, bundle_id, process_name, bundle_path, methods, ...}
dylib_call({ method: "...", params }) // generic; future phases register more methods
```

Once connected, IPC is **sub-millisecond per call** — orders of magnitude cheaper than Layer 1's subprocess-spawn overhead. Connection is lazy (first `dylib_*` call) and pooled per bundle id; relaunch invalidates the old client automatically.

### Why you want to launch with `inject: true` even for casual driving

iOS auto-capitalizes the first letter of typed input, swaps `"` `'` for smart-quotes, and runs autocorrect on anything that looks like a word. For driving UI those transformations silently mangle:

- `qa-consumer2@geoland.test` becomes `Qa-consumer2@geoland.test` → **server rejects the email** → login fails with no obvious cause
- `café` becomes nothing iOS can even render → field receives garbage
- `a"b'c` becomes `A` after smart-quote substitution and autocorrect

With the dylib loaded, `type_text` auto-routes through `UIPasteboard.general.string = text` + the first responder's `paste:`. Bypasses the keyboard entirely. Whatever you pass arrives byte-perfect.

Build it once:

```bash
./dylib/build.sh         # outputs dylib/build/libios-sim-mcp.dylib
```

The dylib is iOS-Simulator-flavored (`LC_BUILD_VERSION` platform 7, iOS 14+), only loads in apps you launch through this tool with `inject: true`, does not modify the app on disk, and leaves no trace after the process exits.

## When to use `snapshot` vs `view_tree`

Both inspect the running UI but they read different trees:

| | `snapshot` (Layer 1, AX) | `view_tree` (Layer 2c, UIView) |
|---|---|---|
| Source | iOS accessibility tree | Live `UIView` hierarchy |
| Needs dylib | No | Yes (`inject: true`) |
| Latency | ~150 ms (subprocess) | ~5 ms (in-process) |
| Sees `accessibilityIdentifier` on SwiftUI | **Yes** | No (SwiftUI doesn't propagate) |
| Sees `accessibilityIdentifier` on UIKit | Yes (if set) | Yes (if set) |
| Sees custom-drawn views | No (no AX node) | **Yes** |
| Sees SwiftUI internals (`UIHostingController`, etc.) | Flattened | **Full hierarchy** |
| Sees view-controller boundaries | No | **Yes** |
| Sees alpha / isHidden / interactionEnabled | Partial | **Yes** |

**Rule of thumb:** use `snapshot` + `find` for "tap this control" workflows (especially in SwiftUI apps); use `view_tree` for "what's actually on screen and why isn't this working" investigation.

## Network capture (Layer 2d)

```ts
launch_app({ bundle_id: "com.yourco.app", inject: true })
network_start({ max_body_bytes: 262144 })
// ... use the app normally ...
network_tail({ n: 20, full: true })
// → #34 POST 201 142ms ttfb=98ms reqB=312B resB=2.3KB application/json  https://api.yourco.com/orders
//     request_headers:
//       Authorization: Bearer eyJhbG...
//       Content-Type: application/json
//     request_body:
//       {"sku":"PRO_MONTHLY","quantity":1,"coupon":"WELCOME10"}
//     response_body:
//       {"order_id":"ord_8a3f2c","total":2700,...}
network_get_body({ id: 34, which: "response" })  // full body if it was truncated
```

**Scope:**

- ✅ Catches all `URLSession`-based traffic: native `URLSession`, `URLRequest`, Alamofire, SwiftUI `AsyncImage`, anything that consumes `URLSessionConfiguration.default` or `.ephemeral`
- ✅ Decrypted HTTP/HTTPS bodies — we sit inside the URLSession pipeline above TLS
- ✅ No certificate install, no mitmproxy, no proxy config
- ⚠️ Does NOT catch: raw `CFNetwork` / `nw_connection_t` (low-level networking written against the BSD socket layer), background `URLSession`s, gRPC libraries that bypass URLSession, `WKWebView` resource loads (separate process)
- ⚠️ `HTTPBodyStream` request bodies are noted but not captured (would require draining + rewinding the stream)
- ⚠️ Sessions constructed *before* `network_start` are not retro-fitted; restart the app or relaunch with `inject:true` if you need to catch app-startup traffic

## Network stubbing (Layer 2f)

Register canned responses for any URL substring; the dylib synthesizes the response instead of forwarding. Unlocks deterministic error-path and slow-network testing without touching the backend.

```ts
// Force a 401 for the next login attempt
network_stub({
  url_substring: "/api/auth/login",
  method: "POST",
  status: 401,
  headers: { "Content-Type": "application/json" },
  body: '{"error":"invalid_credentials"}',
})

// Simulate slow API for offline-UX testing — 3 second delay
network_stub({
  url_substring: "/api/products",
  delay_ms: 3000,
  status: 200,
  body: '[{"sku":"FAKE","name":"Stub Product"}]',
})

// Now drive the app — login fails as if password was wrong; product list spinner shows
network_stubs()       // list active stubs
network_unstub({id})  // remove one
network_unstub_all()  // clear them all
```

Stubbed requests still appear in `network_tail` with `stubbed:true` and the matching `stub_id`, so you can verify the app sent what you expected before the synthesized response.

## Scripting the running app (Layer 2e)

```ts
launch_app({ bundle_id: "com.yourco.app", inject: true })

eval_js({ code: "bundle.bundleIdentifier" })
// → "com.yourco.app"

eval_js({ code: "app.windows[0].rootViewController.title || 'untitled'" })
// → "Home"

// Toggle a feature flag stored in NSUserDefaults
eval_js({ code: "defaults.setBoolForKey(true, 'feature.dark_mode'); 'set'" })

// Inspect or mutate a live view
eval_js({ code: "var v = find_view_by_class('UITextField'); v && (v.text = 'qa@example.com')" })

// Define a helper, use it later — state persists across calls
eval_js({ code: "function visibleWindows(){return all_windows().filter(w => !w.isHidden && w.alpha > 0.01);}" })
eval_js({ code: "visibleWindows().length" })
// → 1
```

Bridged globals (all installed automatically on first `eval_js`):

| Global | Type | Use |
|---|---|---|
| `app` | UIApplication | `app.windows`, `app.applicationState` |
| `key_window()` | → UIWindow | most-foreground window |
| `all_windows()` | → [UIWindow] | every window across all scenes |
| `defaults` | NSUserDefaults | `stringForKey`, `setObjectForKey`, etc. |
| `pasteboard` | UIPasteboard | `string` getter/setter |
| `bundle` | NSBundle | `bundleIdentifier`, `infoDictionary` |
| `process` | NSProcessInfo | `processName`, `environment`, `processIdentifier` |
| `notif_center` | NSNotificationCenter | |
| `first_responder()` | → UIResponder | currently focused responder |
| `find_view_by_ax_id(id)` | → UIView \| null | quick view lookup |
| `find_view_by_class(name)` | → UIView \| null | first-match by class name |
| `find_vc_by_class(name)` | → UIViewController \| null | walks rootVC → presented + children |
| `post_notification(name, userInfo?)` | → void | fire an NSNotification |
| `cls(name)` | → Class | `NSClassFromString` shortcut |
| `log(msg)` | → void | writes to os_log (visible via `log_tail`) |

JSC's `JSExport` is implemented on UIView, UIWindow, UIViewController, UILabel, UIButton, UITextField, UITextView, UIApplication, NSBundle, NSProcessInfo, NSUserDefaults, UIPasteboard so common property access and method calls work without further bridging. Selector colons become camelCase function names: `setObject:forKey:` → `setObjectForKey(value, key)`.

## App extensions, helpers, plugin hosts

`SIMCTL_CHILD_DYLD_INSERT_LIBRARIES` only affects the process `simctl` directly launches — not SpringBoard, not Mediaserverd, not other system daemons. Within your app's *own* sub-processes (XPC helpers, app extensions launched on demand: share, action, today widget), the dylib will load if `dyld` honors the env var. To keep things sane:

- If a loaded process has `[NSBundle mainBundle].bundleIdentifier` empty or nil (XPC helpers, certain plugin hosts), the dylib **silently skips socket binding** — no MCP exposure, no `/tmp/ios-sim-mcp-*.sock` path collision with the main app.
- If a loaded process is a real app extension with its own bundle id (e.g. `com.yourco.app.ShareExtension`), the dylib opens a **distinct socket** at `/tmp/ios-sim-mcp-<extension-bundle-id>.sock`. You can drive the extension independently by passing that bundle id to `dylib_*` tools.
- In normal flows you only `launch_app` your main app. Extensions launched by iOS during a share/widget interaction are technically reachable but not normally targeted — set `bundle_id` explicitly on every tool call when you want one.

## Distribution model — why runtime injection, not SwiftPM

We ship Option 1: prebuilt universal dylib, injected at runtime via `DYLD_INSERT_LIBRARIES`. Devs add **nothing** to their Xcode project — no SPM dep, no build setting, no `#if DEBUG` guard. The dylib physically isn't part of their app, so App Store submission and production builds are unaffected.

The alternatives we considered:

| Option | What it'd unlock | What it costs |
|---|---|---|
| **1. Runtime DYLD inject** (current) | Zero integration. Works on any sim build. App Store untouched. | Limited to public + JSExport-bridged ObjC. No access to `internal` Swift types. |
| 2. SwiftPM dev-dependency | `@testable` import → access to your app's internal types. Compile-time `#if DEBUG` enforcement. Custom hooks at app-defined seams. | Devs add a package, gate it behind `#if DEBUG`, accept some compile-time hit on test builds. |
| 3. Both | Best of both for devs who want it. | Twice the surface to maintain. |

Option 1 covers the 90% case (driving any iOS sim with no project changes), so we shipped it first. Option 2/3 are reasonable future additions if a user team specifically wants to introspect their own Swift internals.

## Safety & production posture

The Layer 2 dylib is engineered to **never crash the host app**:

- `SIGPIPE` is ignored globally and `SO_NOSIGPIPE` set per-fd, so a closed MCP-side socket cannot kill the host process.
- Every dispatched task (accept loop, per-connection serve, URLSession delegate callbacks, stub synthesis, view walks, JS eval) is wrapped in `@try` and logs via `os_log` on catch rather than propagating.
- The accept loop survives transient `accept()` failures with a 250ms backoff instead of exiting.
- Method handlers run on a background queue; UIKit-touching ones bounce to main via `dispatch_sync` with caller-controllable timeouts.
- Buffers are bounded: 5,000 log lines, 500 network records (configurable), 256KB body cap (configurable).
- All shared state is `NSLock`-protected.

**This is a dev/test tool, not for production builds.** Two safety invariants make it appropriate only for engineering simulators:

1. **No App Store risk** — `DYLD_INSERT_LIBRARIES` is a *runtime* injection via `SIMCTL_CHILD_*` env vars. The dylib is never linked, embedded, or shipped with your app binary. App Store builds physically cannot load it.
2. **Opt-in per launch** — `launch_app` defaults to `inject: false`. The dylib only loads when you explicitly pass `inject: true`, and only in the simulator (Apple's hardened-runtime + code-signing requirements prevent DYLD injection into real-device or production builds).

If you accidentally call a dylib-only tool (`view_tree`, `eval_js`, `network_*`, etc.) without `inject: true`, you get an actionable error pointing at the fix — never a hang or a crash. Use `dylib_health` for non-throwing feature detection in scripts.

## Roadmap

- **`describe_point`** — "what's under (x,y)?" for debugging gesture targets.
- **Video recording** — wrap `idb record-video` as `record_start`/`record_stop`.
- **Multi-sim parallelism** — share one server across multiple booted devices for matrix testing.
- **JS interactive REPL tool** — multi-line buffer with history, useful for ad-hoc exploration.

## License

MIT.
