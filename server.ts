/**
 * Registers Google Antigravity (`agy`) as a first-class BB agent harness,
 * attaches its `provider-usage.v1` quota source, and enforces configurable
 * auto-compaction (mid-turn with automatic continuation and between turns when
 * idle) so threads, pickers, `/compact`, native skills, and usage surfaces
 * behave identically to built-in BB providers.
 */

import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { registerAutoCompaction } from "./src/auto-compact.ts";
import {
  ACP_DIALECT_ID,
  ACP_PROVIDER_FAMILY,
  AGY_ACP_ARGS,
  AGY_COMMAND,
  AGY_INSTALL_URL,
  AGY_LOGIN_COMMAND,
  ANTIGRAVITY_BRAND_TINT,
  ICON_NAME,
  NATIVE_SKILL_ROOTS,
  PERMISSION_MODES,
  PROVIDER_DISPLAY_NAME,
  PROVIDER_ID,
  REASONING_LEVEL_OPTIONS,
  REASONING_LEVELS,
} from "./src/constants.ts";
import { registerUsageSource } from "./src/usage-source.ts";

/** Server entry: bb calls it once per plugin load and disposes it on unload. */
export default function plugin(bb: BbPluginApi) {
  const registration = bb.providers.register({
    id: PROVIDER_ID,
    displayName: PROVIDER_DISPLAY_NAME,
    family: ACP_PROVIDER_FAMILY,
    icon: `${bb.pluginId}/${ICON_NAME}`,
    strings: {
      signInHint: `Run \`${AGY_LOGIN_COMMAND}\` on the machine to sign in.`,
      expiredHint: `Your ${PROVIDER_DISPLAY_NAME} session expired. Run \`${AGY_LOGIN_COMMAND}\` to sign in again, then reload.`,
      installUrl: AGY_INSTALL_URL,
      iconTint: {
        light: ANTIGRAVITY_BRAND_TINT,
        dark: ANTIGRAVITY_BRAND_TINT,
      },
    },
    experimental_visibility: "installed",
    experimental_bridgeOptions: {
      acpDialect: ACP_DIALECT_ID,
      acpLaunchSpec: {
        displayName: PROVIDER_DISPLAY_NAME,
        command: AGY_COMMAND,
        args: [...AGY_ACP_ARGS],
        env: {},
      },
    },
    maintenance: { health: true, usage: true, installation: false },
    capabilities: {
      supportsServiceTier: false,
      supportsNativeUserQuestion: false,
      supportsManualCompaction: true,
      supportsThreadArchive: false,
      supportsThreadRename: false,
      fork: "none",
      permissionModes: [...PERMISSION_MODES],
      reasoningLevels: [...REASONING_LEVELS],
    },
    reasoningLevels: REASONING_LEVEL_OPTIONS.map((option) => ({ ...option })),
    composerActions: [],
    models: { scope: "host" },
    experimental_nativeSkillRoots: {
      user: [...NATIVE_SKILL_ROOTS.user],
      project: [...NATIVE_SKILL_ROOTS.project],
    },
  });

  bb.onDispose(() => {
    registration.dispose();
  });

  registerUsageSource(bb);
  registerAutoCompaction(bb);
}
