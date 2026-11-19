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
  autoCompactThresholdSchema,
  buildMidTurnYieldPrompt,
  buildPostCompactionResumePrompt,
  type ContextUsageSnapshot,
  contextUsageSchema,
  mergeRecentThreadEvents,
  type RecentThreadActivity,
} from "./auto-compact-policy.ts";
import { awaitWithTimeout } from "./auto-compact-state.ts";
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

  /** Combines plugin disposal with a hard per-request timeout. */
  private requestSignal(timeoutMs: number): AbortSignal {
    return AbortSignal.any([
      this.lifecycleSignal,
      AbortSignal.timeout(timeoutMs),
    ]);
  }

  /** Reads and validates plugin settings, returning null when disabled or malformed. */
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

  /** Steers an active turn with an agent-only pause instruction at a safe step boundary. */
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
    await awaitWithTimeout(
      this.bb.sdk.threads.send({
        threadId,
        mode: STEER_SEND_MODE,
        input: [
          {
            type: TEXT_BLOCK_TYPE,
            text: buildMidTurnYieldPrompt(usage.usedTokens, threshold),
            mentions: [],
            visibility: AGENT_ONLY_VISIBILITY,
          },
        ],
      }),
      this.lifecycleSignal,
      MID_TURN_YIELD_OPERATION,
      AUTO_COMPACT_REQUEST_TIMEOUT_MS,
    );
  }

  /** Starts an agent-only continuation turn gated behind `compactFirst: true`. */
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
    await awaitWithTimeout(
      this.bb.sdk.threads.send({
        threadId,
        mode: START_SEND_MODE,
        compactFirst: true,
        input: [
          {
            type: TEXT_BLOCK_TYPE,
            text: buildPostCompactionResumePrompt(usedTokens, threshold),
            mentions: [],
            visibility: AGENT_ONLY_VISIBILITY,
          },
        ],
      }),
      this.lifecycleSignal,
      TRIGGER_CONTINUE_OPERATION,
      AUTO_COMPACT_REQUEST_TIMEOUT_MS,
    );
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
      signal: this.requestSignal(AUTO_COMPACT_REQUEST_TIMEOUT_MS),
    });
  }

  /** Records when a yielded turn was manually interrupted so resume is skipped. */
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
