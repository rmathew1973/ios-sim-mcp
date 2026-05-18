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
| 2 — In-process introspection | 🚧 planned | `DYLD_INSERT_LIBRARIES` dylib | live `UIView` hierarchy, JavaScriptCore eval, `URLProtocol` network interception, structured events |
| 3 — System logs | ✅ shipping | `xcrun simctl spawn log stream` | streaming os_log into a 5000-line ring buffer |

`idb` talks directly to CoreSimulator's private framework — no WebDriverAgent, no HTTP hop into the simulator process — which is why the per-call latency is closer to a local subprocess than to a network round trip.

## Requirements

- macOS with Xcode + iOS Simulator
- [`idb`](https://github.com/facebook/idb) (`brew tap facebook/fb && brew install idb-companion && pipx install fb-idb`)
- [Bun](https://bun.sh) (`curl -fsSL https://bun.sh/install | bash`)
- A booted simulator (`xcrun simctl boot <udid>` or open it in Xcode)

## Install

```bash
git clone https://github.com/rmathew1973/ios-sim-mcp.git
cd ios-sim-mcp
bun install
```

### Register with Claude Code

```bash
claude mcp add -s user ios-sim -- bun run "$(pwd)/src/server.ts"
```

Verify:

```bash
claude mcp list | grep ios-sim     # ios-sim: ... ✓ Connected
```

Available in any **new** Claude Code session.

### Register with Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

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
| `type_text` | Type into the focused field. Optional `{ref}` or `{id}` taps-then-types |
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

## Roadmap

- **Layer 2 dylib** — `DYLD_INSERT_LIBRARIES` payload exposing live view hierarchy, JS eval, and a `URLProtocol`-based network interceptor over a Unix socket. The network piece alone is the big unlock: see exactly what URLs the app is hitting, with bodies, in real time.
- **`describe_point`** — "what's under (x,y)?" for debugging gesture targets.
- **Video recording** — wrap `idb record-video` as `record_start`/`record_stop`.
- **Multi-sim parallelism** — share one server across multiple booted devices for matrix testing.

## License

MIT.
