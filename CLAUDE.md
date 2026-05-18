# ios-sim-mcp

MCP server for driving the iOS Simulator the way Chrome MCP drives a browser: semantic AX tree with stable refs, fast snapshot/tap/type cycles, no screenshot-and-click loops.

## Architecture

**Layer 1 (current, shipping):** wraps `idb` (Facebook's iOS Device Bridge — talks to CoreSimulator's private framework, no WebDriverAgent bridge). Each call is ~100ms.

**Layer 2 (planned, not built):** `DYLD_INSERT_LIBRARIES` dylib injected at app launch. Opens a Unix socket exposing live `UIView` hierarchy, JavaScriptCore eval against running app state, `URLProtocol`-based network interception with bodies, and structured event streams. Opt-in per app via env var.

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
