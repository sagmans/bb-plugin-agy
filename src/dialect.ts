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

let cached: {
  readonly at: number;
  readonly value: Promise<ProviderUsageResult>;
} | null = null;

/**
 * Shares an in-flight or just-completed usage probe between `provider/health`
 * and `provider/usage` while evicting failures and non-ok states immediately
 * so re-authentication reflects on the very next check.
 */
function cachedUsage(): Promise<ProviderUsageResult> {
  const now = Date.now();
  if (cached !== null && now - cached.at < BRIDGE_USAGE_CACHE_TTL_MS) {
    return cached.value;
  }
  const value = (async () => {
    const resolvedCommand =
      (await experimental_resolveExecutablePath(AGY_COMMAND).catch(
        (error: unknown) => {
          // Fall back to a bare PATH lookup, but leave a trace for diagnosis.
          console.error(
            `${LOG_PREFIX} op=agy.resolve cmd=${AGY_COMMAND} ` +
              `cause=${error instanceof Error ? error.message : String(error)}`,
          );
          return null;
        },
      )) ?? AGY_COMMAND;
    const result = await readAgyUsage(resolvedCommand, process.env);
    if (!result.supported || result.usage.status !== "ok") {
      cached = null;
    }
    return result;
  })();
  cached = { at: now, value };
  value.catch(() => {
    cached = null;
  });
  return value;
}

/** Antigravity's ACP dialect: sign-in, installer, account and quota hooks for the host bridge. */
export const antigravityDialect: AcpDialect = {
  id: ACP_DIALECT_ID,
  maintenance: {
    loginCommand: AGY_LOGIN_COMMAND,
    installer: () => experimental_downloadedInstallerCommand(AGY_INSTALLER_URL),
    readAccount: async () => {
      const result = await cachedUsage();
      if (result.supported && result.usage.status === "unauthenticated") {
        return null;
      }
      return { email: null };
    },
    readUsage: () => cachedUsage(),
  },
};
