/**
 * Centralizes provider identifiers, CLI invocation specs, cache budgets, and
 * native customization paths so server, frontend, and host daemon bundles stay
 * synchronized without inline magic values.
 */

/**
 * Persisted on thread rows; changing this would orphan existing threads. Kept
 * equal to the plugin id (`bb-plugin-agy` -> `agy`) because icon names are
 * namespaced by plugin id, and distinct from the marketplace's `antigravity`
 * plugin so both can be installed side by side.
 */
export const PROVIDER_ID = "agy" as const;

/** Keeps picker, header, and usage card titles uniform across all three bundles. */
export const PROVIDER_DISPLAY_NAME = "Antigravity" as const;

/** Groups Antigravity with ACP-backed harnesses where BB categorizes families. */
export const ACP_PROVIDER_FAMILY = "acp" as const;

/**
 * Connects `server.ts` bridge options to `host.ts` dialect registration without
 * colliding with SDK built-in dialects (`acp`, `cursor`, `grok`, `omp`, `opencode`).
 */
export const ACP_DIALECT_ID = PROVIDER_ID;

/** Relies on portable host toolchain lookup plus GUI `PATH` fallbacks at runtime. */
export const AGY_COMMAND = "agy" as const;

/** Selects Antigravity's stdio JSON-RPC mode instead of launching the interactive TUI. */
export const AGY_ACP_ARGS: readonly string[] = ["acp"];

/** Forces `agy acp` to complete OAuth sign-in and exit rather than serving sessions. */
export const AGY_LOGIN_FLAG = "--login" as const;

/**
 * Runs interactive Google sign-in and exits immediately instead of opening an
 * interactive TUI session when credentials expire.
 */
export const AGY_LOGIN_COMMAND = [
  AGY_COMMAND,
  ...AGY_ACP_ARGS,
  AGY_LOGIN_FLAG,
].join(" ");

/**
 * Queries account quota in non-interactive print mode so usage polling never
 * opens an agent session or consumes model tokens.
 */
export const AGY_USAGE_ARGS: readonly string[] = [
  "-p",
  "/usage",
  "--output-format",
  "json",
];

/**
 * Bounds a hung `agy` process well inside BB's 45-second usage RPC deadline so
 * usage panels degrade cleanly instead of timing out the entire RPC channel.
 */
export const USAGE_TIMEOUT_MS = 20_000 as const;

/** Guards memory if CLI output ever misbehaves; normal JSON is ~2 KiB. */
export const USAGE_MAX_BUFFER_BYTES = 1_048_576 as const;

/**
 * Bounds post-SIGTERM cleanup so a child ignoring polite termination escalates
 * to `SIGKILL` instead of holding a usage probe open indefinitely.
 */
export const USAGE_KILL_SETTLE_TIMEOUT_MS = 1_000 as const;

/**
 * Coalesces simultaneous `provider/health` and `provider/usage` probes on the
 * host daemon while staying short enough for manual UI refreshes.
 */
export const BRIDGE_USAGE_CACHE_TTL_MS = 10_000 as const;

/**
 * Avoids re-spawning `agy` on every passive UI mount (`refresh: false`) while
 * allowing `refresh: true` to bypass immediately, matching built-in providers.
 */
export const SERVER_USAGE_CACHE_TTL_MS = 60_000 as const;

/**
 * Detects signed-out OAuth prompts streamed to stdout so the plugin can stop
 * the child immediately instead of waiting out the full usage timeout.
 */
export const AGY_AUTH_REQUIRED_MARKER = "Authentication required" as const;

/** Directs users to vetted manual CLI setup rather than unverified remote scripts. */
export const AGY_INSTALL_URL = "https://antigravity.google/docs" as const;

/** Satisfies the ACP maintenance dialect contract when SDK callers inspect installer metadata. */
export const AGY_INSTALLER_URL =
  "https://antigravity.google/cli/install.sh" as const;

/** Prefixes host-daemon log lines so failures are attributable in shared logs. */
export const LOG_PREFIX = `[${PROVIDER_ID}]`;

/** Antigravity's `/usage` payload omits plan names, so no badge is synthesized. */
export const USAGE_PLAN_LABEL: string | null = null;

/** Matches `bb.branding.experimental_icons` in `package.json` so manifest icons resolve. */
export const ICON_NAME = PROVIDER_ID;

/**
 * Single owner of the `<pluginId>/<iconName>` identifier shared by `server.ts`
 * provider registration and `app.tsx` multicolor icon replacement.
 */
export const DECLARED_PLUGIN_ICON_NAME = `${PROVIDER_ID}/${ICON_NAME}` as const;

/**
 * Tints BB's CSS mask fallback in Antigravity blue during the brief window
 * before the deferred `app.js` bundle mounts the multicolor SVG component.
 */
export const ANTIGRAVITY_BRAND_TINT = "#3E92F6" as const;

/**
 * Window label tokens shared by the host (`usage.ts`, which builds labels) and
 * the server (`usage-source.ts`, which derives `kind`/`model` from them); one
 * owner keeps the two bundles from drifting apart silently.
 */
export const WEEKLY_WINDOW_LABEL = "Weekly" as const;
export const FIVE_HOUR_WINDOW_LABEL = "5 hours" as const;
export const WINDOW_LABEL_SEPARATOR = " · " as const;

/**
 * Home-relative directories appended to `PATH` when BB launches from macOS
 * Dock/Finder with a minimal GUI environment lacking `~/.local/bin`.
 */
export const USER_RELATIVE_BIN_DIRS: readonly string[] = [
  ".local/bin",
  ".local/share/mise/shims",
  ".asdf/shims",
];

/** Standard POSIX binary locations ensured on `PATH` for GUI-launched daemons. */
export const SYSTEM_BIN_DIRS: readonly string[] = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
];

/**
 * Permission modes supported by BB's ACP runtime (`approvalEnforcedBy: "runtime"`).
 */
export const PERMISSION_MODES = ["accept-edits", "full"] as const;

/**
 * Reasoning effort ladder matching `agy --effort` and built-in BB harnesses,
 * paired with composer labels so capabilities and UI options stay aligned.
 */
export const REASONING_LEVEL_OPTIONS = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "Extra High" },
  { id: "max", label: "Max" },
] as const;

/** Derives capability ids from `REASONING_LEVEL_OPTIONS` so the two lists cannot diverge. */
export const REASONING_LEVELS = REASONING_LEVEL_OPTIONS.map(
  (option) => option.id,
);

/**
 * Mirrors all official Antigravity customization discovery directories
 * (`.gemini`, `.agents`, `.agent`, `_agents`, `_agent`) so BB indexes native
 * `/` and `$` skills in the composer without re-injecting duplicates.
 */
export const NATIVE_SKILL_ROOTS = {
  user: [
    ".gemini/antigravity-cli/skills",
    ".gemini/antigravity-cli/builtin/skills",
    ".gemini/skills",
    ".gemini/config/skills",
    { path: ".gemini/config/plugins", recursive: true },
    ".agents/skills",
    ".agent/skills",
    "_agents/skills",
    "_agent/skills",
  ],
  project: [
    { path: ".agents/skills", ancestors: true },
    { path: ".agent/skills", ancestors: true },
    { path: "_agents/skills", ancestors: true },
    { path: "_agent/skills", ancestors: true },
  ],
} as const;

/** Keeps setting keys synchronized across schema registration, docs, and CLI examples. */
export const AUTO_COMPACT_ENABLED_SETTING_KEY = "autoCompactEnabled" as const;
export const AUTO_COMPACT_TOKEN_THRESHOLD_SETTING_KEY =
  "autoCompactTokenThreshold" as const;

/** Turns on automatic compaction out of the box so 1M-window sessions stay responsive. */
export const AUTO_COMPACT_ENABLED_DEFAULT = true as const;

/**
 * Default token cap enforced on Antigravity threads so sessions compact well
 * below `agy`'s backend-controlled 512K compaction ceiling on 1M models.
 */
export const AUTO_COMPACT_TOKEN_THRESHOLD_DEFAULT = 250_000 as const;

/** Lower bound prevents accidental tiny thresholds that compact every turn. */
export const AUTO_COMPACT_TOKEN_THRESHOLD_MIN = 1_000 as const;

/** Upper bound accommodates current 1M and near-term 2M context windows. */
export const AUTO_COMPACT_TOKEN_THRESHOLD_MAX = 2_000_000 as const;

/** Prevents stalled loopback reads (`context`, `events.list`, `threads.get`) from wedging per-thread locks. */
export const AUTO_COMPACT_READ_TIMEOUT_MS = 15_000 as const;

/** Bounds fast agent-only yield steer RPCs so a stuck daemon cannot hold per-thread locks. */
export const AUTO_COMPACT_REQUEST_TIMEOUT_MS = 30_000 as const;

/**
 * Allows full LLM summarization during `compact` and `compactFirst` RPCs to
 * settle without falsely timing out large context windows.
 */
export const AUTO_COMPACT_COMPACT_TIMEOUT_MS = 120_000 as const;

/** Caps the in-memory thread tracker so long-lived bb servers stay bounded. */
export const AUTO_COMPACT_MAX_TRACKED_THREADS = 1_000 as const;

/**
 * Bounds lifecycle boundary events scanned per check so `turn/started`,
 * `thread/compacted`, and user requests remain visible even on marathon turns.
 */
export const AUTO_COMPACT_BOUNDARY_EVENTS_LIMIT = "20" as const;

/**
 * Bounds recent tool item events scanned to detect open tool executions
 * without loading full conversation histories over loopback.
 */
export const AUTO_COMPACT_ITEM_EVENTS_LIMIT = "100" as const;

/**
 * Fetches only the newest context usage watermark independently of item volume
 * so high tool counts never age out stale-usage detection.
 */
export const AUTO_COMPACT_USAGE_EVENTS_LIMIT = "1" as const;

/**
 * Circuit breaker capping consecutive automatic mid-turn compactions within a
 * single user prompt so a runaway loop cannot compact indefinitely.
 */
export const AUTO_COMPACT_MAX_CONSECUTIVE = 10 as const;

/**
 * Allows slow high-effort reasoning steps (which can exceed 60s) to finish
 * yielding cleanly before expiring in-memory state; persisted-event recovery
 * still catches even slower turns, plugin reloads, and server restarts.
 */
export const AUTO_COMPACT_YIELD_TIMEOUT_MS = 300_000 as const;

/**
 * Marks plugin-authored agent-only yield and continuation turns so history
 * inspection distinguishes them from user-initiated prompts even after reload.
 */
export const AUTO_COMPACT_MESSAGE_PREFIX = "[bb-plugin-agy] " as const;

/** Shared locale formatting token counts consistently across settings and prompts. */
export const AUTO_COMPACT_TOKEN_LOCALE = "en-US" as const;

/** Shared BB SDK content block type used when authoring and parsing control prompts. */
export const AUTO_COMPACT_TEXT_BLOCK_TYPE = "text" as const;

/** Shared BB SDK visibility hiding auto-compact control prompts from user chat history. */
export const AUTO_COMPACT_AGENT_ONLY_VISIBILITY = "agent-only" as const;

/** Matches BB's HTTP 404 status when a host or thread has been removed. */
export const HTTP_NOT_FOUND = 404 as const;
