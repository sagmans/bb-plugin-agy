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

/** Human-readable provider title across pickers, headers, and usage cards. */
export const PROVIDER_DISPLAY_NAME = "Antigravity" as const;

/** Groups Antigravity with ACP-backed harnesses where BB categorizes families. */
export const ACP_PROVIDER_FAMILY = "acp" as const;

/**
 * Connects `server.ts` bridge options to `host.ts` dialect registration without
 * colliding with SDK built-in dialects (`acp`, `cursor`, `grok`, `omp`, `opencode`).
 */
export const ACP_DIALECT_ID = PROVIDER_ID;

/** Resolved via portable host toolchain and fallback user bin directories. */
export const AGY_COMMAND = "agy" as const;

/** Launches Antigravity's ACP stdio JSON-RPC server. */
export const AGY_ACP_ARGS: readonly string[] = ["acp"];

/** Flag that makes `agy acp` run sign-in and exit instead of serving ACP. */
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
 * Bounds a signed-out `agy` process (which blocks waiting for browser OAuth)
 * well inside BB's 45-second usage RPC timeout so panels report `unauthenticated`
 * instead of hanging.
 */
export const USAGE_TIMEOUT_MS = 20_000 as const;

/** Guards memory if CLI output ever misbehaves; normal JSON is ~2 KiB. */
export const USAGE_MAX_BUFFER_BYTES = 1_048_576 as const;

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

/** Substring `agy` writes to stdout before blocking on interactive OAuth. */
export const AGY_AUTH_REQUIRED_MARKER = "Authentication required" as const;

/** Official documentation linked from BB provider setup surfaces. */
export const AGY_INSTALL_URL = "https://antigravity.google/docs" as const;

/** Official Antigravity installer URL consumed by BB's downloaded-installer helper. */
export const AGY_INSTALLER_URL =
  "https://antigravity.google/cli/install.sh" as const;

/** Prefixes host-daemon log lines so failures are attributable in shared logs. */
export const LOG_PREFIX = `[${PROVIDER_ID}]`;

/** Antigravity's `/usage` payload omits plan names, so no badge is synthesized. */
export const USAGE_PLAN_LABEL: string | null = null;

/** Key under `bb.branding.experimental_icons` in `package.json`. */
export const ICON_NAME = PROVIDER_ID;

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
 * with the picker label for each level.
 */
export const REASONING_LEVEL_OPTIONS = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "Extra High" },
  { id: "max", label: "Max" },
] as const;

/** Effort ids derived from the picker options so the two lists cannot diverge. */
export const REASONING_LEVELS = REASONING_LEVEL_OPTIONS.map(
  (option) => option.id,
);

/**
 * Mirrors Antigravity's native customization discovery locations so BB lists
 * native `/` and `$` skills in the composer without re-injecting duplicates.
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
  ],
  project: [
    { path: ".agents/skills", ancestors: true },
    { path: ".agent/skills", ancestors: true },
  ],
} as const;

/** Setting keys for automatic compaction, shared by registration and docs. */
export const AUTO_COMPACT_ENABLED_SETTING_KEY = "autoCompactEnabled" as const;
export const AUTO_COMPACT_TOKEN_THRESHOLD_SETTING_KEY =
  "autoCompactTokenThreshold" as const;

/** Enables automatic compaction by default to enforce the 250K ceiling. */
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

/** Bounds fast loopback reads (`context`, `events.list`) during threshold checks. */
export const AUTO_COMPACT_READ_TIMEOUT_MS = 15_000 as const;

/** Bounds compaction and continuation RPCs so a stuck daemon cannot stall cleanup. */
export const AUTO_COMPACT_REQUEST_TIMEOUT_MS = 30_000 as const;

/** Caps the in-memory thread tracker so long-lived bb servers stay bounded. */
export const AUTO_COMPACT_MAX_TRACKED_THREADS = 1_000 as const;

/**
 * Bounds lifecycle boundary events scanned per check so `turn/started`,
 * `thread/compacted`, and user requests remain visible even on marathon turns.
 */
export const AUTO_COMPACT_BOUNDARY_EVENTS_LIMIT = "20" as const;

/**
 * Bounds recent item and usage events scanned to detect open tool executions
 * without loading full conversation histories over loopback.
 */
export const AUTO_COMPACT_ITEM_EVENTS_LIMIT = "40" as const;

/**
 * Circuit breaker capping consecutive automatic mid-turn compactions within a
 * single user prompt so a runaway loop cannot compact indefinitely.
 */
export const AUTO_COMPACT_MAX_CONSECUTIVE = 10 as const;

/** Recovers thread state if a steered mid-turn yield never settles to idle. */
export const AUTO_COMPACT_YIELD_TIMEOUT_MS = 60_000 as const;

/** Recovers thread state if a compaction or continuation phase stalls. */
export const AUTO_COMPACT_PHASE_TIMEOUT_MS = 180_000 as const;

/**
 * Marks plugin-authored agent-only yield and continuation turns so history
 * inspection distinguishes them from user-initiated prompts even after reload.
 */
export const AUTO_COMPACT_MESSAGE_PREFIX = "[bb-plugin-agy] " as const;
