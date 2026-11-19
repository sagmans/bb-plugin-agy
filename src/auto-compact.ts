/**
 * Enforces a configurable token cap on Antigravity (`agy`) threads because the
 * `agy` CLI exposes no native setting to lower its backend compaction ceiling.
 * Compacts active sessions mid-turn and immediately continues them via
 * `compactFirst` + agent-only continuation so work never stops or pauses, and
 * compacts idle threads between turns without restarting the ACP process.
 */

import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  AUTO_COMPACT_BOUNDARY_EVENT_TYPES,
  AUTO_COMPACT_ITEM_EVENT_TYPES,
  type AutoCompactThreadCandidate,
  analyzeRecentThreadEvents,
  autoCompactThresholdSchema,
  buildMidTurnYieldPrompt,
  buildPostCompactionResumePrompt,
  type ContextUsageSnapshot,
  canResumeAfterMidTurnYield,
  contextUsageSchema,
  evaluateIdleAutoCompactDecision,
  evaluateMidTurnAutoCompactDecision,
  isEligibleActiveAutoCompactThread,
  isEligibleIdleAutoCompactThread,
  mergeRecentThreadEvents,
  type RecentThreadActivity,
} from "./auto-compact-policy.ts";
import {
  AUTO_COMPACT_BOUNDARY_EVENTS_LIMIT,
  AUTO_COMPACT_ENABLED_DEFAULT,
  AUTO_COMPACT_ENABLED_SETTING_KEY,
  AUTO_COMPACT_ITEM_EVENTS_LIMIT,
  AUTO_COMPACT_MAX_TRACKED_THREADS,
  AUTO_COMPACT_PHASE_TIMEOUT_MS,
  AUTO_COMPACT_READ_TIMEOUT_MS,
  AUTO_COMPACT_REQUEST_TIMEOUT_MS,
  AUTO_COMPACT_TOKEN_THRESHOLD_DEFAULT,
  AUTO_COMPACT_TOKEN_THRESHOLD_SETTING_KEY,
  AUTO_COMPACT_YIELD_TIMEOUT_MS,
  PROVIDER_ID,
} from "./constants.ts";

export {
  type AutoCompactDecision,
  type AutoCompactThreadCandidate,
  analyzeRecentThreadEvents,
  autoCompactThresholdSchema,
  buildMidTurnYieldPrompt,
  buildPostCompactionResumePrompt,
  canResumeAfterMidTurnYield,
  evaluateIdleAutoCompactDecision,
  evaluateMidTurnAutoCompactDecision,
  isEligibleActiveAutoCompactThread,
  isEligibleIdleAutoCompactThread,
  type RecentThreadActivity,
  type RecentThreadEvent,
} from "./auto-compact-policy.ts";

const TRIGGER_IDLE_OPERATION = "auto-compact.trigger" as const;
const TRIGGER_CONTINUE_OPERATION = "auto-compact.trigger-and-continue" as const;
const MID_TURN_YIELD_OPERATION = "auto-compact.mid-turn-yield" as const;
const YIELD_CANCELLED_OPERATION = "auto-compact.yield-cancelled" as const;
const CHECK_OPERATION = "auto-compact.check" as const;
const INVALID_CONFIG_OPERATION = "auto-compact.invalid-config" as const;

const EVENT_ORDER_DESC = "desc" as const;
const ZERO_COUNT = 0 as const;
const ONE_COUNT = 1 as const;
const AGENT_ONLY_VISIBILITY = "agent-only" as const;
const TEXT_BLOCK_TYPE = "text" as const;
const STEER_SEND_MODE = "steer" as const;
const START_SEND_MODE = "start" as const;

const IDLE_PHASE = "idle" as const;
const YIELDING_PHASE = "yielding-mid-turn" as const;
const COMPACTING_IDLE_PHASE = "compacting-idle" as const;
const COMPACTING_RESUME_PHASE = "compacting-resume" as const;

/** Domain error raised when an SDK call without native AbortSignal exceeds its bound. */
class AutoCompactRequestTimeoutError extends Error {
  constructor(operation: string, timeoutMs: number) {
    super(`${operation} exceeded ${timeoutMs}ms timeout`);
    this.name = "AutoCompactRequestTimeoutError";
  }
}

/** Bounds RPCs whose SDK signature lacks a native AbortSignal so locks always release. */
async function awaitWithTimeout<T>(
  promise: Promise<T>,
  lifecycleSignal: AbortSignal,
  operation: string,
  timeoutMs: number,
): Promise<T> {
  if (lifecycleSignal.aborted) {
    throw new AutoCompactRequestTimeoutError(operation, ZERO_COUNT);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        onAbort = () => {
          reject(new AutoCompactRequestTimeoutError(operation, ZERO_COUNT));
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

const ENABLED_SETTING_LABEL = "Auto-compact threads" as const;
const ENABLED_SETTING_DESCRIPTION =
  "Automatically compact Antigravity threads when context usage reaches the token threshold and continue active sessions without pausing." as const;
const THRESHOLD_SETTING_LABEL = "Auto-compact token threshold" as const;
const THRESHOLD_SETTING_DESCRIPTION =
  "Token ceiling (1,000 to 2,000,000) that triggers automatic compaction on Antigravity threads. Active sessions yield at a safe step boundary, compact, and automatically continue running." as const;

type AutoCompactPhase =
  | typeof IDLE_PHASE
  | typeof YIELDING_PHASE
  | typeof COMPACTING_IDLE_PHASE
  | typeof COMPACTING_RESUME_PHASE;

interface ThreadAutoCompactState {
  phase: AutoCompactPhase;
  phaseUpdatedAtMs: number;
  awaitingDropOrNewTurn: boolean;
  lastCompactionSeq: number;
  lastUserRequestSeq: number;
  lastAttemptedTurnSeq: number | undefined;
  consecutiveAutoCompactions: number;
  yieldSteerSeq: number;
  yieldUsage: ContextUsageSnapshot | null;
  yieldThreshold: number | null;
}

interface ValidatedConfig {
  readonly enabled: true;
  readonly threshold: number;
}

/** Defines plugin settings exposed in Settings -> Installed plugins and `bb plugin config agy`. */
function defineAutoCompactSettings(bb: BbPluginApi) {
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

type AutoCompactSettingsHandle = ReturnType<typeof defineAutoCompactSettings>;

/** Creates an initialized per-thread tracker entry with clean idle defaults. */
function createInitialThreadState(now: number): ThreadAutoCompactState {
  return {
    phase: IDLE_PHASE,
    phaseUpdatedAtMs: now,
    awaitingDropOrNewTurn: false,
    lastCompactionSeq: ZERO_COUNT,
    lastUserRequestSeq: ZERO_COUNT,
    lastAttemptedTurnSeq: undefined,
    consecutiveAutoCompactions: ZERO_COUNT,
    yieldSteerSeq: ZERO_COUNT,
    yieldUsage: null,
    yieldThreshold: null,
  };
}

/** Resets transient yield metadata when leaving `yielding-mid-turn`. */
function resetToIdlePhase(state: ThreadAutoCompactState, now: number): void {
  state.phase = IDLE_PHASE;
  state.phaseUpdatedAtMs = now;
  state.yieldUsage = null;
  state.yieldThreshold = null;
}

/** Recovers stuck phases if an expected lifecycle transition never arrives. */
function recoverStalePhase(state: ThreadAutoCompactState, now: number): void {
  if (
    state.phase === YIELDING_PHASE &&
    now - state.phaseUpdatedAtMs > AUTO_COMPACT_YIELD_TIMEOUT_MS
  ) {
    resetToIdlePhase(state, now);
    return;
  }
  if (
    (state.phase === COMPACTING_IDLE_PHASE ||
      state.phase === COMPACTING_RESUME_PHASE) &&
    now - state.phaseUpdatedAtMs > AUTO_COMPACT_PHASE_TIMEOUT_MS
  ) {
    resetToIdlePhase(state, now);
  }
}

/** Transitions compaction phases back to `idle` once the expected follow-on event lands. */
function settleCompletedCompactionPhase(
  state: ThreadAutoCompactState,
  activity: RecentThreadActivity,
  now: number,
): void {
  if (activity.isCompactionTurn) {
    return;
  }
  const resumeTurnStarted =
    state.phase === COMPACTING_RESUME_PHASE &&
    activity.latestTurnStartedSeq !== null &&
    activity.latestTurnStartedSeq > state.lastCompactionSeq;
  const idleCompactionSettled =
    state.phase === COMPACTING_IDLE_PHASE &&
    activity.latestCompactionBoundarySeq >= state.lastCompactionSeq &&
    activity.latestCompactionBoundarySeq > ZERO_COUNT;
  if (resumeTurnStarted || idleCompactionSettled) {
    resetToIdlePhase(state, now);
  }
}

/**
 * Reconciles in-memory phase and loop-prevention flags against the persisted
 * event log so post-compaction drops and new user prompts reliably re-arm.
 */
function syncStateWithActivity(
  state: ThreadAutoCompactState,
  activity: RecentThreadActivity,
  usedTokens: number | null,
  threshold: number,
  now: number,
): void {
  if (activity.latestCompactionBoundarySeq > state.lastCompactionSeq) {
    state.lastCompactionSeq = activity.latestCompactionBoundarySeq;
  }
  if (activity.latestUserRequestSeq > state.lastUserRequestSeq) {
    state.lastUserRequestSeq = activity.latestUserRequestSeq;
    state.awaitingDropOrNewTurn = false;
    state.consecutiveAutoCompactions = ZERO_COUNT;
  }
  if (
    state.awaitingDropOrNewTurn &&
    usedTokens !== null &&
    usedTokens < threshold &&
    activity.latestUsageEventSeq > state.lastCompactionSeq
  ) {
    state.awaitingDropOrNewTurn = false;
  }
  settleCompletedCompactionPhase(state, activity, now);
}

/**
 * Coordinates per-thread deduplication, safe mid-turn yield + continuation,
 * idle compaction, and bounded SDK calls across `agy` threads.
 */
class AutoCompactor {
  private disposed = false;
  private readonly lifecycle = new AbortController();
  private readonly inFlight = new Set<string>();
  private readonly pendingIdle = new Map<string, AutoCompactThreadCandidate>();
  private readonly threadStates = new Map<string, ThreadAutoCompactState>();
  private readonly bb: BbPluginApi;
  private readonly settings: AutoCompactSettingsHandle;

  // Explicit fields rather than parameter properties so Node type stripping
  // stays compatible across scripts and runtime loads.
  constructor(bb: BbPluginApi, settings: AutoCompactSettingsHandle) {
    this.bb = bb;
    this.settings = settings;
  }

  /** Aborts in-flight SDK calls and releases per-thread tracking on plugin unload. */
  dispose(): void {
    this.disposed = true;
    this.lifecycle.abort();
    this.inFlight.clear();
    this.pendingIdle.clear();
    this.threadStates.clear();
  }

  /** Drops per-thread tracking once a thread is archived or deleted. */
  forgetThread(threadId: string): void {
    this.pendingIdle.delete(threadId);
    this.threadStates.delete(threadId);
  }

  /** Clears transient compaction phases when a turn fails so recovery never stalls. */
  handleThreadFailed(threadId: string): void {
    const state = this.threadStates.get(threadId);
    if (state !== undefined && state.phase !== IDLE_PHASE) {
      resetToIdlePhase(state, Date.now());
    }
  }

  /** Evaluates active-turn events for safe mid-turn yield and seamless continuation. */
  async handleThreadEvents(thread: AutoCompactThreadCandidate): Promise<void> {
    if (
      this.disposed ||
      !isEligibleActiveAutoCompactThread(thread) ||
      this.inFlight.has(thread.id)
    ) {
      return;
    }
    this.inFlight.add(thread.id);
    try {
      await this.evaluateActiveThread(thread.id);
    } finally {
      this.inFlight.delete(thread.id);
      this.flushPendingIdle(thread.id);
    }
  }

  /** Evaluates an idle transition: either compacts+continues a yielded turn or compacts idle state. */
  async handleThreadIdle(thread: AutoCompactThreadCandidate): Promise<void> {
    if (this.disposed || !isEligibleIdleAutoCompactThread(thread)) {
      return;
    }
    if (this.inFlight.has(thread.id)) {
      this.pendingIdle.set(thread.id, thread);
      return;
    }
    this.inFlight.add(thread.id);
    try {
      await this.evaluateIdleThread(thread.id);
    } finally {
      this.inFlight.delete(thread.id);
      this.flushPendingIdle(thread.id);
    }
  }

  /** Replays an idle notification that arrived while an active check held the per-thread lock. */
  private flushPendingIdle(threadId: string): void {
    const deferred = this.pendingIdle.get(threadId);
    if (deferred === undefined || this.disposed) {
      return;
    }
    this.pendingIdle.delete(threadId);
    void this.handleThreadIdle(deferred);
  }

  /** Returns or creates bounded LRU state for a tracked thread. */
  private ensureThreadState(threadId: string): ThreadAutoCompactState {
    const now = Date.now();
    const existing = this.threadStates.get(threadId);
    if (existing !== undefined) {
      this.threadStates.delete(threadId);
      this.threadStates.set(threadId, existing);
      recoverStalePhase(existing, now);
      return existing;
    }
    if (this.threadStates.size >= AUTO_COMPACT_MAX_TRACKED_THREADS) {
      const oldest = this.threadStates.keys().next().value;
      if (oldest !== undefined) {
        this.threadStates.delete(oldest);
      }
    }
    const created = createInitialThreadState(now);
    this.threadStates.set(threadId, created);
    return created;
  }

  /** Combines plugin lifecycle cancellation with a hard per-request timeout. */
  private requestSignal(timeoutMs: number): AbortSignal {
    return AbortSignal.any([
      this.lifecycle.signal,
      AbortSignal.timeout(timeoutMs),
    ]);
  }

  /** Reads and validates plugin settings, returning null when disabled or malformed. */
  private async readValidatedConfig(
    threadId: string,
  ): Promise<ValidatedConfig | null> {
    const config = await this.settings.get();
    if (this.disposed || !config.autoCompactEnabled) {
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
  private async readContextUsage(
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
  private async readRecentActivity(
    threadId: string,
  ): Promise<RecentThreadActivity> {
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

  /** Logs operational failures once at the handler boundary with diagnostic metadata. */
  private logCheckError(
    threadId: string,
    startedAt: number,
    error: unknown,
  ): void {
    if (this.disposed) {
      return;
    }
    const elapsedMs = Date.now() - startedAt;
    this.bb.log.warn(
      `op=${CHECK_OPERATION} threadId=${threadId} providerId=${PROVIDER_ID} ` +
        `elapsedMs=${elapsedMs} ` +
        `cause=${error instanceof Error ? error.message : String(error)}`,
    );
  }

  /**
   * Loads context usage and recent activity, syncing tracked state while
   * skipping event-log queries on the common below-threshold fast path.
   */
  private async prepareCompactionContext(
    threadId: string,
    threshold: number,
  ): Promise<{
    readonly state: ThreadAutoCompactState;
    readonly activity: RecentThreadActivity;
    readonly usage: ContextUsageSnapshot;
  } | null> {
    const existing = this.threadStates.get(threadId);
    const usage = await this.readContextUsage(threadId);
    if (this.disposed) {
      return null;
    }
    const needsStateSync =
      existing !== undefined &&
      (existing.awaitingDropOrNewTurn || existing.phase !== IDLE_PHASE);
    if (!needsStateSync && (usage === null || usage.usedTokens < threshold)) {
      return null;
    }
    const activity = await this.readRecentActivity(threadId);
    if (this.disposed) {
      return null;
    }
    const state = this.ensureThreadState(threadId);
    syncStateWithActivity(
      state,
      activity,
      usage?.usedTokens ?? null,
      threshold,
      Date.now(),
    );
    if (state.phase !== IDLE_PHASE || usage === null) {
      return null;
    }
    return { state, activity, usage };
  }

  /** Checks an active turn and steers a clean step-boundary yield once threshold is crossed. */
  private async evaluateActiveThread(threadId: string): Promise<void> {
    const startedAt = Date.now();
    try {
      const config = await this.readValidatedConfig(threadId);
      if (config === null) {
        return;
      }
      const existing = this.threadStates.get(threadId);
      if (existing !== undefined) {
        recoverStalePhase(existing, Date.now());
        if (existing.phase === YIELDING_PHASE) {
          return;
        }
      }
      const context = await this.prepareCompactionContext(
        threadId,
        config.threshold,
      );
      if (context === null) {
        return;
      }
      const decision = evaluateMidTurnAutoCompactDecision({
        enabled: config.enabled,
        threshold: config.threshold,
        usedTokens: context.usage.usedTokens,
        activity: context.activity,
        awaitingDropOrNewTurn: context.state.awaitingDropOrNewTurn,
        lastAttemptedTurnSeq: context.state.lastAttemptedTurnSeq,
        consecutiveAutoCompactions: context.state.consecutiveAutoCompactions,
      });
      if (decision.action !== "compact") {
        return;
      }
      await this.dispatchMidTurnYield(
        threadId,
        context.state,
        context.activity.latestSeq,
        decision.turnSeq,
        context.usage,
        config.threshold,
      );
    } catch (error) {
      this.logCheckError(threadId, startedAt, error);
    }
  }

  /**
   * Steers an active turn at a tool-free boundary so `agy` yields cleanly on
   * the same ACP process and `thread.idle` can atomically compact and continue.
   */
  private async dispatchMidTurnYield(
    threadId: string,
    state: ThreadAutoCompactState,
    latestSeq: number,
    turnSeq: number,
    usage: ContextUsageSnapshot,
    threshold: number,
  ): Promise<void> {
    state.phase = YIELDING_PHASE;
    state.phaseUpdatedAtMs = Date.now();
    state.yieldSteerSeq = latestSeq;
    state.yieldUsage = usage;
    state.yieldThreshold = threshold;
    state.lastAttemptedTurnSeq = turnSeq;
    this.bb.log.info(
      `op=${MID_TURN_YIELD_OPERATION} threadId=${threadId} providerId=${PROVIDER_ID} ` +
        `turnSeq=${turnSeq} usedTokens=${usage.usedTokens} ` +
        `threshold=${threshold} modelContextWindow=${usage.modelContextWindow}`,
    );
    try {
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
        this.lifecycle.signal,
        MID_TURN_YIELD_OPERATION,
        AUTO_COMPACT_REQUEST_TIMEOUT_MS,
      );
    } catch (error) {
      resetToIdlePhase(state, Date.now());
      state.lastAttemptedTurnSeq = undefined;
      throw error;
    }
  }

  /**
   * Handles idle transitions: atomically compacts and continues a yielded
   * active turn, or performs background post-turn compaction on idle threads.
   */
  private async evaluateIdleThread(threadId: string): Promise<void> {
    const startedAt = Date.now();
    try {
      const config = await this.readValidatedConfig(threadId);
      const existing = this.threadStates.get(threadId);
      if (existing !== undefined) {
        recoverStalePhase(existing, Date.now());
      }
      if (config === null) {
        if (existing !== undefined && existing.phase === YIELDING_PHASE) {
          resetToIdlePhase(existing, Date.now());
        }
        return;
      }
      if (existing !== undefined && existing.phase === YIELDING_PHASE) {
        await this.completeYieldedMidTurnCompaction(
          threadId,
          existing,
          config.threshold,
        );
        return;
      }
      await this.evaluateNormalIdleCompaction(threadId, config);
    } catch (error) {
      this.logCheckError(threadId, startedAt, error);
    }
  }

  /**
   * Runs `compactFirst` + agent-only continuation after a mid-turn yield so the
   * session compacts and immediately keeps running unless the user stopped it.
   */
  private async completeYieldedMidTurnCompaction(
    threadId: string,
    state: ThreadAutoCompactState,
    threshold: number,
  ): Promise<void> {
    const activity = await this.readRecentActivity(threadId);
    if (this.disposed) {
      return;
    }
    if (!canResumeAfterMidTurnYield(activity, state.yieldSteerSeq)) {
      this.bb.log.info(
        `op=${YIELD_CANCELLED_OPERATION} threadId=${threadId} providerId=${PROVIDER_ID}`,
      );
      resetToIdlePhase(state, Date.now());
      return;
    }
    const freshUsage = await this.readContextUsage(threadId);
    if (this.disposed) {
      return;
    }
    const usage = freshUsage ?? state.yieldUsage;
    const effectiveThreshold = state.yieldThreshold ?? threshold;
    const usedTokens = usage?.usedTokens ?? effectiveThreshold;
    const contextWindow = usage?.modelContextWindow ?? ZERO_COUNT;

    state.phase = COMPACTING_RESUME_PHASE;
    state.phaseUpdatedAtMs = Date.now();
    state.awaitingDropOrNewTurn = true;
    state.lastCompactionSeq = activity.latestSeq;
    state.consecutiveAutoCompactions += ONE_COUNT;
    state.yieldUsage = null;
    state.yieldThreshold = null;

    this.bb.log.info(
      `op=${TRIGGER_CONTINUE_OPERATION} threadId=${threadId} providerId=${PROVIDER_ID} ` +
        `usedTokens=${usedTokens} threshold=${effectiveThreshold} ` +
        `modelContextWindow=${contextWindow} consecutive=${state.consecutiveAutoCompactions}`,
    );
    try {
      await awaitWithTimeout(
        this.bb.sdk.threads.send({
          threadId,
          mode: START_SEND_MODE,
          compactFirst: true,
          input: [
            {
              type: TEXT_BLOCK_TYPE,
              text: buildPostCompactionResumePrompt(
                usedTokens,
                effectiveThreshold,
              ),
              mentions: [],
              visibility: AGENT_ONLY_VISIBILITY,
            },
          ],
        }),
        this.lifecycle.signal,
        TRIGGER_CONTINUE_OPERATION,
        AUTO_COMPACT_REQUEST_TIMEOUT_MS,
      );
    } catch (error) {
      resetToIdlePhase(state, Date.now());
      throw error;
    }
  }

  /** Compacts an idle thread that finished a turn above threshold on its own. */
  private async evaluateNormalIdleCompaction(
    threadId: string,
    config: ValidatedConfig,
  ): Promise<void> {
    const context = await this.prepareCompactionContext(
      threadId,
      config.threshold,
    );
    if (context === null) {
      return;
    }
    const decision = evaluateIdleAutoCompactDecision({
      enabled: config.enabled,
      threshold: config.threshold,
      usedTokens: context.usage.usedTokens,
      activity: context.activity,
      awaitingDropOrNewTurn: context.state.awaitingDropOrNewTurn,
      lastAttemptedTurnSeq: context.state.lastAttemptedTurnSeq,
    });
    if (decision.action !== "compact") {
      return;
    }
    await this.dispatchIdleCompaction(
      threadId,
      context.state,
      context.activity.latestSeq,
      decision.turnSeq,
      context.usage,
      config.threshold,
    );
  }

  /** Dispatches post-turn `/compact` on an idle thread while guarding against repeat loops. */
  private async dispatchIdleCompaction(
    threadId: string,
    state: ThreadAutoCompactState,
    latestSeq: number,
    turnSeq: number,
    usage: ContextUsageSnapshot,
    threshold: number,
  ): Promise<void> {
    state.phase = COMPACTING_IDLE_PHASE;
    state.phaseUpdatedAtMs = Date.now();
    state.awaitingDropOrNewTurn = true;
    state.lastCompactionSeq = latestSeq;
    state.lastAttemptedTurnSeq = turnSeq;
    this.bb.log.info(
      `op=${TRIGGER_IDLE_OPERATION} threadId=${threadId} providerId=${PROVIDER_ID} ` +
        `turnSeq=${turnSeq} usedTokens=${usage.usedTokens} ` +
        `threshold=${threshold} modelContextWindow=${usage.modelContextWindow}`,
    );
    try {
      await this.bb.sdk.threads.compact({
        threadId,
        signal: this.requestSignal(AUTO_COMPACT_REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      resetToIdlePhase(state, Date.now());
      throw error;
    }
  }
}

/**
 * Registers the auto-compaction settings and thread lifecycle listeners;
 * called once from the server entry.
 */
export function registerAutoCompaction(bb: BbPluginApi): void {
  const settings = defineAutoCompactSettings(bb);
  const compactor = new AutoCompactor(bb, settings);

  bb.events.on("experimental_thread.events", ({ thread }) =>
    compactor.handleThreadEvents(thread),
  );
  bb.events.on("thread.idle", ({ thread }) =>
    compactor.handleThreadIdle(thread),
  );
  bb.events.on("thread.failed", ({ thread }) => {
    compactor.handleThreadFailed(thread.id);
  });
  bb.events.on("thread.archived", ({ thread }) => {
    compactor.forgetThread(thread.id);
  });
  bb.events.on("thread.deleted", ({ thread }) => {
    compactor.forgetThread(thread.id);
  });
  bb.onDispose(() => {
    compactor.dispose();
  });
}
