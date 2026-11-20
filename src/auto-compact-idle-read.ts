/** Bounds read-only idle reconciliation so a transient RPC failure cannot consume its only notification. */
import { setTimeout as delay } from "node:timers/promises";
import type { AutoCompactorClient } from "./auto-compact.ts";
import {
  AutoCompactRequestTimeoutError,
  awaitWithTimeout,
} from "./auto-compact-client.ts";
import { AUTO_COMPACT_READ_TIMEOUT_MS } from "./constants.ts";

const FIRST_ATTEMPT = 1;
const MAX_ATTEMPTS = 3;
const INITIAL_BACKOFF_MS = 100;
const BACKOFF_FACTOR = 2;
const SETTINGS_READ = "auto-compact.read-settings";
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const RETRYABLE_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
]);
const TIMEOUT_NAME = "TimeoutError";

/** Restricts retries to explicit transient transport failures. */
function isTransientReadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (
    error instanceof AutoCompactRequestTimeoutError ||
    error.name === TIMEOUT_NAME
  )
    return true;
  if ("status" in error && typeof error.status === "number")
    return RETRYABLE_STATUSES.has(error.status);
  const reason = error.cause instanceof Error ? error.cause : error;
  return (
    "code" in reason &&
    typeof reason.code === "string" &&
    RETRYABLE_CODES.has(reason.code)
  );
}

/** Keeps the original cause available while identifying the next read attempt in the operation log. */
class IdleReadRetry extends Error {
  constructor(attempt: number, cause: unknown) {
    super(
      `retrying idle reads after attempt ${attempt}: ${cause instanceof Error ? cause.name : "transport failure"}`,
      { cause },
    );
  }
}

/** A missing usage reading permits a plain continuation only after fresh history and eligibility checks. */
export async function readIdleContext(
  client: AutoCompactorClient,
  threadId: string,
  signal: AbortSignal,
) {
  const startedAt = Date.now();
  for (let attempt = FIRST_ATTEMPT; ; attempt++) {
    signal.throwIfAborted();
    try {
      const threshold = await awaitWithTimeout(
        () => client.readActiveThreshold(threadId),
        signal,
        SETTINGS_READ,
        AUTO_COMPACT_READ_TIMEOUT_MS,
      );
      const usage =
        threshold === null
          ? null
          : await client.readContextUsage(threadId).catch((error: unknown) => {
              if (
                signal.aborted ||
                (attempt < MAX_ATTEMPTS && isTransientReadError(error))
              )
                throw error;
              client.logCheckError(threadId, startedAt, error);
              return null;
            });
      // Recheck stops and queued messages after optional usage reads and backoff.
      const [activity, liveThread] = await Promise.all([
        client.readRecentActivity(threadId),
        client.readLiveThread(threadId),
      ]);
      return { threshold, usage, activity, liveThread };
    } catch (error) {
      if (
        signal.aborted ||
        attempt >= MAX_ATTEMPTS ||
        !isTransientReadError(error)
      )
        throw error;
      client.logCheckError(
        threadId,
        startedAt,
        new IdleReadRetry(attempt, error),
      );
      const backoff =
        INITIAL_BACKOFF_MS * BACKOFF_FACTOR ** (attempt - FIRST_ATTEMPT);
      await delay(backoff + Math.random() * backoff, undefined, { signal });
    }
  }
}
