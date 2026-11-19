/**
 * Manages bounded per-thread auto-compaction phases, stale-phase recovery, and
 * timeout-guarded RPC waits so server memory stays capped and stalled host
 * operations never permanently wedge a thread's compaction tracker.
 */

import type {
  ContextUsageSnapshot,
  RecentThreadActivity,
} from "./auto-compact-policy.ts";
import {
  AUTO_COMPACT_MAX_TRACKED_THREADS,
  AUTO_COMPACT_PHASE_TIMEOUT_MS,
  AUTO_COMPACT_YIELD_TIMEOUT_MS,
} from "./constants.ts";

const ZERO_COUNT = 0 as const;

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

/** Domain error raised when an SDK call without native AbortSignal exceeds its bound. */
export class AutoCompactRequestTimeoutError extends Error {
  constructor(operation: string, timeoutMs: number) {
    super(`${operation} exceeded ${timeoutMs}ms timeout`);
    this.name = "AutoCompactRequestTimeoutError";
  }
}

/** Bounds RPCs whose SDK signature lacks a native AbortSignal so locks always release. */
export async function awaitWithTimeout<T>(
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

/** Creates an initialized per-thread tracker entry with clean idle defaults. */
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

/** Resets transient yield metadata when leaving `yielding-mid-turn` or recovering errors. */
export function resetToIdlePhase(
  state: ThreadAutoCompactState,
  now: number,
): void {
  state.phase = IDLE_PHASE;
  state.phaseUpdatedAtMs = now;
  state.yieldUsage = null;
  state.yieldThreshold = null;
}

/** Recovers stuck phases if an expected lifecycle transition never arrives. */
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
  private readonly states = new Map<string, ThreadAutoCompactState>();

  /** Reads existing state without creating an entry on the common below-threshold path. */
  peek(threadId: string): ThreadAutoCompactState | undefined {
    return this.states.get(threadId);
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
    if (this.states.size >= AUTO_COMPACT_MAX_TRACKED_THREADS) {
      const oldest = this.states.keys().next().value;
      if (oldest !== undefined) {
        this.states.delete(oldest);
      }
    }
    const created = createInitialThreadState(now);
    this.states.set(threadId, created);
    return created;
  }

  /** Drops state when a thread is archived or deleted. */
  delete(threadId: string): void {
    this.states.delete(threadId);
  }

  /** Releases all tracked entries on plugin disposal. */
  clear(): void {
    this.states.clear();
  }
}
