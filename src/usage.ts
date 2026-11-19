/**
 * Normalizes Antigravity quota payloads on the target host via
 * `agy -p /usage --output-format json` so OAuth tokens remain solely inside
 * the user's `agy` CLI keychain/store and never cross plugin boundaries.
 */

import type { ProviderUsageResult } from "@get-bb/plugin-sdk/provider-bridge";
import { z } from "zod";
import {
  AGY_AUTH_REQUIRED_MARKER,
  AGY_LOGIN_COMMAND,
  FIVE_HOUR_WINDOW_LABEL,
  LOG_PREFIX,
  USAGE_PLAN_LABEL,
  WEEKLY_WINDOW_LABEL,
  WINDOW_LABEL_SEPARATOR,
} from "./constants.ts";
import {
  AgyUsageError,
  type AgyUsageErrorDetails,
  type AgyUsageFailureKind,
  buildPortableCliEnv,
  type ReadAgyUsageOptions,
  runAgyUsage,
} from "./usage-exec.ts";

export {
  AgyUsageError,
  type AgyUsageErrorDetails,
  type AgyUsageFailureKind,
  buildPortableCliEnv,
  type ReadAgyUsageOptions,
};

const SUCCESS_STATUS = "SUCCESS" as const;
const WEEKLY_WINDOW_KEY = "weekly" as const;
const FIVE_HOUR_WINDOW_KEY = "5h" as const;
const WEEKLY_SORT_ORDER = 0 as const;
const OTHER_SORT_ORDER = 1 as const;
const PERCENT_MULTIPLIER = 100 as const;
const MIN_PERCENT = 0 as const;
const MAX_PERCENT = 100 as const;
const NON_JSON_MESSAGE = "agy returned usage output that is not JSON." as const;
const UNREADABLE_PAYLOAD_MESSAGE =
  "agy returned usage information bb could not read." as const;
const GENERIC_EXEC_FAILURE_MESSAGE =
  "agy could not report usage on this machine." as const;
const OVERSIZED_OUTPUT_MESSAGE =
  "agy returned more usage output than bb accepts." as const;
const TIMED_OUT_MESSAGE = `agy did not answer in time. Run \`${AGY_LOGIN_COMMAND}\` to sign in, then reload.`;

const bucketSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    window: z.string().min(1),
    remaining_fraction: z.number().min(0).max(1),
    reset_time: z.string().min(1).nullish(),
  })
  .passthrough();

const groupSchema = z
  .object({
    name: z.string().min(1),
    buckets: z.array(bucketSchema),
  })
  .passthrough();

const usagePayloadSchema = z
  .object({
    status: z.string(),
    command: z
      .object({
        data: z.object({ groups: z.array(groupSchema) }).passthrough(),
      })
      .passthrough(),
  })
  .passthrough();

type UsageGroup = z.infer<typeof groupSchema>;
type UsageBucket = z.infer<typeof bucketSchema>;

/**
 * Aligns Antigravity's raw window keys with labels BB's Provider usage card
 * already abbreviates (`Weekly` -> `7d` in compact sidebar view).
 */
const WINDOW_LABELS: Readonly<Record<string, string>> = {
  [FIVE_HOUR_WINDOW_KEY]: FIVE_HOUR_WINDOW_LABEL,
  [WEEKLY_WINDOW_KEY]: WEEKLY_WINDOW_LABEL,
};

/** Keeps multi-model quota labels legible inside narrow sidebar cards. */
const GROUP_SHORT_NAMES: Readonly<Record<string, string>> = {
  "Gemini Models": "Gemini",
  "Claude and GPT models": "Claude/GPT",
};

/** Antigravity reports what is left; bb's bars show what is used, clamped to 0-100. */
function usedPercent(bucket: UsageBucket): number {
  const used = (1 - bucket.remaining_fraction) * PERCENT_MULTIPLIER;
  return Math.round(Math.min(MAX_PERCENT, Math.max(MIN_PERCENT, used)));
}

/** Pairs window kind and model group so the server can recover both without schema drift. */
function windowLabel(group: UsageGroup, bucket: UsageBucket): string {
  const base = WINDOW_LABELS[bucket.window] ?? bucket.name;
  const groupName = GROUP_SHORT_NAMES[group.name] ?? group.name;
  return `${base}${WINDOW_LABEL_SEPARATOR}${groupName}`;
}

/**
 * Orders weekly quotas ahead of five-hour rolling windows per model family to
 * match the visual rhythm of BB's Codex and Claude Code usage cards.
 */
function toWindows(groups: readonly UsageGroup[]) {
  const order = (bucket: UsageBucket) =>
    bucket.window === WEEKLY_WINDOW_KEY ? WEEKLY_SORT_ORDER : OTHER_SORT_ORDER;
  return groups.flatMap((group) =>
    [...group.buckets]
      .sort((a, b) => order(a) - order(b))
      .map((bucket) => ({
        label: windowLabel(group, bucket),
        usedPercent: usedPercent(bucket),
        resetsAt: bucket.reset_time ?? null,
      })),
  );
}

/**
 * Validates and transforms CLI stdout in isolation so smoke checks can verify
 * live, signed-out, and malformed responses deterministically.
 */
export function parseAgyUsage(stdout: string): ProviderUsageResult {
  if (stdout.includes(AGY_AUTH_REQUIRED_MARKER)) {
    return { supported: true, usage: { status: "unauthenticated" } };
  }
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    return usageError(NON_JSON_MESSAGE);
  }
  const parsed = usagePayloadSchema.safeParse(json);
  if (!parsed.success || parsed.data.status !== SUCCESS_STATUS) {
    return usageError(UNREADABLE_PAYLOAD_MESSAGE);
  }
  return {
    supported: true,
    usage: {
      status: "ok",
      accountEmail: null,
      planLabel: USAGE_PLAN_LABEL,
      windows: toWindows(parsed.data.command.data.groups),
    },
  };
}

/** Shapes a user-facing failure as a usage result so panels show a message, not a crash. */
function usageError(message: string): ProviderUsageResult {
  return {
    supported: true,
    usage: { status: "error", message, accountEmail: null, planLabel: null },
  };
}

/** Maps non-missing failure kinds to actionable user-facing messages. */
function userMessageForFailure(failureKind: AgyUsageFailureKind): string {
  if (failureKind === "timeout") {
    return TIMED_OUT_MESSAGE;
  }
  if (failureKind === "max-buffer") {
    return OVERSIZED_OUTPUT_MESSAGE;
  }
  return GENERIC_EXEC_FAILURE_MESSAGE;
}

/**
 * Converts subprocess failures into typed `ProviderUsageResult` states while
 * logging sanitized diagnostic context to stderr (keeping stdout clean for
 * Bridge JSON-RPC frames and never leaking child stderr OAuth URLs).
 */
export async function readAgyUsage(
  command: string,
  env: NodeJS.ProcessEnv,
  options?: ReadAgyUsageOptions,
): Promise<ProviderUsageResult> {
  try {
    const { stdout } = await runAgyUsage(command, env, options);
    return parseAgyUsage(stdout);
  } catch (error) {
    if (error instanceof AgyUsageError) {
      if (error.details.failureKind === "not-installed") {
        return { supported: true, usage: { status: "not_installed" } };
      }
      const causeCode =
        error.cause instanceof Error && "code" in error.cause
          ? String(error.cause.code)
          : "none";
      console.error(
        `${LOG_PREFIX} op=${error.details.operation} cmd=${error.details.command} ` +
          `failureKind=${error.details.failureKind} exitCode=${error.details.exitCode} ` +
          `signal=${error.details.signal} elapsedMs=${error.details.elapsedMs} ` +
          `causeCode=${causeCode}`,
      );
      return usageError(userMessageForFailure(error.details.failureKind));
    }
    throw error;
  }
}
