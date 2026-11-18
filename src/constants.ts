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
