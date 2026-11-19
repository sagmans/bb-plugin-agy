/**
 * Contributes Antigravity-specific maintenance hooks (account auth probe and
 * quota collection) to BB's generic ACP bridge while keeping session execution
 * on standard ACP wire semantics.
 */

import {
  experimental_downloadedInstallerCommand,
  experimental_resolveExecutablePath,
  type ProviderUsageResult,
} from "@get-bb/plugin-sdk/provider-bridge";
import type { AcpDialect } from "@get-bb/plugin-sdk/provider-bridge/acp";
import {
  ACP_DIALECT_ID,
  AGY_COMMAND,
  AGY_INSTALLER_URL,
  AGY_LOGIN_COMMAND,
  BRIDGE_USAGE_CACHE_TTL_MS,
  LOG_PREFIX,
} from "./constants.ts";
import { readAgyUsage } from "./usage.ts";

const UNSUPPORTED_USAGE_MESSAGE =
  "Antigravity account state could not be verified on this machine." as const;
const EXPIRED_SESSION_MESSAGE =
  `Your Antigravity session expired. Run \`${AGY_LOGIN_COMMAND}\` to sign in again, then reload.` as const;
const NOT_INSTALLED_MESSAGE =
  "Antigravity CLI (`agy`) is not installed on this machine." as const;

/** Non-ready probe outcomes that must fail closed to `"unknown"` in BB health checks. */
export type AgyAccountProbeStatus =
  | "unsupported"
  | "expired"
  | "not_installed"
  | "error";

/**
 * Raised when `readAccount` cannot confirm a healthy or signed-out state so
 * BB's `getAcpProviderHealth` fails closed to `"unknown"` instead of `"ready"`.
 */
export class AgyAccountProbeError extends Error {
  readonly status: AgyAccountProbeStatus;

  constructor(message: string, status: AgyAccountProbeStatus) {
    super(message);
    this.name = "AgyAccountProbeError";
    this.status = status;
  }
}

/** Dependencies injectable by smoke scenarios to verify race and failure paths. */
export interface AntigravityDialectDeps {
  readonly resolveCommand?: (command: string) => Promise<string | null>;
  readonly readUsage?: (
    command: string,
    env: NodeJS.ProcessEnv,
  ) => Promise<ProviderUsageResult>;
  readonly now?: () => number;
  readonly cacheTtlMs?: number;
}

interface UsageCacheEntry {
  at: number;
  settled: boolean;
  readonly value: Promise<ProviderUsageResult>;
}

/** Falls back to bare command lookup if SDK path inspection hits a permission error. */
async function defaultResolveCommand(command: string): Promise<string | null> {
  return experimental_resolveExecutablePath(command).catch((error: unknown) => {
    console.error(
      `${LOG_PREFIX} op=agy.resolve cmd=${command} ` +
        `cause=${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  });
}

/**
 * Converts usage probe states into `AcpMaintenanceDialect.readAccount()`
 * semantics so only verified `"ok"` probes report `"ready"`.
 */
function accountFromUsageResult(
  result: ProviderUsageResult,
): { email: string | null } | null {
  if (!result.supported) {
    throw new AgyAccountProbeError(UNSUPPORTED_USAGE_MESSAGE, "unsupported");
  }
  switch (result.usage.status) {
    case "ok":
      return { email: result.usage.accountEmail };
    case "unauthenticated":
      return null;
    case "expired":
      throw new AgyAccountProbeError(EXPIRED_SESSION_MESSAGE, "expired");
    case "not_installed":
      throw new AgyAccountProbeError(NOT_INSTALLED_MESSAGE, "not_installed");
    case "error":
      throw new AgyAccountProbeError(result.usage.message, "error");
  }
}

/**
 * Builds an isolated Antigravity ACP dialect instance whose cache reuses any
 * unsettled in-flight probe, starts the post-probe TTL on completion rather
 * than launch, and guards eviction by entry identity.
 */
export function createAntigravityDialect(
  deps: AntigravityDialectDeps = {},
): AcpDialect {
  const resolveCommand = deps.resolveCommand ?? defaultResolveCommand;
  const readUsage = deps.readUsage ?? readAgyUsage;
  const getNow = deps.now ?? Date.now;
  const cacheTtlMs = deps.cacheTtlMs ?? BRIDGE_USAGE_CACHE_TTL_MS;

  let cached: UsageCacheEntry | null = null;

  const getCachedUsage = (): Promise<ProviderUsageResult> => {
    const timestamp = getNow();
    if (
      cached !== null &&
      (!cached.settled || timestamp - cached.at < cacheTtlMs)
    ) {
      return cached.value;
    }

    const probe = (async () => {
      const resolved = (await resolveCommand(AGY_COMMAND)) ?? AGY_COMMAND;
      return readUsage(resolved, process.env);
    })();
    const entry: UsageCacheEntry = {
      at: timestamp,
      settled: false,
      value: probe,
    };
    cached = entry;

    const evictIfCurrent = () => {
      entry.settled = true;
      if (cached === entry) {
        cached = null;
      }
    };

    probe.then((result) => {
      if (result.supported && result.usage.status === "ok") {
        entry.settled = true;
        entry.at = getNow();
        return;
      }
      evictIfCurrent();
    }, evictIfCurrent);
    return entry.value;
  };

  return {
    id: ACP_DIALECT_ID,
    maintenance: {
      loginCommand: AGY_LOGIN_COMMAND,
      // Required by AcpMaintenanceDialect's interface; `server.ts` keeps
      // `maintenance.installation: false` so BB never runs remote shell scripts.
      installer: () =>
        experimental_downloadedInstallerCommand(AGY_INSTALLER_URL),
      readAccount: async () => accountFromUsageResult(await getCachedUsage()),
      readUsage: () => getCachedUsage(),
    },
  };
}

/** Shared host-daemon dialect registered by `host.ts`. */
export const antigravityDialect: AcpDialect = createAntigravityDialect();
