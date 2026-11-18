/**
 * Collects and normalizes Antigravity quota buckets on the target host via
 * `agy -p /usage --output-format json` so OAuth tokens remain solely inside
 * the user's `agy` CLI keychain/store and never cross plugin boundaries.
 */

import { execFile } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import type { ProviderUsageResult } from "@get-bb/plugin-sdk/provider-bridge";
import { z } from "zod";
import {
  AGY_AUTH_REQUIRED_MARKER,
  AGY_LOGIN_COMMAND,
  AGY_USAGE_ARGS,
  FIVE_HOUR_WINDOW_LABEL,
  LOG_PREFIX,
  SYSTEM_BIN_DIRS,
  USAGE_MAX_BUFFER_BYTES,
  USAGE_PLAN_LABEL,
  USAGE_TIMEOUT_MS,
  USER_RELATIVE_BIN_DIRS,
  WEEKLY_WINDOW_LABEL,
  WINDOW_LABEL_SEPARATOR,
} from "./constants.ts";

const SUCCESS_STATUS = "SUCCESS" as const;
const WEEKLY_WINDOW_KEY = "weekly" as const;
const FIVE_HOUR_WINDOW_KEY = "5h" as const;
const WEEKLY_SORT_ORDER = 0 as const;
const OTHER_SORT_ORDER = 1 as const;
const PERCENT_MULTIPLIER = 100 as const;
const MIN_PERCENT = 0 as const;
const MAX_PERCENT = 100 as const;
const TERMINATION_SIGNAL = "SIGTERM" as const;
const PATH_ENV_NAME = "PATH" as const;
const USAGE_OPERATION = "agy.usage.exec" as const;
const NON_JSON_MESSAGE = "agy returned usage output that is not JSON." as const;
const UNREADABLE_PAYLOAD_MESSAGE =
  "agy returned usage information bb could not read." as const;
const GENERIC_EXEC_FAILURE_MESSAGE =
  "agy could not report usage on this machine." as const;
const OVERSIZED_OUTPUT_MESSAGE =
  "agy returned more usage output than bb accepts." as const;
const TIMED_OUT_MESSAGE = `agy did not answer in time. Run \`${AGY_LOGIN_COMMAND}\` to sign in, then reload.`;
/** Node's code when `maxBuffer` is exceeded; it also kills the child, like a timeout. */
const MAX_BUFFER_ERROR_CODE = "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" as const;

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

/** Subprocess facts kept for a one-pass diagnosis of a failed usage read. */
export interface AgyUsageErrorDetails {
  readonly operation: string;
  readonly command: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly oversized: boolean;
  readonly elapsedMs: number;
}

/**
 * Preserves structured subprocess diagnostics and root `cause` when the CLI
 * fails or times out so host daemon logs enable single-pass investigation.
 */
export class AgyUsageError extends Error {
  readonly details: AgyUsageErrorDetails;

  constructor(
    message: string,
    details: AgyUsageErrorDetails,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "AgyUsageError";
    this.details = details;
  }
}

interface AgyRunResult {
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Appends standard user/Homebrew bin paths (`~/.local/bin`, `/opt/homebrew/bin`)
 * when missing so `agy` resolves reliably after restarting BB from macOS Dock
 * or Spotlight where inherited GUI `PATH` omits user shell additions.
 */
export function buildPortableCliEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const home = env.HOME?.trim() || homedir();
  const existingEntries = (env[PATH_ENV_NAME] ?? "")
    .split(path.delimiter)
    .filter(Boolean);
  const seen = new Set(existingEntries);
  const merged = [...existingEntries];

  const fallbackDirs = [
    ...USER_RELATIVE_BIN_DIRS.map((rel) => path.join(home, rel)),
    ...(process.platform === "win32" ? [] : SYSTEM_BIN_DIRS),
  ];
  for (const dir of fallbackDirs) {
    if (!seen.has(dir)) {
      seen.add(dir);
      merged.push(dir);
    }
  }

  return {
    ...env,
    [PATH_ENV_NAME]: merged.join(path.delimiter),
  };
}

/**
 * Enforces an explicit timeout and output ceiling around `agy -p /usage` so a
 * signed-out CLI waiting on interactive browser OAuth fails closed into a
 * structured state instead of wedging BB's usage panel.
 */
function runAgyUsage(
  command: string,
  env: NodeJS.ProcessEnv,
): Promise<AgyRunResult> {
  const startedAt = Date.now();
  const childEnv = buildPortableCliEnv(env);

  return new Promise((resolve, reject) => {
    execFile(
      command,
      [...AGY_USAGE_ARGS],
      {
        env: childEnv,
        timeout: USAGE_TIMEOUT_MS,
        killSignal: TERMINATION_SIGNAL,
        maxBuffer: USAGE_MAX_BUFFER_BYTES,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ stdout, stderr });
          return;
        }
        if (stdout.includes(AGY_AUTH_REQUIRED_MARKER)) {
          resolve({ stdout, stderr });
          return;
        }
        const elapsedMs = Date.now() - startedAt;
        // Both a timeout and a maxBuffer overflow kill the child with SIGTERM;
        // the error code tells them apart so users get the right advice.
        const oversized = error.code === MAX_BUFFER_ERROR_CODE;
        const timedOut =
          !oversized &&
          (error.killed === true || error.signal === TERMINATION_SIGNAL);
        const exitCode = typeof error.code === "number" ? error.code : null;
        const signal = error.signal ?? null;
        reject(
          new AgyUsageError(
            timedOut
              ? `agy usage timed out after ${USAGE_TIMEOUT_MS} ms`
              : oversized
                ? `agy usage output exceeded ${USAGE_MAX_BUFFER_BYTES} bytes`
                : "agy usage exited with an error",
            {
              operation: USAGE_OPERATION,
              command,
              exitCode,
              signal,
              timedOut,
              oversized,
              elapsedMs,
            },
            { cause: error },
          ),
        );
      },
    );
  });
}

/** Antigravity reports what is left; bb's bars show what is used, clamped to 0-100. */
function usedPercent(bucket: UsageBucket): number {
  const used = (1 - bucket.remaining_fraction) * PERCENT_MULTIPLIER;
  return Math.round(Math.min(MAX_PERCENT, Math.max(MIN_PERCENT, used)));
}

/** Builds the `<window> · <model group>` label the server later parses back. */
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

/**
 * Converts subprocess failures into typed `ProviderUsageResult` error states
 * while logging full diagnostic context to stderr (keeping stdout clean for
 * Bridge JSON-RPC frames).
 */
export async function readAgyUsage(
  command: string,
  env: NodeJS.ProcessEnv,
): Promise<ProviderUsageResult> {
  try {
    const { stdout } = await runAgyUsage(command, env);
    return parseAgyUsage(stdout);
  } catch (error) {
    if (error instanceof AgyUsageError) {
      // Node puts the child's stderr in the cause message, and agy may print
      // sign-in URLs there; log only the error code so no auth data leaks.
      const causeCode =
        error.cause instanceof Error && "code" in error.cause
          ? String(error.cause.code)
          : "unknown";
      console.error(
        `${LOG_PREFIX} op=${error.details.operation} cmd=${error.details.command} ` +
          `exitCode=${error.details.exitCode} signal=${error.details.signal} ` +
          `timedOut=${error.details.timedOut} oversized=${error.details.oversized} ` +
          `elapsedMs=${error.details.elapsedMs} causeCode=${causeCode}`,
      );
      return usageError(
        error.details.timedOut
          ? TIMED_OUT_MESSAGE
          : error.details.oversized
            ? OVERSIZED_OUTPUT_MESSAGE
            : GENERIC_EXEC_FAILURE_MESSAGE,
      );
    }
    throw error;
  }
}
