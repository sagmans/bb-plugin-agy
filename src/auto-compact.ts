/**
 * Enforces a configurable token cap on Antigravity (`agy`) threads because the
 * `agy` CLI exposes no native setting to lower its backend compaction ceiling.
 * Compacts active sessions mid-turn and immediately continues them via
 * `compactFirst` + agent-only continuation so work never stops or pauses, and
 * compacts idle threads between turns without restarting the ACP process.
 */

import type { AutoCompactSdkClient } from "./auto-compact-client.ts";
import type { RecentThreadActivity } from "./auto-compact-events.ts";
import { readIdleContext } from "./auto-compact-idle-read.ts";
import {
  ACTIVE_THREAD_STATUS,
  AUTO_COMPACT_MODE_IDLE,
  AUTO_COMPACT_MODE_MID_TURN,
  type AutoCompactExpectedStatus,
  type AutoCompactThreadCandidate,
  type ContextUsageSnapshot,
  DECISION_COMPACT,
  evaluateAutoCompactDecision,
  evaluatePostYieldDecision,
  hasPersistedMidTurnYield,
  IDLE_THREAD_STATUS,
  isEligibleAutoCompactThread,
  POST_YIELD_ACTION_CANCEL,
  POST_YIELD_ACTION_COMPACT_CONTINUE,
  type PostYieldDecisionInput,
} from "./auto-compact-policy.ts";
import {
  syncStateWithActivity,
  type ThreadAutoCompactState,
  ThreadAutoCompactStore,
} from "./auto-compact-state.ts";

const ONE_COUNT = 1 as const;

/** Minimal transport contract consumed by `AutoCompactor` so smoke checks need no SDK stub. */
export type AutoCompactorClient = Pick<
  AutoCompactSdkClient,
  | "readActiveThreshold"
  | "readLiveThread"
  | "readContextUsage"
  | "readRecentActivity"
  | "sendMidTurnYield"
  | "sendCompactAndContinue"
  | "sendResumeWithoutCompact"
  | "sendIdleCompact"
  | "logYieldCancelled"
  | "logCheckError"
>;

/**
 * Coordinates per-thread locking, live-state re-verification, safe mid-turn
 * yield + continuation, and idle compaction across `agy` threads; exported for
 * deterministic smoke verification.
 */
export class AutoCompactor {
  private readonly lifecycle: AbortController;
  private readonly inFlight = new Set<string>();
  private readonly pendingIdle = new Set<string>();
  private readonly store: ThreadAutoCompactStore;
  private readonly client: AutoCompactorClient;

  // Explicit field assignment keeps Node native type stripping compatible.
  constructor(
    client: AutoCompactorClient,
    lifecycle: AbortController,
    store: ThreadAutoCompactStore = new ThreadAutoCompactStore(),
  ) {
    this.client = client;
    this.lifecycle = lifecycle;
    this.store = store;
  }

  /** Aborts in-flight SDK calls and releases per-thread tracking on plugin unload. */
  dispose(): void {
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

  /** Drops queued idle replays and stale in-flight yields when a new active turn starts. */
  handleThreadActive(threadId: string): void {
    this.pendingIdle.delete(threadId);
    this.store.clearPendingYield(threadId);
  }

  /** Clears active and in-flight yields on failure so later turns are never hijacked. */
  handleThreadFailed(threadId: string): void {
    this.store.clearPendingYield(threadId);
  }

  /** Evaluates active-turn events for safe mid-turn yield without wiping deferred idle checks. */
  async handleThreadEvents(thread: AutoCompactThreadCandidate): Promise<void> {
    if (
      this.lifecycle.signal.aborted ||
      !isEligibleAutoCompactThread(thread, ACTIVE_THREAD_STATUS) ||
      this.inFlight.has(thread.id)
    ) {
      return;
    }
    await this.withThreadLock(thread.id, () =>
      this.evaluateActiveThread(thread.id),
    );
  }

  /** Evaluates an idle transition: compacts+continues a yielded turn or compacts idle state. */
  async handleThreadIdle(thread: AutoCompactThreadCandidate): Promise<void> {
    if (this.lifecycle.signal.aborted) {
      return;
    }
    if (!isEligibleAutoCompactThread(thread, IDLE_THREAD_STATUS)) {
      this.pendingIdle.delete(thread.id);
      this.store.clearPendingYield(thread.id);
      return;
    }
    if (this.inFlight.has(thread.id)) {
      this.pendingIdle.add(thread.id);
      return;
    }
    await this.withThreadLock(thread.id, () =>
      this.evaluateIdleThread(thread.id),
    );
  }

  /** Guards post-await state mutations against plugin disposal or thread eviction. */
  private isCurrentState(
    threadId: string,
    state: ThreadAutoCompactState,
  ): boolean {
    return (
      !this.lifecycle.signal.aborted && this.store.peek(threadId) === state
    );
  }

  /** Serializes per-thread checks and replays any deferred idle check against live state. */
  private async withThreadLock(
    threadId: string,
    task: () => Promise<void>,
  ): Promise<void> {
    this.inFlight.add(threadId);
    try {
      await task();
    } finally {
      this.inFlight.delete(threadId);
      if (!this.lifecycle.signal.aborted && this.pendingIdle.delete(threadId)) {
        void this.withThreadLock(threadId, () =>
          this.evaluateIdleThread(threadId),
        );
      }
    }
  }

  /** Confirms the live thread is still eligible and forgets archived or deleted threads. */
  private isLiveThreadEligible(
    threadId: string,
    liveThread: AutoCompactThreadCandidate | null,
    expectedStatus: AutoCompactExpectedStatus,
  ): boolean {
    if (
      liveThread === null ||
      liveThread.archivedAt !== null ||
      liveThread.deletedAt !== null
    ) {
      this.forgetThread(threadId);
      return false;
    }
    return isEligibleAutoCompactThread(liveThread, expectedStatus);
  }

  /**
   * Short-circuits sub-threshold active turns without querying event logs or
   * allocating LRU state, and snapshots `yieldGeneration` before awaiting reads
   * so mid-check turn transitions cannot steer a newer turn with stale activity.
   */
  private async prepareActiveCompactionContext(
    threadId: string,
    threshold: number,
  ): Promise<{
    readonly state: ThreadAutoCompactState;
    readonly activity: RecentThreadActivity;
    readonly usage: ContextUsageSnapshot;
    readonly yieldGeneration: number;
  } | null> {
    const usage = await this.client.readContextUsage(threadId);
    if (this.lifecycle.signal.aborted || usage === null) {
      return null;
    }
    if (usage.usedTokens < threshold) {
      this.store.clearAwaitingDrop(threadId);
      return null;
    }
    const state = this.store.ensure(threadId, Date.now());
    const yieldGeneration = state.yieldGeneration;
    const [activity, liveThread] = await Promise.all([
      this.client.readRecentActivity(threadId),
      this.client.readLiveThread(threadId),
    ]);
    if (
      !this.isCurrentState(threadId, state) ||
      state.yieldGeneration !== yieldGeneration ||
      !this.isLiveThreadEligible(threadId, liveThread, ACTIVE_THREAD_STATUS)
    ) {
      return null;
    }
    syncStateWithActivity(state, activity);
    return { state, activity, usage, yieldGeneration };
  }

  /** Steers an active turn at a safe step boundary once context reaches the configured cap. */
  private async evaluateActiveThread(threadId: string): Promise<void> {
    const startedAt = Date.now();
    try {
      const threshold = await this.client.readActiveThreshold(threadId);
      if (
        threshold === null ||
        this.store.hasPendingYield(threadId, Date.now())
      ) {
        return;
      }
      const context = await this.prepareActiveCompactionContext(
        threadId,
        threshold,
      );
      if (context === null) {
        return;
      }
      const decision = evaluateAutoCompactDecision({
        mode: AUTO_COMPACT_MODE_MID_TURN,
        enabled: true,
        threshold,
        usedTokens: context.usage.usedTokens,
        activity: context.activity,
        awaitingDropOrNewTurn: context.state.awaitingDropOrNewTurn,
        lastAttemptedTurnSeq: context.state.lastAttemptedMidTurnSeq,
        consecutiveAutoCompactions: context.state.consecutiveAutoCompactions,
      });
      if (decision.action !== DECISION_COMPACT) {
        return;
      }
      await this.dispatchMidTurnYield(
        threadId,
        context.state,
        context.yieldGeneration,
        context.activity.latestSeq,
        decision.turnSeq,
        context.usage,
        threshold,
      );
    } catch (error) {
      this.client.logCheckError(threadId, startedAt, error);
    }
  }

  /**
   * Steers an active turn to yield, pinning `lastAttemptedMidTurnSeq` so a
   * non-steerable turn never retries at event cadence while committing
   * `pendingYield` only if delivered immediately without intervening turn changes.
   */
  private async dispatchMidTurnYield(
    threadId: string,
    state: ThreadAutoCompactState,
    yieldGeneration: number,
    latestSeq: number,
    turnSeq: number,
    usage: ContextUsageSnapshot,
    threshold: number,
  ): Promise<void> {
    this.store.checkpoint(threadId, state, {
      lastAttemptedMidTurnSeq: turnSeq,
    });
    const delivered = await this.client.sendMidTurnYield(
      threadId,
      turnSeq,
      usage,
      threshold,
    );
    if (
      delivered &&
      this.isCurrentState(threadId, state) &&
      state.yieldGeneration === yieldGeneration
    ) {
      state.pendingYield = {
        steerSeq: latestSeq,
        startedAtMs: Date.now(),
      };
    }
  }

  /**
   * Settles both in-memory and persisted yields after checking fresh idle
   * history, even if settings changed or a transient read failed.
   */
  private async evaluateIdleThread(
    threadId: string,
    recoveryOnly = false,
  ): Promise<void> {
    const startedAt = Date.now();
    try {
      const {
        threshold,
        usage: freshUsage,
        activity,
        liveThread,
      } = await readIdleContext(this.client, threadId, this.lifecycle.signal);
      if (
        this.lifecycle.signal.aborted ||
        !this.isLiveThreadEligible(threadId, liveThread, IDLE_THREAD_STATUS)
      ) {
        return;
      }
      const claimed = this.store.takePendingYield(threadId, Date.now());
      if (claimed !== null) {
        if (!this.isCurrentState(threadId, claimed.state)) {
          return;
        }
        await this.settleYieldedTurn(threadId, claimed.state, {
          activity,
          yieldSteerSeq: Math.max(
            claimed.pending.steerSeq,
            activity.latestYieldSteerSeq,
          ),
          usage: freshUsage,
          threshold,
        });
        return;
      }
      if (hasPersistedMidTurnYield(activity)) {
        const state = this.store.ensure(threadId, Date.now());
        await this.settleYieldedTurn(threadId, state, {
          activity,
          yieldSteerSeq: activity.latestYieldSteerSeq,
          usage: freshUsage,
          threshold,
        });
        return;
      }
      if (recoveryOnly) {
        const state = this.store.ensure(threadId, Date.now());
        this.store.settleAttempt(
          threadId,
          state,
          state.lastAttemptedMidTurnSeq,
        );
        return;
      }
      await this.runNormalIdleCompaction(
        threadId,
        activity,
        freshUsage,
        threshold,
      );
    } catch (error) {
      this.client.logCheckError(threadId, startedAt, error);
    }
  }

  /** Reconciles missed idle notifications only for steers recorded before dispatch. */
  async recoverYield(threadId: string): Promise<void> {
    if (!this.lifecycle.signal.aborted && !this.inFlight.has(threadId)) {
      await this.withThreadLock(threadId, () =>
        this.evaluateIdleThread(threadId, true),
      );
    }
  }

  /**
   * Single settlement path for both in-memory and persisted mid-turn yields so
   * activity sync, loop caps, duplicate-idle guards, and post-await state checks
   * cannot diverge.
   */
  private async settleYieldedTurn(
    threadId: string,
    state: ThreadAutoCompactState,
    input: Omit<PostYieldDecisionInput, "consecutiveAutoCompactions">,
  ): Promise<void> {
    syncStateWithActivity(state, input.activity);
    const turnSeq =
      input.activity.latestTurnStartedSeq ??
      state.lastAttemptedMidTurnSeq ??
      input.yieldSteerSeq;
    const previousAttempt = state.lastAttemptedIdleTurnSeq;
    if (previousAttempt !== null && previousAttempt >= turnSeq) {
      return;
    }
    const decision = evaluatePostYieldDecision({
      ...input,
      consecutiveAutoCompactions: state.consecutiveAutoCompactions,
    });
    if (decision.action === POST_YIELD_ACTION_CANCEL) {
      this.store.settleAttempt(threadId, state, state.lastAttemptedMidTurnSeq, {
        awaitingDropOrNewTurn:
          state.awaitingDropOrNewTurn && !decision.rearmDrop,
      });
      this.client.logYieldCancelled(threadId);
      return;
    }
    // A send can outlive its caller. Reserve it before the SDK can accept it.
    if (decision.action === POST_YIELD_ACTION_COMPACT_CONTINUE) {
      this.store.settleAttempt(threadId, state, turnSeq, {
        consecutiveAutoCompactions:
          state.consecutiveAutoCompactions + ONE_COUNT,
        awaitingDropOrNewTurn: true,
      });
      await this.client.sendCompactAndContinue(
        threadId,
        decision.usage,
        decision.threshold,
        state.consecutiveAutoCompactions,
      );
      return;
    }
    this.store.settleAttempt(threadId, state, turnSeq);
    const delivered = await this.client.sendResumeWithoutCompact(
      threadId,
      decision.reason,
    );
    if (!this.isCurrentState(threadId, state)) return;
    if (!delivered) {
      // BB confirmed the queued control was removed, so a later idle can retry.
      this.store.checkpoint(threadId, state, {
        lastAttemptedIdleTurnSeq: previousAttempt,
      });
    } else if (decision.rearmDrop) {
      this.store.checkpoint(threadId, state, { awaitingDropOrNewTurn: false });
    }
  }

  /** Compacts an idle thread that finished a turn above threshold on its own. */
  private async runNormalIdleCompaction(
    threadId: string,
    activity: RecentThreadActivity,
    usage: ContextUsageSnapshot | null,
    threshold: number | null,
  ): Promise<void> {
    if (threshold === null || usage === null) {
      return;
    }
    if (usage.usedTokens < threshold) {
      this.store.clearAwaitingDrop(threadId);
      return;
    }
    const state = this.store.ensure(threadId, Date.now());
    syncStateWithActivity(state, activity);
    const decision = evaluateAutoCompactDecision({
      mode: AUTO_COMPACT_MODE_IDLE,
      enabled: true,
      threshold,
      usedTokens: usage.usedTokens,
      activity,
      awaitingDropOrNewTurn: state.awaitingDropOrNewTurn,
      lastAttemptedTurnSeq: state.lastAttemptedIdleTurnSeq,
    });
    if (decision.action !== DECISION_COMPACT) {
      return;
    }
    await this.client.sendIdleCompact(
      threadId,
      decision.turnSeq,
      usage,
      threshold,
    );
    if (this.isCurrentState(threadId, state)) {
      this.store.settleAttempt(threadId, state, decision.turnSeq, {
        awaitingDropOrNewTurn: true,
      });
    }
  }
}
