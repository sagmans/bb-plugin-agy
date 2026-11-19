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

/**
 * Raised when `readAccount` cannot confirm a healthy or signed-out state so
 * BB's `getAcpProviderHealth` fails closed to `"unknown"` instead of `"ready"`.
 */
export class AgyAccountProbeError extends Error {
  readonly status: string;

  constructor(message: string, status: string) {
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
  readonly env?: () => NodeJS.ProcessEnv;
  readonly now?: () => number;
  readonly cacheTtlMs?: number;
}

interface UsageCacheEntry {
  readonly at: number;
  settled: boolean;
  readonly value: Promise<ProviderUsageResult>;
}

/** Resolves `agy` via the SDK toolchain, logging unexpected lookup errors once. */
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
 * unsettled in-flight probe (preventing duplicate `agy` spawns when a probe
 * runs past the 10 s TTL) and guards eviction by entry identity.
 */
export function createAntigravityDialect(
  deps: AntigravityDialectDeps = {},
): AcpDialect {
  const resolveCommand = deps.resolveCommand ?? defaultResolveCommand;
  const readUsage = deps.readUsage ?? readAgyUsage;
  const getEnv = deps.env ?? (() => process.env);
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
      return readUsage(resolved, getEnv());
    })();
    const entry: UsageCacheEntry = {
      at: timestamp,
      settled: false,
      value: probe,
    };
    cached = entry;
    probe.then(
      (result) => {
        entry.settled = true;
        if (!result.supported || result.usage.status !== "ok") {
          if (cached === entry) {
            cached = null;
          }
        }
      },
      () => {
        entry.settled = true;
        if (cached === entry) {
          cached = null;
        }
      },
    );
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
