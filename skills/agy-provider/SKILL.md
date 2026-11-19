---
name: agy-provider
description: Configure Antigravity (agy) provider settings and auto-compaction.
---

# Antigravity (`agy`) provider

The `agy` plugin runs Google Antigravity (`agy acp`) as a BB agent provider and
enforces configurable auto-compaction on `agy` threads without stopping or
pausing active sessions.

## Auto-compaction settings

Configure settings in **Settings -> Installed plugins -> Antigravity** or via
the CLI:

```sh
bb plugin config agy
bb plugin config agy set autoCompactEnabled true
bb plugin config agy set autoCompactTokenThreshold 250000
```

| Setting | Type | Default | Constraints |
| --- | --- | --- | --- |
| `autoCompactEnabled` | boolean | `true` | Toggles automatic compaction on `agy` threads |
| `autoCompactTokenThreshold` | integer | `250000` | Whole tokens in `[1000, 2000000]` |

## How auto-compaction runs

- **Mid-turn with automatic continuation:** While an `agy` thread is active,
  once reported `usedTokens` reaches `autoCompactTokenThreshold` at a tool-free
  step boundary, the plugin steers the turn to yield cleanly on the same ACP
  process, compacts context (`compactFirst`), and immediately sends an
  agent-only continuation turn so the session keeps running.
- **Between turns on idle threads:** If a turn finishes above the threshold on
  its own, the plugin compacts context in place without restarting `agy`, so
  in-process background tasks and subagents remain alive.
- **Safety and loop protection:** Never interrupts running tool calls, honors
  manual stops, skips threads with queued user messages or active BB subagents,
  and latches against re-compacting until usage drops below threshold or a new
  user turn starts (capped at 10 consecutive compactions per prompt).
- **Manual compaction:** `/compact` and `bb thread compact <id>` remain
  available regardless of `autoCompactEnabled`.
