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
} from "./auto-compact-client.ts";
import type { RecentThreadActivity } from "./auto-compact-events.ts";
import {
  ACTIVE_THREAD_STATUS,
  AUTO_COMPACT_MODE_IDLE,
  AUTO_COMPACT_MODE_MID_TURN,
  type AutoCompactExpectedStatus,
  type AutoCompactThreadCandidate,
  type ContextUsageSnapshot,
  canResumeAfterMidTurnYield,
  DECISION_COMPACT,
  evaluateAutoCompactDecision,
  IDLE_THREAD_STATUS,
  isEligibleAutoCompactThread,
} from "./auto-compact-policy.ts";
import {
  type PendingMidTurnYield,
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
    if (!isEligibleAutoCompactThread(liveThread, expectedStatus)) {
      if (expectedStatus === IDLE_THREAD_STATUS) {
        this.store.clearPendingYield(threadId);
      }
      return false;
    }
    return true;
  }

  /**
   * Short-circuits sub-threshold usage without querying event logs or thread
   * DTOs, re-arming `awaitingDropOrNewTurn` directly when usage drops.
   */
  private async prepareCompactionContext(
    threadId: string,
    threshold: number,
    expectedStatus: AutoCompactExpectedStatus,
  ): Promise<{
    readonly state: ThreadAutoCompactState;
    readonly activity: RecentThreadActivity;
    readonly usage: ContextUsageSnapshot;
  } | null> {
    const usage = await this.client.readContextUsage(threadId);
    if (this.lifecycle.signal.aborted || usage === null) {
      return null;
    }
    if (usage.usedTokens < threshold) {
      this.store.clearAwaitingDrop(threadId);
      return null;
    }
    const [activity, liveThread] = await Promise.all([
      this.client.readRecentActivity(threadId),
      this.client.readLiveThread(threadId),
    ]);
    if (
      this.lifecycle.signal.aborted ||
      !this.isLiveThreadEligible(threadId, liveThread, expectedStatus)
    ) {
      return null;
    }
    const state = this.store.ensure(threadId, Date.now());
    syncStateWithActivity(state, activity);
    return { state, activity, usage };
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
      const context = await this.prepareCompactionContext(
        threadId,
        threshold,
        ACTIVE_THREAD_STATUS,
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
   * `pendingYield` only if delivered immediately without intervening failures.
   */
  private async dispatchMidTurnYield(
    threadId: string,
    state: ThreadAutoCompactState,
    latestSeq: number,
    turnSeq: number,
    usage: ContextUsageSnapshot,
    threshold: number,
  ): Promise<void> {
    const yieldGeneration = state.yieldGeneration;
    state.lastAttemptedMidTurnSeq = turnSeq;
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
        usage,
      };
    }
  }

  /** Handles idle transitions: continues a yielded active turn or compacts idle state. */
  private async evaluateIdleThread(threadId: string): Promise<void> {
    const startedAt = Date.now();
    try {
      const threshold = await this.client.readActiveThreshold(threadId);
      if (threshold === null) {
        this.store.clearPendingYield(threadId);
        return;
      }
      const claimed = this.store.takePendingYield(threadId, Date.now());
      if (claimed !== null) {
        await this.completeYieldedMidTurnCompaction(
          threadId,
          claimed.state,
          claimed.pending,
          threshold,
        );
        return;
      }
      await this.evaluateNormalIdleCompaction(threadId, threshold);
    } catch (error) {
      this.client.logCheckError(threadId, startedAt, error);
    }
  }

  /**
   * Runs `compactFirst` + agent-only continuation after a mid-turn yield so the
   * session compacts and immediately keeps running unless superseded or already below cap.
   */
  private async completeYieldedMidTurnCompaction(
    threadId: string,
    state: ThreadAutoCompactState,
    pending: PendingMidTurnYield,
    threshold: number,
  ): Promise<void> {
    const [activity, freshUsage, liveThread] = await Promise.all([
      this.client.readRecentActivity(threadId),
      this.client.readContextUsage(threadId),
      this.client.readLiveThread(threadId),
    ]);
    if (
      !this.isCurrentState(threadId, state) ||
      !this.isLiveThreadEligible(threadId, liveThread, IDLE_THREAD_STATUS)
    ) {
      return;
    }
    const usage = freshUsage ?? pending.usage;
    if (
      usage.usedTokens < threshold ||
      !canResumeAfterMidTurnYield(activity, pending.steerSeq)
    ) {
      if (usage.usedTokens < threshold) {
        state.awaitingDropOrNewTurn = false;
      }
      this.client.logYieldCancelled(threadId);
      return;
    }
    const nextConsecutive = state.consecutiveAutoCompactions + ONE_COUNT;
    await this.client.sendCompactAndContinue(
      threadId,
      usage,
      threshold,
      nextConsecutive,
    );
    if (this.isCurrentState(threadId, state)) {
      state.awaitingDropOrNewTurn = true;
      state.consecutiveAutoCompactions = nextConsecutive;
    }
  }

  /** Compacts an idle thread that finished a turn above threshold on its own. */
  private async evaluateNormalIdleCompaction(
    threadId: string,
    threshold: number,
  ): Promise<void> {
    const context = await this.prepareCompactionContext(
      threadId,
      threshold,
      IDLE_THREAD_STATUS,
    );
    if (context === null) {
      return;
    }
    const decision = evaluateAutoCompactDecision({
      mode: AUTO_COMPACT_MODE_IDLE,
      enabled: true,
      threshold,
      usedTokens: context.usage.usedTokens,
      activity: context.activity,
      awaitingDropOrNewTurn: context.state.awaitingDropOrNewTurn,
      lastAttemptedTurnSeq: context.state.lastAttemptedIdleTurnSeq,
    });
    if (decision.action !== DECISION_COMPACT) {
      return;
    }
    await this.client.sendIdleCompact(
      threadId,
      decision.turnSeq,
      context.usage,
      threshold,
    );
    if (this.isCurrentState(threadId, context.state)) {
      context.state.awaitingDropOrNewTurn = true;
      context.state.lastAttemptedIdleTurnSeq = decision.turnSeq;
    }
  }
}

/** Instantiates a live SDK-backed `AutoCompactor` wired to plugin settings. */
function createLiveAutoCompactor(
  bb: BbPluginApi,
  settings: AutoCompactSettingsHandle,
): AutoCompactor {
  const lifecycle = new AbortController();
  const client = new AutoCompactSdkClient(bb, settings, lifecycle.signal);
  return new AutoCompactor(client, lifecycle);
}

/**
 * Registers the auto-compaction settings and thread lifecycle listeners;
 * called once from the server entry.
 */
export function registerAutoCompaction(bb: BbPluginApi): void {
  const settings = defineAutoCompactSettings(bb);
  const compactor = createLiveAutoCompactor(bb, settings);

  bb.events.on("thread.active", ({ thread }) => {
    compactor.handleThreadActive(thread.id);
  });
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
