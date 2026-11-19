/**
 * Encapsulates bounded BB SDK loopback reads, settings validation, live thread
 * re-verification, and thread-control dispatches (`steer`, `compactFirst`,
 * `compact`) so the lifecycle coordinator stays focused on locking and state.
 */

import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  AUTO_COMPACT_BOUNDARY_EVENT_TYPES,
  AUTO_COMPACT_ITEM_EVENT_TYPES,
  AUTO_COMPACT_USAGE_EVENT_TYPES,
  analyzeRecentThreadEvents,
  mergeRecentThreadEvents,
  type RecentThreadActivity,
} from "./auto-compact-events.ts";
import {
  type AutoCompactThreadCandidate,
  autoCompactThresholdSchema,
  buildMidTurnYieldPrompt,
  buildPostCompactionResumePrompt,
  type ContextUsageSnapshot,
  contextUsageSchema,
} from "./auto-compact-policy.ts";
import {
  AUTO_COMPACT_AGENT_ONLY_VISIBILITY,
  AUTO_COMPACT_BOUNDARY_EVENTS_LIMIT,
  AUTO_COMPACT_COMPACT_TIMEOUT_MS,
  AUTO_COMPACT_ENABLED_DEFAULT,
  AUTO_COMPACT_ENABLED_SETTING_KEY,
  AUTO_COMPACT_ITEM_EVENTS_LIMIT,
  AUTO_COMPACT_READ_TIMEOUT_MS,
  AUTO_COMPACT_REQUEST_TIMEOUT_MS,
  AUTO_COMPACT_TEXT_BLOCK_TYPE,
  AUTO_COMPACT_TOKEN_LOCALE,
  AUTO_COMPACT_TOKEN_THRESHOLD_DEFAULT,
  AUTO_COMPACT_TOKEN_THRESHOLD_MAX,
  AUTO_COMPACT_TOKEN_THRESHOLD_MIN,
  AUTO_COMPACT_TOKEN_THRESHOLD_SETTING_KEY,
  AUTO_COMPACT_USAGE_EVENTS_LIMIT,
  HTTP_NOT_FOUND,
  PROVIDER_ID,
} from "./constants.ts";

const TRIGGER_IDLE_OPERATION = "auto-compact.trigger" as const;
const TRIGGER_CONTINUE_OPERATION = "auto-compact.trigger-and-continue" as const;
const MID_TURN_YIELD_OPERATION = "auto-compact.mid-turn-yield" as const;
const CANCEL_QUEUED_OPERATION = "auto-compact.cancel-queued" as const;
const YIELD_CANCELLED_OPERATION = "auto-compact.yield-cancelled" as const;
const CHECK_OPERATION = "auto-compact.check" as const;
const INVALID_CONFIG_OPERATION = "auto-compact.invalid-config" as const;

const EVENT_ORDER_DESC = "desc" as const;
const STEER_SEND_MODE = "steer" as const;
const START_SEND_MODE = "start" as const;
const DELIVERY_SENT = "sent" as const;

const ENABLED_SETTING_LABEL = "Auto-compact threads" as const;
const ENABLED_SETTING_DESCRIPTION =
  "Automatically compact Antigravity threads when context usage reaches the token threshold and continue active sessions without pausing." as const;
const THRESHOLD_SETTING_LABEL = "Auto-compact token threshold" as const;
const THRESHOLD_SETTING_DESCRIPTION =
  `Token ceiling (${AUTO_COMPACT_TOKEN_THRESHOLD_MIN.toLocaleString(AUTO_COMPACT_TOKEN_LOCALE)} to ` +
  `${AUTO_COMPACT_TOKEN_THRESHOLD_MAX.toLocaleString(AUTO_COMPACT_TOKEN_LOCALE)}) that triggers automatic ` +
  "compaction on Antigravity threads. Active sessions yield at a safe step boundary, compact, and automatically continue running.";

/** Domain error raised when plugin disposal cancels an in-flight RPC wait. */
export class AutoCompactAbortedError extends Error {
  constructor(operation: string) {
    super(`${operation} aborted by plugin disposal`);
    this.name = "AutoCompactAbortedError";
  }
}

/** Domain error raised when an SDK call without native AbortSignal exceeds its bound. */
export class AutoCompactRequestTimeoutError extends Error {
  constructor(operation: string, timeoutMs: number) {
    super(`${operation} exceeded ${timeoutMs}ms timeout`);
    this.name = "AutoCompactRequestTimeoutError";
  }
}

/**
 * Bounds RPCs whose SDK signature lacks a native AbortSignal using a lazy thunk
 * so disposed calls never start and late rejections never crash Node 22.
 */
export async function awaitWithTimeout<T>(
  run: () => Promise<T>,
  lifecycleSignal: AbortSignal,
  operation: string,
  timeoutMs: number,
): Promise<T> {
  if (lifecycleSignal.aborted) {
    throw new AutoCompactAbortedError(operation);
  }
  const task = run();
  // Suppress unhandled rejection if timeout or disposal settles the race first.
  void task.catch(() => {});

  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<never>((_resolve, reject) => {
        onAbort = () => {
          reject(new AutoCompactAbortedError(operation));
        };
        lifecycleSignal.addEventListener("abort", onAbort, { once: true });
        timer = setTimeout(() => {
          reject(new AutoCompactRequestTimeoutError(operation, timeoutMs));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    if (onAbort !== undefined) {
      lifecycleSignal.removeEventListener("abort", onAbort);
    }
  }
}

/** Exposes user-tunable compaction controls in BB settings and `bb plugin config agy`. */
export function defineAutoCompactSettings(bb: BbPluginApi) {
  return bb.settings.define({
    [AUTO_COMPACT_ENABLED_SETTING_KEY]: {
      type: "boolean",
      label: ENABLED_SETTING_LABEL,
      description: ENABLED_SETTING_DESCRIPTION,
      default: AUTO_COMPACT_ENABLED_DEFAULT,
    },
    [AUTO_COMPACT_TOKEN_THRESHOLD_SETTING_KEY]: {
      type: "number",
      label: THRESHOLD_SETTING_LABEL,
      description: THRESHOLD_SETTING_DESCRIPTION,
      experimental_schema: autoCompactThresholdSchema,
      default: AUTO_COMPACT_TOKEN_THRESHOLD_DEFAULT,
    },
  });
}

export type AutoCompactSettingsHandle = ReturnType<
  typeof defineAutoCompactSettings
>;

/** Distinguishes deleted threads (404) from transient RPC or network errors. */
function isNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "status" in error &&
    error.status === HTTP_NOT_FOUND
  );
}

/**
 * Wraps BB SDK thread reads and compaction commands with lifecycle cancellation,
 * per-call deadlines, plugin attribution, and single-boundary structured logging.
 */
export class AutoCompactSdkClient {
  private readonly bb: BbPluginApi;
  private readonly settings: AutoCompactSettingsHandle;
  private readonly lifecycleSignal: AbortSignal;

  // Explicit fields rather than parameter properties keep Node native type
  // stripping compatible when scripts import server modules directly.
  constructor(
    bb: BbPluginApi,
    settings: AutoCompactSettingsHandle,
    lifecycleSignal: AbortSignal,
  ) {
    this.bb = bb;
    this.settings = settings;
    this.lifecycleSignal = lifecycleSignal;
  }

  /** Combines plugin disposal with a hard per-request timeout. */
  private requestSignal(timeoutMs: number): AbortSignal {
    return AbortSignal.any([
      this.lifecycleSignal,
      AbortSignal.timeout(timeoutMs),
    ]);
  }

  /** Removes a queued control prompt so deferred waits cannot hijack later turns. */
  private async cancelQueuedControlMessage(
    threadId: string,
    queuedMessageId: string,
    sourceOperation: string,
  ): Promise<void> {
    try {
      await awaitWithTimeout(
        () =>
          this.bb.sdk.threads.queuedMessages.delete({
            threadId,
            queuedMessageId,
          }),
        this.lifecycleSignal,
        CANCEL_QUEUED_OPERATION,
        AUTO_COMPACT_READ_TIMEOUT_MS,
      );
    } catch (error) {
      if (this.lifecycleSignal.aborted) {
        return;
      }
      this.bb.log.warn(
        `op=${CANCEL_QUEUED_OPERATION} sourceOp=${sourceOperation} ` +
          `threadId=${threadId} queuedMessageId=${queuedMessageId} ` +
          `cause=${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Sends one plugin-attributed agent-only control message with bounded waiting
   * so callers can distinguish immediate steering from queued continuation turns.
   */
  private async sendAgentOnlyMessage(options: {
    readonly threadId: string;
    readonly mode: typeof STEER_SEND_MODE | typeof START_SEND_MODE;
    readonly text: string;
    readonly operation: string;
    readonly timeoutMs: number;
    readonly compactFirst?: true;
  }) {
    return await awaitWithTimeout(
      () =>
        this.bb.sdk.threads.send({
          threadId: options.threadId,
          mode: options.mode,
          originPluginId: this.bb.pluginId,
          ...(options.compactFirst === true ? { compactFirst: true } : {}),
          input: [
            {
              type: AUTO_COMPACT_TEXT_BLOCK_TYPE,
              text: options.text,
              mentions: [],
              visibility: AUTO_COMPACT_AGENT_ONLY_VISIBILITY,
            },
          ],
        }),
      this.lifecycleSignal,
      options.operation,
      options.timeoutMs,
    );
  }

  /** Validates plugin settings at the boundary, returning null when disabled or malformed. */
  async readActiveThreshold(threadId: string): Promise<number | null> {
    const config = await this.settings.get();
    if (this.lifecycleSignal.aborted || !config.autoCompactEnabled) {
      return null;
    }
    const parsed = autoCompactThresholdSchema.safeParse(
      config.autoCompactTokenThreshold,
    );
    if (!parsed.success) {
      this.bb.log.warn(
        `op=${INVALID_CONFIG_OPERATION} threadId=${threadId} ` +
          `threshold=${String(config.autoCompactTokenThreshold)}`,
      );
      return null;
    }
    return parsed.data;
  }

  /** Re-reads the live thread row so TOCTOU state changes and deletions fail closed. */
  async readLiveThread(
    threadId: string,
  ): Promise<AutoCompactThreadCandidate | null> {
    try {
      return await this.bb.sdk.threads.get({
        threadId,
        signal: this.requestSignal(AUTO_COMPACT_READ_TIMEOUT_MS),
      });
    } catch (error) {
      if (isNotFoundError(error)) {
        return null;
      }
      throw error;
    }
  }

  /** Reads and validates the thread's latest persisted context window usage. */
  async readContextUsage(
    threadId: string,
  ): Promise<ContextUsageSnapshot | null> {
    const response = await this.bb.sdk.threads.context({
      threadId,
      signal: this.requestSignal(AUTO_COMPACT_READ_TIMEOUT_MS),
    });
    if (response.usage === null) {
      return null;
    }
    const parsed = contextUsageSchema.safeParse(response.usage);
    return parsed.success ? parsed.data : null;
  }

  /**
   * Queries disjoint boundary, tool-item, and usage event windows in parallel
   * so long multi-tool turns keep `turn/started` and usage watermarks visible.
   */
  async readRecentActivity(threadId: string): Promise<RecentThreadActivity> {
    const signal = this.requestSignal(AUTO_COMPACT_READ_TIMEOUT_MS);
    const [boundaryEvents, itemEvents, usageEvents] = await Promise.all([
      this.bb.sdk.threads.events.list({
        threadId,
        order: EVENT_ORDER_DESC,
        limit: AUTO_COMPACT_BOUNDARY_EVENTS_LIMIT,
        types: AUTO_COMPACT_BOUNDARY_EVENT_TYPES,
        signal,
      }),
      this.bb.sdk.threads.events.list({
        threadId,
        order: EVENT_ORDER_DESC,
        limit: AUTO_COMPACT_ITEM_EVENTS_LIMIT,
        types: AUTO_COMPACT_ITEM_EVENT_TYPES,
        signal,
      }),
      this.bb.sdk.threads.events.list({
        threadId,
        order: EVENT_ORDER_DESC,
        limit: AUTO_COMPACT_USAGE_EVENTS_LIMIT,
        types: AUTO_COMPACT_USAGE_EVENT_TYPES,
        signal,
      }),
    ]);
    return analyzeRecentThreadEvents(
      mergeRecentThreadEvents(boundaryEvents, itemEvents, usageEvents),
    );
  }

  /**
   * Steers an active turn with an agent-only pause instruction; cancels and
   * fails closed if BB queues the steer so an idle thread is never paused later.
   */
  async sendMidTurnYield(
    threadId: string,
    turnSeq: number,
    usage: ContextUsageSnapshot,
    threshold: number,
  ): Promise<boolean> {
    this.bb.log.info(
      `op=${MID_TURN_YIELD_OPERATION} threadId=${threadId} providerId=${PROVIDER_ID} ` +
        `turnSeq=${turnSeq} usedTokens=${usage.usedTokens} ` +
        `threshold=${threshold} modelContextWindow=${usage.modelContextWindow}`,
    );
    const response = await this.sendAgentOnlyMessage({
      threadId,
      mode: STEER_SEND_MODE,
      text: buildMidTurnYieldPrompt(usage.usedTokens, threshold),
      operation: MID_TURN_YIELD_OPERATION,
      timeoutMs: AUTO_COMPACT_REQUEST_TIMEOUT_MS,
    });
    if (response.delivery === DELIVERY_SENT) {
      return true;
    }
    this.bb.log.warn(
      `op=${MID_TURN_YIELD_OPERATION} threadId=${threadId} ` +
        `providerId=${PROVIDER_ID} delivery=${response.delivery} ` +
        `queuedMessageId=${response.queuedMessage.id}`,
    );
    await this.cancelQueuedControlMessage(
      threadId,
      response.queuedMessage.id,
      MID_TURN_YIELD_OPERATION,
    );
    return false;
  }

  /**
   * Starts an agent-only continuation turn behind `compactFirst: true`; BB
   * intentionally returns `delivery: "queued"` while compaction runs first.
   */
  async sendCompactAndContinue(
    threadId: string,
    usage: ContextUsageSnapshot,
    threshold: number,
    consecutive: number,
  ): Promise<void> {
    this.bb.log.info(
      `op=${TRIGGER_CONTINUE_OPERATION} threadId=${threadId} providerId=${PROVIDER_ID} ` +
        `usedTokens=${usage.usedTokens} threshold=${threshold} ` +
        `modelContextWindow=${usage.modelContextWindow} consecutive=${consecutive}`,
    );
    await this.sendAgentOnlyMessage({
      threadId,
      mode: START_SEND_MODE,
      compactFirst: true,
      text: buildPostCompactionResumePrompt(usage.usedTokens, threshold),
      operation: TRIGGER_CONTINUE_OPERATION,
      timeoutMs: AUTO_COMPACT_COMPACT_TIMEOUT_MS,
    });
  }

  /** Triggers in-place compaction on an idle thread without restarting `agy`. */
  async sendIdleCompact(
    threadId: string,
    turnSeq: number,
    usage: ContextUsageSnapshot,
    threshold: number,
  ): Promise<void> {
    this.bb.log.info(
      `op=${TRIGGER_IDLE_OPERATION} threadId=${threadId} providerId=${PROVIDER_ID} ` +
        `turnSeq=${turnSeq} usedTokens=${usage.usedTokens} ` +
        `threshold=${threshold} modelContextWindow=${usage.modelContextWindow}`,
    );
    await this.bb.sdk.threads.compact({
      threadId,
      signal: this.requestSignal(AUTO_COMPACT_COMPACT_TIMEOUT_MS),
    });
  }

  /** Records when a yielded turn was cancelled or superseded so resume is skipped. */
  logYieldCancelled(threadId: string): void {
    this.bb.log.info(
      `op=${YIELD_CANCELLED_OPERATION} threadId=${threadId} providerId=${PROVIDER_ID}`,
    );
  }

  /** Logs operational failures once at the handler boundary with diagnostic metadata. */
  logCheckError(threadId: string, startedAt: number, error: unknown): void {
    if (this.lifecycleSignal.aborted) {
      return;
    }
    const elapsedMs = Date.now() - startedAt;
    this.bb.log.warn(
      `op=${CHECK_OPERATION} threadId=${threadId} providerId=${PROVIDER_ID} ` +
        `elapsedMs=${elapsedMs} ` +
        `cause=${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
