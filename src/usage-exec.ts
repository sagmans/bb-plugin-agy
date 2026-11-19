/**
 * Executes `agy -p /usage --output-format json` through BB's portable process
 * spawner with explicit timeout, output-buffer ceiling, and immediate signed-out
 * OAuth stream termination so probes never hang or misclassify external signals.
 */

import type { ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
  experimental_killPortableProcess,
  experimental_spawnPortableProcess,
} from "@get-bb/plugin-sdk/provider-bridge";
import {
  AGY_AUTH_REQUIRED_MARKER,
  AGY_USAGE_ARGS,
  SYSTEM_BIN_DIRS,
  USAGE_KILL_SETTLE_TIMEOUT_MS,
  USAGE_MAX_BUFFER_BYTES,
  USAGE_TIMEOUT_MS,
  USER_RELATIVE_BIN_DIRS,
} from "./constants.ts";

const SUCCESS_EXIT_CODE = 0 as const;
const ZERO_BYTES = 0 as const;
const KILL_SETTLE_ESCALATION_STEPS = 2 as const;
const USAGE_KILL_FORCE_GIVE_UP_MS =
  USAGE_KILL_SETTLE_TIMEOUT_MS * KILL_SETTLE_ESCALATION_STEPS;
const AUTH_MARKER_OVERLAP = AGY_AUTH_REQUIRED_MARKER.length - 1;
const TERMINATION_SIGNAL: NodeJS.Signals = "SIGTERM";
const FORCE_KILL_SIGNAL: NodeJS.Signals = "SIGKILL";
const PATH_ENV_NAME = "PATH" as const;
const UTF8_ENCODING = "utf8" as const;
const ENOENT_ERROR_CODE = "ENOENT" as const;
const WIN32_PLATFORM = "win32" as const;
const PORTABLE_STDIO = ["ignore", "pipe", "pipe"] as const;
const USAGE_OPERATION = "agy.usage.exec" as const;

/**
 * Distinguishes missing binaries, plugin-enforced timeouts, output overflows,
 * external signals, and non-zero exits without ambiguous boolean combinations.
 */
export type AgyUsageFailureKind =
  | "not-installed"
  | "timeout"
  | "max-buffer"
  | "signal"
  | "exit";

/** Subprocess facts kept for a one-pass diagnosis of a failed usage read. */
export interface AgyUsageErrorDetails {
  readonly operation: string;
  readonly command: string;
  readonly failureKind: AgyUsageFailureKind;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly elapsedMs: number;
}

/** Optional overrides so smoke scenarios can exercise subprocess budgets fast. */
export interface ReadAgyUsageOptions {
  readonly args?: readonly string[];
  readonly timeoutMs?: number;
  readonly maxBufferBytes?: number;
}

/** Collected UTF-8 output streams from a completed or early-stopped probe. */
export interface AgyRunResult {
  readonly stdout: string;
  readonly stderr: string;
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

interface SubprocessBudget {
  readonly command: string;
  readonly startedAt: number;
  readonly timeoutMs: number;
  readonly maxBufferBytes: number;
}

interface SubprocessTracker {
  failureReason: "timeout" | "max-buffer" | null;
  detectedAuthPrompt: boolean;
  totalBytes: number;
  readonly stdoutChunks: Buffer[];
  readonly stderrChunks: Buffer[];
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
    ...(process.platform === WIN32_PLATFORM ? [] : SYSTEM_BIN_DIRS),
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

/** Avoids embedding raw child stderr in Error messages so OAuth URLs never leak. */
function failureLogMessage(
  failureKind: AgyUsageFailureKind,
  budget: SubprocessBudget,
): string {
  switch (failureKind) {
    case "not-installed":
      return "agy executable was not found";
    case "timeout":
      return `agy usage timed out after ${budget.timeoutMs} ms`;
    case "max-buffer":
      return `agy usage output exceeded ${budget.maxBufferBytes} bytes`;
    case "signal":
      return "agy usage was terminated by a signal";
    case "exit":
      return "agy usage exited with an error";
  }
}

/** Captures elapsed duration and root cause at failure time for one-pass diagnosis. */
function createSubprocessError(
  budget: SubprocessBudget,
  failureKind: AgyUsageFailureKind,
  exitCode: number | null,
  signal: NodeJS.Signals | null,
  cause?: unknown,
): AgyUsageError {
  return new AgyUsageError(
    failureLogMessage(failureKind, budget),
    {
      operation: USAGE_OPERATION,
      command: budget.command,
      failureKind,
      exitCode,
      signal,
      elapsedMs: Date.now() - budget.startedAt,
    },
    cause === undefined ? undefined : { cause },
  );
}

/** Separates missing CLI binaries (`ENOENT`) from generic execution failures at the boundary. */
function createSpawnFailureError(
  budget: SubprocessBudget,
  error: unknown,
): AgyUsageError {
  const code =
    error instanceof Error && "code" in error ? error.code : undefined;
  const kind: AgyUsageFailureKind =
    code === ENOENT_ERROR_CODE ? "not-installed" : "exit";
  return createSubprocessError(budget, kind, null, null, error);
}

/**
 * Escalates from polite `SIGTERM` to `SIGKILL` and finally settles if inherited
 * descendant pipes stay open, ensuring wedged children cannot block probes.
 */
function stopPortableChild(
  child: ChildProcess,
  onForcedGiveUp: () => void,
): () => void {
  experimental_killPortableProcess(child, TERMINATION_SIGNAL);
  const escalateTimer = setTimeout(() => {
    experimental_killPortableProcess(child, FORCE_KILL_SIGNAL);
  }, USAGE_KILL_SETTLE_TIMEOUT_MS);
  const giveUpTimer = setTimeout(onForcedGiveUp, USAGE_KILL_FORCE_GIVE_UP_MS);
  return () => {
    clearTimeout(escalateTimer);
    clearTimeout(giveUpTimer);
  };
}

/** Joins retained byte chunks once at settlement to avoid repeated buffer copies. */
function decodeStreams(tracker: SubprocessTracker): AgyRunResult {
  return {
    stdout: Buffer.concat(tracker.stdoutChunks).toString(UTF8_ENCODING),
    stderr: Buffer.concat(tracker.stderrChunks).toString(UTF8_ENCODING),
  };
}

/**
 * Enforces a hard total-byte cap across both streams and scans incremental
 * UTF-8 stdout tails in O(N) time so neither post-limit writes nor chunked
 * output can exhaust host-daemon memory or CPU.
 */
function attachStreamTrackers(
  child: ChildProcess,
  tracker: SubprocessTracker,
  maxBufferBytes: number,
  onEarlyStop: () => void,
): () => void {
  const stdoutDecoder = new StringDecoder(UTF8_ENCODING);
  let stdoutAuthTail = "";

  const recordChunk = (
    chunk: Buffer,
    target: Buffer[],
    inspectAuthMarker: boolean,
  ) => {
    if (tracker.failureReason !== null || tracker.detectedAuthPrompt) {
      return;
    }
    tracker.totalBytes += chunk.byteLength;
    if (tracker.totalBytes > maxBufferBytes) {
      tracker.failureReason = "max-buffer";
      onEarlyStop();
      return;
    }
    target.push(chunk);
    if (!inspectAuthMarker) {
      return;
    }
    const decoded = stdoutDecoder.write(chunk);
    const windowText = stdoutAuthTail + decoded;
    if (windowText.includes(AGY_AUTH_REQUIRED_MARKER)) {
      tracker.detectedAuthPrompt = true;
      onEarlyStop();
      return;
    }
    stdoutAuthTail =
      AUTH_MARKER_OVERLAP > ZERO_BYTES
        ? windowText.slice(-AUTH_MARKER_OVERLAP)
        : "";
  };

  const onStdout = (chunk: Buffer) => {
    recordChunk(chunk, tracker.stdoutChunks, true);
  };
  const onStderr = (chunk: Buffer) => {
    recordChunk(chunk, tracker.stderrChunks, false);
  };

  child.stdout?.on("data", onStdout);
  child.stderr?.on("data", onStderr);

  return () => {
    child.stdout?.off("data", onStdout);
    child.stderr?.off("data", onStderr);
    child.stdout?.destroy();
    child.stderr?.destroy();
  };
}

/**
 * Prioritizes verified auth prompts and plugin-enforced budgets over process
 * signals so intentional kills never masquerade as external crashes.
 */
function evaluateExitOutcome(
  budget: SubprocessBudget,
  tracker: SubprocessTracker,
  code: number | null,
  signal: NodeJS.Signals | null,
): AgyRunResult | AgyUsageError {
  const output = decodeStreams(tracker);
  if (
    tracker.detectedAuthPrompt ||
    output.stdout.includes(AGY_AUTH_REQUIRED_MARKER)
  ) {
    return output;
  }
  if (tracker.failureReason !== null) {
    return createSubprocessError(budget, tracker.failureReason, code, signal);
  }
  if (code === SUCCESS_EXIT_CODE && signal === null) {
    return output;
  }
  const kind: AgyUsageFailureKind = signal !== null ? "signal" : "exit";
  return createSubprocessError(budget, kind, code, signal);
}

/**
 * Streams `agy -p /usage` via BB's portable process spawner so Windows `.cmd`
 * shims work, signed-out OAuth prompts stop immediately (<100 ms instead of a
 * 20 s hang), and external `SIGTERM` is never confused with our own timeout.
 */
export function runAgyUsage(
  command: string,
  env: NodeJS.ProcessEnv,
  options?: ReadAgyUsageOptions,
): Promise<AgyRunResult> {
  const budget: SubprocessBudget = {
    command,
    startedAt: Date.now(),
    timeoutMs: options?.timeoutMs ?? USAGE_TIMEOUT_MS,
    maxBufferBytes: options?.maxBufferBytes ?? USAGE_MAX_BUFFER_BYTES,
  };
  const childEnv = buildPortableCliEnv(env);
  const args = options?.args ?? AGY_USAGE_ARGS;

  return new Promise((resolve, reject) => {
    const tracker: SubprocessTracker = {
      failureReason: null,
      detectedAuthPrompt: false,
      totalBytes: ZERO_BYTES,
      stdoutChunks: [],
      stderrChunks: [],
    };
    let settled = false;
    let clearStopTimers: (() => void) | undefined;
    let detachStreams: (() => void) | undefined;

    let child: ChildProcess;
    try {
      child = experimental_spawnPortableProcess({
        command,
        args: [...args],
        env: childEnv,
        stdio: [...PORTABLE_STDIO],
      });
    } catch (error) {
      reject(createSpawnFailureError(budget, error));
      return;
    }

    const settle = (outcome: AgyRunResult | AgyUsageError) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutTimer);
      clearStopTimers?.();
      detachStreams?.();
      if (outcome instanceof AgyUsageError) {
        reject(outcome);
      } else {
        resolve(outcome);
      }
    };

    const stopChild = () => {
      detachStreams?.();
      clearStopTimers ??= stopPortableChild(child, () => {
        settle(
          evaluateExitOutcome(
            budget,
            tracker,
            child.exitCode,
            child.signalCode,
          ),
        );
      });
    };

    const timeoutTimer = setTimeout(() => {
      if (
        !settled &&
        tracker.failureReason === null &&
        !tracker.detectedAuthPrompt
      ) {
        tracker.failureReason = "timeout";
        stopChild();
      }
    }, budget.timeoutMs);

    detachStreams = attachStreamTrackers(
      child,
      tracker,
      budget.maxBufferBytes,
      stopChild,
    );
    child.once("error", (error: NodeJS.ErrnoException) => {
      settle(createSpawnFailureError(budget, error));
    });
    child.once("close", (code, signal) => {
      settle(evaluateExitOutcome(budget, tracker, code, signal));
    });
  });
}
