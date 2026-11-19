/**
 * Encapsulates bounded BB SDK loopback reads, settings validation, and
 * thread-control dispatches (`steer`, `compactFirst`, `compact`) so the
 * lifecycle coordinator stays focused on per-thread locking and phase state.
 */

import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  AUTO_COMPACT_BOUNDARY_EVENT_TYPES,
  AUTO_COMPACT_ITEM_EVENT_TYPES,
  analyzeRecentThreadEvents,
  mergeRecentThreadEvents,
  type RecentThreadActivity,
} from "./auto-compact-events.ts";
import {
  autoCompactThresholdSchema,
  buildMidTurnYieldPrompt,
  buildPostCompactionResumePrompt,
  type ContextUsageSnapshot,
  contextUsageSchema,
} from "./auto-compact-policy.ts";
import {
  AUTO_COMPACT_BOUNDARY_EVENTS_LIMIT,
  AUTO_COMPACT_ENABLED_DEFAULT,
  AUTO_COMPACT_ENABLED_SETTING_KEY,
  AUTO_COMPACT_ITEM_EVENTS_LIMIT,
  AUTO_COMPACT_READ_TIMEOUT_MS,
  AUTO_COMPACT_REQUEST_TIMEOUT_MS,
  AUTO_COMPACT_TOKEN_THRESHOLD_DEFAULT,
  AUTO_COMPACT_TOKEN_THRESHOLD_SETTING_KEY,
  PROVIDER_ID,
} from "./constants.ts";

const ZERO_TIMEOUT_MS = 0 as const;
const TRIGGER_IDLE_OPERATION = "auto-compact.trigger" as const;
const TRIGGER_CONTINUE_OPERATION = "auto-compact.trigger-and-continue" as const;
const MID_TURN_YIELD_OPERATION = "auto-compact.mid-turn-yield" as const;
const YIELD_CANCELLED_OPERATION = "auto-compact.yield-cancelled" as const;
const CHECK_OPERATION = "auto-compact.check" as const;
const INVALID_CONFIG_OPERATION = "auto-compact.invalid-config" as const;

const EVENT_ORDER_DESC = "desc" as const;
const AGENT_ONLY_VISIBILITY = "agent-only" as const;
const TEXT_BLOCK_TYPE = "text" as const;
const STEER_SEND_MODE = "steer" as const;
const START_SEND_MODE = "start" as const;

const ENABLED_SETTING_LABEL = "Auto-compact threads" as const;
const ENABLED_SETTING_DESCRIPTION =
  "Automatically compact Antigravity threads when context usage reaches the token threshold and continue active sessions without pausing." as const;
const THRESHOLD_SETTING_LABEL = "Auto-compact token threshold" as const;
const THRESHOLD_SETTING_DESCRIPTION =
  "Token ceiling (1,000 to 2,000,000) that triggers automatic compaction on Antigravity threads. Active sessions yield at a safe step boundary, compact, and automatically continue running." as const;

/** Validated active configuration snapshot when auto-compaction is enabled. */
export interface ValidatedAutoCompactConfig {
  readonly enabled: true;
  readonly threshold: number;
}

/** Domain error raised when an SDK call without native AbortSignal exceeds its bound. */
export class AutoCompactRequestTimeoutError extends Error {
  constructor(operation: string, timeoutMs: number) {
    super(`${operation} exceeded ${timeoutMs}ms timeout`);
    this.name = "AutoCompactRequestTimeoutError";
  }
}

/** Bounds RPCs whose SDK signature lacks a native AbortSignal so per-thread locks always release. */
async function awaitWithTimeout<T>(
  promise: Promise<T>,
  lifecycleSignal: AbortSignal,
  operation: string,
  timeoutMs: number,
): Promise<T> {
  if (lifecycleSignal.aborted) {
    throw new AutoCompactRequestTimeoutError(operation, ZERO_TIMEOUT_MS);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        onAbort = () => {
          reject(
            new AutoCompactRequestTimeoutError(operation, ZERO_TIMEOUT_MS),
          );
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

/**
 * Wraps BB SDK thread reads and compaction commands with lifecycle cancellation,
 * per-call deadlines, and structured single-boundary logging.
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

  /** Ensures neither hung loopback RPCs nor plugin unload can leak background promises. */
  private requestSignal(timeoutMs: number): AbortSignal {
    return AbortSignal.any([
      this.lifecycleSignal,
      AbortSignal.timeout(timeoutMs),
    ]);
  }

  /** Rejects disabled or corrupted persisted thresholds at the settings boundary. */
  async readValidatedConfig(
    threadId: string,
  ): Promise<ValidatedAutoCompactConfig | null> {
    const config = await this.settings.get();
    if (this.lifecycleSignal.aborted || !config.autoCompactEnabled) {
      return null;
    }
    const parsedThreshold = autoCompactThresholdSchema.safeParse(
      config.autoCompactTokenThreshold,
    );
    if (!parsedThreshold.success) {
      this.bb.log.warn(
        `op=${INVALID_CONFIG_OPERATION} threadId=${threadId} ` +
          `threshold=${String(config.autoCompactTokenThreshold)}`,
      );
      return null;
    }
    return { enabled: true, threshold: parsedThreshold.data };
  }

  /** Validates untrusted context-usage DTOs before comparing against user thresholds. */
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
   * Reads boundary and item event windows in parallel so long multi-tool turns
   * keep `turn/started` visible while still detecting currently running tools.
   */
  async readRecentActivity(threadId: string): Promise<RecentThreadActivity> {
    const signal = this.requestSignal(AUTO_COMPACT_READ_TIMEOUT_MS);
    const [boundaryEvents, itemEvents] = await Promise.all([
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
    ]);
    return analyzeRecentThreadEvents(
      mergeRecentThreadEvents(boundaryEvents, itemEvents),
    );
  }

  /** Centralizes agent-only prompt dispatch so yield and continuation share timeout bounds. */
  private async sendAgentPrompt(
    threadId: string,
    operation: string,
    options: {
      readonly mode: typeof STEER_SEND_MODE | typeof START_SEND_MODE;
      readonly compactFirst?: boolean;
      readonly text: string;
    },
  ): Promise<void> {
    await awaitWithTimeout(
      this.bb.sdk.threads.send({
        threadId,
        mode: options.mode,
        ...(options.compactFirst === true ? { compactFirst: true } : {}),
        input: [
          {
            type: TEXT_BLOCK_TYPE,
            text: options.text,
            mentions: [],
            visibility: AGENT_ONLY_VISIBILITY,
          },
        ],
      }),
      this.lifecycleSignal,
      operation,
      AUTO_COMPACT_REQUEST_TIMEOUT_MS,
    );
  }

  /** Yields an active turn at a tool-free step boundary without killing the ACP process. */
  async sendMidTurnYield(
    threadId: string,
    turnSeq: number,
    usage: ContextUsageSnapshot,
    threshold: number,
  ): Promise<void> {
    this.bb.log.info(
      `op=${MID_TURN_YIELD_OPERATION} threadId=${threadId} providerId=${PROVIDER_ID} ` +
        `turnSeq=${turnSeq} usedTokens=${usage.usedTokens} ` +
        `threshold=${threshold} modelContextWindow=${usage.modelContextWindow}`,
    );
    await this.sendAgentPrompt(threadId, MID_TURN_YIELD_OPERATION, {
      mode: STEER_SEND_MODE,
      text: buildMidTurnYieldPrompt(usage.usedTokens, threshold),
    });
  }

  /** Chains `compactFirst: true` with an agent-only turn so yielded sessions resume seamlessly. */
  async sendCompactAndContinue(
    threadId: string,
    usedTokens: number,
    threshold: number,
    contextWindow: number,
    consecutive: number,
  ): Promise<void> {
    this.bb.log.info(
      `op=${TRIGGER_CONTINUE_OPERATION} threadId=${threadId} providerId=${PROVIDER_ID} ` +
        `usedTokens=${usedTokens} threshold=${threshold} ` +
        `modelContextWindow=${contextWindow} consecutive=${consecutive}`,
    );
    await this.sendAgentPrompt(threadId, TRIGGER_CONTINUE_OPERATION, {
      mode: START_SEND_MODE,
      compactFirst: true,
      text: buildPostCompactionResumePrompt(usedTokens, threshold),
    });
  }

  /** Compacts idle threads in place so live background subagents keep running. */
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
      signal: this.requestSignal(AUTO_COMPACT_REQUEST_TIMEOUT_MS),
    });
  }

  /** Leaves an audit trail when a manual user Stop cancels automatic post-yield continuation. */
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
