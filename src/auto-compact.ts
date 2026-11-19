/**
 * Enforces a configurable token cap on Antigravity (`agy`) threads because the
 * `agy` CLI exposes no native setting to lower its backend compaction ceiling.
 * Compacts active sessions mid-turn and immediately continues them via
 * `compactFirst` + agent-only continuation so work never stops or pauses, and
 * compacts idle threads between turns without restarting the ACP process.
 */

import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  AutoCompactSdkClient,
  type AutoCompactSettingsHandle,
  defineAutoCompactSettings,
  type ValidatedAutoCompactConfig,
} from "./auto-compact-client.ts";
import {
  type AutoCompactThreadCandidate,
  type ContextUsageSnapshot,
  canResumeAfterMidTurnYield,
  evaluateIdleAutoCompactDecision,
  evaluateMidTurnAutoCompactDecision,
  isEligibleActiveAutoCompactThread,
  isEligibleIdleAutoCompactThread,
  type RecentThreadActivity,
} from "./auto-compact-policy.ts";
import {
  COMPACTING_IDLE_PHASE,
  COMPACTING_RESUME_PHASE,
  IDLE_PHASE,
  recoverStalePhase,
  resetToIdlePhase,
  syncStateWithActivity,
  type ThreadAutoCompactState,
  ThreadAutoCompactStore,
  YIELDING_PHASE,
} from "./auto-compact-state.ts";

export * from "./auto-compact-policy.ts";

const ZERO_COUNT = 0 as const;
const ONE_COUNT = 1 as const;

/**
 * Coordinates per-thread deduplication, safe mid-turn yield + continuation,
 * and idle compaction across `agy` threads.
 */
class AutoCompactor {
  private disposed = false;
  private readonly lifecycle = new AbortController();
  private readonly inFlight = new Set<string>();
  private readonly pendingIdle = new Map<string, AutoCompactThreadCandidate>();
  private readonly store = new ThreadAutoCompactStore();
  private readonly client: AutoCompactSdkClient;

  // Explicit field assignment keeps Node native type stripping compatible.
  constructor(bb: BbPluginApi, settings: AutoCompactSettingsHandle) {
    this.client = new AutoCompactSdkClient(bb, settings, this.lifecycle.signal);
  }

  /** Aborts in-flight SDK calls and releases per-thread tracking on plugin unload. */
  dispose(): void {
    this.disposed = true;
    this.lifecycle.abort();
    this.inFlight.clear();
    this.pendingIdle.clear();
    this.store.clear();
  }

  /** Drops per-thread tracking once a thread is archived or deleted. */
  forgetThread(threadId: string): void {
    this.pendingIdle.delete(threadId);
    this.store.delete(threadId);
  }

  /** Clears transient compaction phases when a turn fails so recovery never stalls. */
  handleThreadFailed(threadId: string): void {
    const state = this.store.peek(threadId);
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
    const existing = this.store.peek(threadId);
    const usage = await this.client.readContextUsage(threadId);
    if (this.disposed) {
      return null;
    }
    const needsStateSync =
      existing !== undefined &&
      (existing.awaitingDropOrNewTurn || existing.phase !== IDLE_PHASE);
    if (!needsStateSync && (usage === null || usage.usedTokens < threshold)) {
      return null;
    }
    const activity = await this.client.readRecentActivity(threadId);
    if (this.disposed) {
      return null;
    }
    const now = Date.now();
    const state = this.store.ensure(threadId, now);
    syncStateWithActivity(
      state,
      activity,
      usage?.usedTokens ?? null,
      threshold,
      now,
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
      const config = await this.client.readValidatedConfig(threadId);
      if (config === null) {
        return;
      }
      const existing = this.store.peek(threadId);
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
      this.client.logCheckError(threadId, startedAt, error);
    }
  }

  /** Updates phase tracking around `sendMidTurnYield`, rolling back if steer fails. */
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
    try {
      await this.client.sendMidTurnYield(threadId, turnSeq, usage, threshold);
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
      const config = await this.client.readValidatedConfig(threadId);
      const existing = this.store.peek(threadId);
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
      this.client.logCheckError(threadId, startedAt, error);
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
    const activity = await this.client.readRecentActivity(threadId);
    if (this.disposed) {
      return;
    }
    if (!canResumeAfterMidTurnYield(activity, state.yieldSteerSeq)) {
      this.client.logYieldCancelled(threadId);
      resetToIdlePhase(state, Date.now());
      return;
    }
    const freshUsage = await this.client.readContextUsage(threadId);
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

    try {
      await this.client.sendCompactAndContinue(
        threadId,
        usedTokens,
        effectiveThreshold,
        contextWindow,
        state.consecutiveAutoCompactions,
      );
    } catch (error) {
      resetToIdlePhase(state, Date.now());
      throw error;
    }
  }

  /** Compacts an idle thread that finished a turn above threshold on its own. */
  private async evaluateNormalIdleCompaction(
    threadId: string,
    config: ValidatedAutoCompactConfig,
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

  /** Updates phase tracking around `sendIdleCompact`, rolling back on failure. */
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
    try {
      await this.client.sendIdleCompact(threadId, turnSeq, usage, threshold);
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
