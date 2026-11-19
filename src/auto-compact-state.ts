/**
 * Manages bounded per-thread auto-compaction phases and stale-phase recovery so
 * server memory stays capped and missed lifecycle events never permanently
 * wedge a thread's compaction tracker.
 */

import type { RecentThreadActivity } from "./auto-compact-events.ts";
import type { ContextUsageSnapshot } from "./auto-compact-policy.ts";
import {
  AUTO_COMPACT_MAX_TRACKED_THREADS,
  AUTO_COMPACT_PHASE_TIMEOUT_MS,
  AUTO_COMPACT_YIELD_TIMEOUT_MS,
} from "./constants.ts";

const ZERO_COUNT = 0 as const;
const ONE_COUNT = 1 as const;

export const IDLE_PHASE = "idle" as const;
export const YIELDING_PHASE = "yielding-mid-turn" as const;
export const COMPACTING_IDLE_PHASE = "compacting-idle" as const;
export const COMPACTING_RESUME_PHASE = "compacting-resume" as const;

/** Tracks in-flight yield and compaction lifecycle steps per thread. */
export type AutoCompactPhase =
  | typeof IDLE_PHASE
  | typeof YIELDING_PHASE
  | typeof COMPACTING_IDLE_PHASE
  | typeof COMPACTING_RESUME_PHASE;

/** Mutable per-thread state reconciled against persisted event watermarks. */
export interface ThreadAutoCompactState {
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

/** Starts per-thread tracking in a clean idle state before any compaction attempt. */
export function createInitialThreadState(now: number): ThreadAutoCompactState {
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

/** Clears transient yield snapshots when returning to `idle` so stale tokens never carry over. */
export function resetToIdlePhase(
  state: ThreadAutoCompactState,
  now: number,
): void {
  state.phase = IDLE_PHASE;
  state.phaseUpdatedAtMs = now;
  state.yieldUsage = null;
  state.yieldThreshold = null;
}

/** Records a steered mid-turn yield before RPC dispatch so concurrent events coalesce. */
export function beginMidTurnYield(
  state: ThreadAutoCompactState,
  latestSeq: number,
  turnSeq: number,
  usage: ContextUsageSnapshot,
  threshold: number,
  now: number,
): void {
  state.phase = YIELDING_PHASE;
  state.phaseUpdatedAtMs = now;
  state.yieldSteerSeq = latestSeq;
  state.yieldUsage = usage;
  state.yieldThreshold = threshold;
  state.lastAttemptedTurnSeq = turnSeq;
}

/** Restores retryability on the active turn when a mid-turn `steer` RPC fails. */
export function rollbackMidTurnYield(
  state: ThreadAutoCompactState,
  now: number,
): void {
  resetToIdlePhase(state, now);
  state.lastAttemptedTurnSeq = undefined;
}

/** Arms loop-prevention latches before dispatching `compactFirst` continuation. */
export function beginCompactAndResume(
  state: ThreadAutoCompactState,
  latestSeq: number,
  now: number,
): number {
  state.phase = COMPACTING_RESUME_PHASE;
  state.phaseUpdatedAtMs = now;
  state.awaitingDropOrNewTurn = true;
  state.lastCompactionSeq = latestSeq;
  state.consecutiveAutoCompactions += ONE_COUNT;
  state.yieldUsage = null;
  state.yieldThreshold = null;
  return state.consecutiveAutoCompactions;
}

/** Arms loop-prevention latches before dispatching idle post-turn compaction. */
export function beginIdleCompaction(
  state: ThreadAutoCompactState,
  latestSeq: number,
  turnSeq: number,
  now: number,
): void {
  state.phase = COMPACTING_IDLE_PHASE;
  state.phaseUpdatedAtMs = now;
  state.awaitingDropOrNewTurn = true;
  state.lastCompactionSeq = latestSeq;
  state.lastAttemptedTurnSeq = turnSeq;
}

/** Unwedges a thread if an expected yield or compaction lifecycle event never arrives. */
export function recoverStalePhase(
  state: ThreadAutoCompactState,
  now: number,
): void {
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
export function syncStateWithActivity(
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
 * Bounds tracked threads with LRU eviction so long-running BB servers never
 * accumulate unbounded state across ephemeral threads.
 */
export class ThreadAutoCompactStore {
  private readonly maxTrackedThreads: number;
  private readonly states = new Map<string, ThreadAutoCompactState>();

  constructor(maxTrackedThreads: number = AUTO_COMPACT_MAX_TRACKED_THREADS) {
    this.maxTrackedThreads = maxTrackedThreads;
  }

  /**
   * Inspects tracked state without allocating on the common below-threshold fast
   * path, while still recovering phases that exceeded their timeout budget.
   */
  peekFresh(threadId: string, now: number): ThreadAutoCompactState | undefined {
    const existing = this.states.get(threadId);
    if (existing !== undefined) {
      recoverStalePhase(existing, now);
    }
    return existing;
  }

  /** Promotes or allocates bounded LRU state while recovering timed-out phases. */
  ensure(threadId: string, now: number): ThreadAutoCompactState {
    const existing = this.states.get(threadId);
    if (existing !== undefined) {
      this.states.delete(threadId);
      this.states.set(threadId, existing);
      recoverStalePhase(existing, now);
      return existing;
    }
    if (this.states.size >= this.maxTrackedThreads) {
      const oldest = this.states.keys().next().value;
      if (oldest !== undefined) {
        this.states.delete(oldest);
      }
    }
    const created = createInitialThreadState(now);
    this.states.set(threadId, created);
    return created;
  }

  /** Prevents orphaned entries from lingering after thread archival or deletion. */
  delete(threadId: string): void {
    this.states.delete(threadId);
  }

  /** Releases all per-thread memory immediately when the plugin unloads. */
  clear(): void {
    this.states.clear();
  }
}
