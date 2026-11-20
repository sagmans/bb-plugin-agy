/**
 * Manages bounded LRU per-thread auto-compaction tracking and mid-turn yield
 * expiry so long-lived BB servers cap memory and stalled yields recover cleanly.
 */

import type { RecentThreadActivity } from "./auto-compact-events.ts";
import type {
  AutoCompactJournal,
  JournalState,
} from "./auto-compact-journal.ts";
import {
  AUTO_COMPACT_MAX_TRACKED_THREADS,
  AUTO_COMPACT_YIELD_TIMEOUT_MS,
} from "./constants.ts";

const ZERO_COUNT = 0 as const;
const ONE_COUNT = 1 as const;

/** Captures the sole in-flight mid-turn yield awaiting its matching idle boundary. */
export interface PendingMidTurnYield {
  readonly steerSeq: number;
  readonly startedAtMs: number;
}

/** Mutable per-thread state reconciled against persisted event watermarks. */
export interface ThreadAutoCompactState {
  pendingYield: PendingMidTurnYield | null;
  yieldGeneration: number;
  awaitingDropOrNewTurn: boolean;
  lastUserRequestSeq: number;
  lastAttemptedMidTurnSeq: number | null;
  lastAttemptedIdleTurnSeq: number | null;
  consecutiveAutoCompactions: number;
}

/** Initializes clean per-thread defaults without leaking partial state. */
function createInitialThreadState(): ThreadAutoCompactState {
  return {
    pendingYield: null,
    yieldGeneration: ZERO_COUNT,
    awaitingDropOrNewTurn: false,
    lastUserRequestSeq: ZERO_COUNT,
    lastAttemptedMidTurnSeq: null,
    lastAttemptedIdleTurnSeq: null,
    consecutiveAutoCompactions: ZERO_COUNT,
  };
}

/** Drops an unfulfilled mid-turn yield once its settle window expires. */
function expireStaleYield(state: ThreadAutoCompactState, now: number): void {
  if (
    state.pendingYield !== null &&
    now - state.pendingYield.startedAtMs > AUTO_COMPACT_YIELD_TIMEOUT_MS
  ) {
    state.pendingYield = null;
  }
}

/**
 * Reconciles tracked user-prompt watermarks against persisted events so new
 * human prompts re-arm compaction and reset the consecutive loop breaker.
 */
export function syncStateWithActivity(
  state: ThreadAutoCompactState,
  activity: RecentThreadActivity,
): void {
  if (activity.latestUserRequestSeq > state.lastUserRequestSeq) {
    state.lastUserRequestSeq = activity.latestUserRequestSeq;
    state.awaitingDropOrNewTurn = false;
    state.consecutiveAutoCompactions = ZERO_COUNT;
  }
}

/**
 * Bounds tracked threads with LRU eviction and encapsulates yield invalidation
 * so in-flight RPCs cannot commit stale yields after failures or deletions.
 */
export class ThreadAutoCompactStore {
  private readonly maxTrackedThreads: number;
  private readonly states = new Map<string, ThreadAutoCompactState>();
  private readonly journal?: AutoCompactJournal;

  // Explicit field assignment keeps Node native type stripping compatible.
  constructor(
    maxTrackedThreads: number = AUTO_COMPACT_MAX_TRACKED_THREADS,
    journal?: AutoCompactJournal,
  ) {
    this.maxTrackedThreads = maxTrackedThreads;
    this.journal = journal;
  }

  /** Persists only settlement watermarks so reloads keep prompt budgets and unfinished yields. */
  checkpoint(
    threadId: string,
    state: ThreadAutoCompactState,
    changes: Partial<JournalState> = {},
  ): void {
    this.journal?.save(threadId, { ...state, ...changes });
    Object.assign(state, changes);
  }

  /** Retires a finished yield so a rejected or interrupted turn is not replayed at each startup. */
  settleAttempt(
    threadId: string,
    state: ThreadAutoCompactState,
    turnSeq: number | null,
    changes: Partial<JournalState> = {},
  ): void {
    if (turnSeq !== null && this.peek(threadId) === state) {
      this.checkpoint(threadId, state, {
        ...changes,
        lastAttemptedIdleTurnSeq: Math.max(
          state.lastAttemptedIdleTurnSeq ?? ZERO_COUNT,
          turnSeq,
        ),
      });
    }
  }

  /** Inspects existing state without allocating or changing LRU order. */
  peek(threadId: string): ThreadAutoCompactState | null {
    return this.states.get(threadId) ?? null;
  }

  /** Reports whether an unexpired mid-turn yield is already awaiting idle. */
  hasPendingYield(threadId: string, now: number): boolean {
    const state = this.peek(threadId);
    if (state === null) {
      return false;
    }
    expireStaleYield(state, now);
    return state.pendingYield !== null;
  }

  /** Atomically claims an unexpired mid-turn yield so only one idle check resumes it. */
  takePendingYield(
    threadId: string,
    now: number,
  ): {
    readonly state: ThreadAutoCompactState;
    readonly pending: PendingMidTurnYield;
  } | null {
    const state = this.peek(threadId);
    if (state === null) {
      return null;
    }
    expireStaleYield(state, now);
    const pending = state.pendingYield;
    if (pending === null) {
      return null;
    }
    state.pendingYield = null;
    return { state, pending };
  }

  /**
   * Cancels any active or in-flight mid-turn yield without allocating state,
   * bumping `yieldGeneration` so concurrent steer completions fail closed.
   */
  clearPendingYield(threadId: string): void {
    const state = this.peek(threadId);
    if (state === null) {
      return;
    }
    state.pendingYield = null;
    state.yieldGeneration += ONE_COUNT;
  }

  /** Re-arms compaction once observed usage drops below the configured threshold. */
  clearAwaitingDrop(threadId: string): void {
    const state = this.peek(threadId);
    this.journal?.clearAwaitingDrop(threadId);
    if (state !== null) {
      state.awaitingDropOrNewTurn = false;
    }
  }

  /** Promotes or allocates bounded LRU state while expiring stale mid-turn yields. */
  ensure(threadId: string, now: number): ThreadAutoCompactState {
    const existing = this.states.get(threadId);
    if (existing !== undefined) {
      this.states.delete(threadId);
      this.states.set(threadId, existing);
      expireStaleYield(existing, now);
      return existing;
    }
    if (this.states.size >= this.maxTrackedThreads) {
      const oldest = this.states.keys().next().value;
      if (oldest !== undefined) {
        this.states.delete(oldest);
      }
    }
    const created = Object.assign(
      createInitialThreadState(),
      this.journal?.read(threadId),
    );
    this.states.set(threadId, created);
    return created;
  }

  /** Drops state when a thread is archived or deleted. */
  delete(threadId: string): void {
    this.journal?.delete(threadId);
    this.states.delete(threadId);
  }

  /** Releases all tracked entries on plugin disposal. */
  clear(): void {
    this.states.clear();
  }
}
