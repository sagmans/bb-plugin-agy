/**
 * Evaluates threshold, eligibility, and loop-prevention rules for Antigravity
 * (`agy`) auto-compaction without SDK or network dependencies so active yield
 * and idle compaction invariants stay deterministically verifiable.
 */

import { z } from "zod";
import type { RecentThreadActivity } from "./auto-compact-events.ts";
import {
  AUTO_COMPACT_MAX_CONSECUTIVE,
  AUTO_COMPACT_MESSAGE_PREFIX,
  AUTO_COMPACT_TOKEN_LOCALE,
  AUTO_COMPACT_TOKEN_THRESHOLD_MAX,
  AUTO_COMPACT_TOKEN_THRESHOLD_MIN,
  PROVIDER_ID,
} from "./constants.ts";

const ZERO_COUNT = 0 as const;
const COMPLETED_TURN_STATUS = "completed" as const;
const DECISION_SKIP = "skip" as const;

export const ACTIVE_THREAD_STATUS = "active" as const;
export const IDLE_THREAD_STATUS = "idle" as const;
export const AUTO_COMPACT_MODE_MID_TURN = "mid-turn" as const;
export const AUTO_COMPACT_MODE_IDLE = "idle" as const;
export const DECISION_COMPACT = "compact" as const;

export const YIELD_RESUME_REASON_DISABLED = "disabled-mid-yield" as const;
const YIELD_RESUME_REASON_NO_USAGE = "usage-unavailable" as const;
export const YIELD_RESUME_REASON_BELOW_THRESHOLD = "below-threshold" as const;
export const YIELD_RESUME_REASON_MAX_CONSECUTIVE = "max-consecutive" as const;

/** Typed reasons explaining why a yielded turn resumes without compacting. */
export type YieldResumeReason =
  | typeof YIELD_RESUME_REASON_NO_USAGE
  | typeof YIELD_RESUME_REASON_DISABLED
  | typeof YIELD_RESUME_REASON_BELOW_THRESHOLD
  | typeof YIELD_RESUME_REASON_MAX_CONSECUTIVE;

export const POST_YIELD_ACTION_CANCEL = "cancel" as const;
export const POST_YIELD_ACTION_COMPACT_CONTINUE =
  "compact-and-continue" as const;
export const POST_YIELD_ACTION_RESUME_WITHOUT_COMPACT =
  "resume-without-compact" as const;

/**
 * Discriminates post-yield outcomes so in-memory and persisted yield recovery
 * enforce identical resume, compaction, and loop-breaker invariants.
 */
export type PostYieldDecision =
  | {
      readonly action: typeof POST_YIELD_ACTION_CANCEL;
      readonly rearmDrop: boolean;
    }
  | {
      readonly action: typeof POST_YIELD_ACTION_COMPACT_CONTINUE;
      readonly threshold: number;
      readonly usage: ContextUsageSnapshot;
    }
  | {
      readonly action: typeof POST_YIELD_ACTION_RESUME_WITHOUT_COMPACT;
      readonly reason: YieldResumeReason;
      readonly rearmDrop: boolean;
    };

const SKIP_DISABLED = "disabled" as const;
const SKIP_INVALID_THRESHOLD = "invalid-threshold" as const;
const SKIP_MISSING_USAGE = "missing-usage" as const;
const SKIP_BELOW_THRESHOLD = "below-threshold" as const;
const SKIP_STALE_USAGE = "stale-pre-compaction-usage" as const;
const SKIP_COMPACTION_TURN = "compaction-turn" as const;
const SKIP_OPEN_TOOL = "open-tool-execution" as const;
const SKIP_NO_TURN = "no-turn-started" as const;
const SKIP_ALREADY_COMPACTED = "already-compacted-or-cleared" as const;
const SKIP_ALREADY_ATTEMPTED = "already-attempted" as const;
const SKIP_AWAITING_DROP = "awaiting-drop-or-new-turn" as const;
const SKIP_MAX_CONSECUTIVE = "max-consecutive-auto-compactions" as const;

/** Typed skip reasons so diagnostic logs and policy callers never rely on arbitrary strings. */
export type AutoCompactSkipReason =
  | typeof SKIP_DISABLED
  | typeof SKIP_INVALID_THRESHOLD
  | typeof SKIP_MISSING_USAGE
  | typeof SKIP_BELOW_THRESHOLD
  | typeof SKIP_STALE_USAGE
  | typeof SKIP_COMPACTION_TURN
  | typeof SKIP_OPEN_TOOL
  | typeof SKIP_NO_TURN
  | typeof SKIP_ALREADY_COMPACTED
  | typeof SKIP_ALREADY_ATTEMPTED
  | typeof SKIP_AWAITING_DROP
  | typeof SKIP_MAX_CONSECUTIVE;

export type AutoCompactExpectedStatus =
  | typeof ACTIVE_THREAD_STATUS
  | typeof IDLE_THREAD_STATUS;

const THRESHOLD_INT_MESSAGE =
  "Auto-compact token threshold must be a whole number." as const;
const THRESHOLD_MIN_MESSAGE =
  `Auto-compact token threshold must be at least ${AUTO_COMPACT_TOKEN_THRESHOLD_MIN} tokens.` as const;
const THRESHOLD_MAX_MESSAGE =
  `Auto-compact token threshold must be at most ${AUTO_COMPACT_TOKEN_THRESHOLD_MAX} tokens.` as const;

/** Validates persisted and user-supplied thresholds at the plugin boundary. */
export const autoCompactThresholdSchema = z
  .number()
  .int(THRESHOLD_INT_MESSAGE)
  .min(AUTO_COMPACT_TOKEN_THRESHOLD_MIN, THRESHOLD_MIN_MESSAGE)
  .max(AUTO_COMPACT_TOKEN_THRESHOLD_MAX, THRESHOLD_MAX_MESSAGE);

/** Validates the server's reported context usage payload before comparing tokens. */
export const contextUsageSchema = z.object({
  usedTokens: z.number().finite().nonnegative(),
  modelContextWindow: z.number().finite().nonnegative(),
});

/** Minimal thread fields required to gate compaction without coupling to full DTOs. */
export interface AutoCompactThreadCandidate {
  readonly id: string;
  readonly providerId: string;
  readonly status: string;
  readonly archivedAt: number | null;
  readonly deletedAt: number | null;
  readonly queuedMessageCount: number;
  readonly activeBackgroundAgentCount: number;
}

/** Validated token counts returned by `threads.context`. */
export interface ContextUsageSnapshot {
  readonly usedTokens: number;
  readonly modelContextWindow: number;
}

interface AutoCompactDecisionBaseInput {
  readonly enabled: boolean;
  readonly threshold: number;
  readonly usedTokens: number | null;
  readonly activity: RecentThreadActivity;
  readonly awaitingDropOrNewTurn: boolean;
  readonly lastAttemptedTurnSeq: number | null;
}

/**
 * Discriminates mid-turn and idle policy inputs so idle callers never pass
 * dummy circuit-breaker counts.
 */
export type AutoCompactDecisionInput =
  | (AutoCompactDecisionBaseInput & {
      readonly mode: typeof AUTO_COMPACT_MODE_MID_TURN;
      readonly consecutiveAutoCompactions: number;
    })
  | (AutoCompactDecisionBaseInput & {
      readonly mode: typeof AUTO_COMPACT_MODE_IDLE;
    });

/** Discriminates actionable compactions from typed diagnostic skip reasons. */
export type AutoCompactDecision =
  | {
      readonly action: typeof DECISION_COMPACT;
      readonly turnSeq: number;
    }
  | {
      readonly action: typeof DECISION_SKIP;
      readonly reason: AutoCompactSkipReason;
    };

/** Restricts compaction checks to live, unqueued `agy` threads in the expected lifecycle state. */
export function isEligibleAutoCompactThread(
  thread: AutoCompactThreadCandidate,
  expectedStatus: AutoCompactExpectedStatus,
): boolean {
  return (
    thread.providerId === PROVIDER_ID &&
    thread.status === expectedStatus &&
    thread.archivedAt === null &&
    thread.deletedAt === null &&
    thread.queuedMessageCount === ZERO_COUNT &&
    thread.activeBackgroundAgentCount === ZERO_COUNT
  );
}

/** Enforces compaction-turn exclusion and active-turn safety caps before threshold checks. */
function evaluateModeSkipReason(
  input: AutoCompactDecisionInput,
): AutoCompactSkipReason | null {
  if (input.activity.isCompactionTurn) {
    return SKIP_COMPACTION_TURN;
  }
  if (input.mode === AUTO_COMPACT_MODE_MID_TURN) {
    if (input.activity.hasOpenToolExecution) {
      return SKIP_OPEN_TOOL;
    }
    if (input.consecutiveAutoCompactions >= AUTO_COMPACT_MAX_CONSECUTIVE) {
      return SKIP_MAX_CONSECUTIVE;
    }
  }
  return null;
}

/** Rejects disabled, malformed, missing, or sub-threshold usage before boundary checks. */
function evaluateUsageSkipReason(
  input: AutoCompactDecisionInput,
): AutoCompactSkipReason | null {
  if (!input.enabled) {
    return SKIP_DISABLED;
  }
  if (!autoCompactThresholdSchema.safeParse(input.threshold).success) {
    return SKIP_INVALID_THRESHOLD;
  }
  if (
    input.usedTokens === null ||
    !Number.isFinite(input.usedTokens) ||
    input.usedTokens < ZERO_COUNT
  ) {
    return SKIP_MISSING_USAGE;
  }
  if (input.usedTokens < input.threshold) {
    return SKIP_BELOW_THRESHOLD;
  }
  return null;
}

/** Checks whether the latest `turn/started` belongs to a prior finished or interrupted turn. */
function isStaleMidTurnBoundary(
  activity: RecentThreadActivity,
  turnSeq: number,
): boolean {
  return (
    (activity.latestTurnCompleted !== null &&
      turnSeq <= activity.latestTurnCompleted.seq) ||
    turnSeq <= activity.latestInterruptedSeq
  );
}

/** Prevents steering stale turns, compacting stale usage, or looping on unshrinkable context. */
function evaluateBoundarySkipReason(
  input: AutoCompactDecisionInput,
  turnSeq: number,
): AutoCompactSkipReason | null {
  const { activity } = input;
  if (
    input.mode === AUTO_COMPACT_MODE_IDLE &&
    (activity.latestTurnCompleted?.status !== COMPLETED_TURN_STATUS ||
      activity.latestTurnCompleted.seq <= turnSeq ||
      activity.latestInterruptedSeq >= turnSeq ||
      activity.latestUserRequestSeq > turnSeq)
  )
    return SKIP_NO_TURN;
  if (
    input.mode === AUTO_COMPACT_MODE_MID_TURN &&
    Math.max(
      activity.latestYieldSteerSeq,
      activity.latestRejectedYieldSteerSeq,
    ) > turnSeq
  )
    return SKIP_ALREADY_ATTEMPTED;
  if (
    input.mode === AUTO_COMPACT_MODE_MID_TURN &&
    isStaleMidTurnBoundary(activity, turnSeq)
  ) {
    return SKIP_NO_TURN;
  }
  if (turnSeq <= activity.latestCompactionBoundarySeq) {
    return SKIP_ALREADY_COMPACTED;
  }
  if (
    activity.latestUsageEventSeq > ZERO_COUNT &&
    activity.latestUsageEventSeq <= activity.latestCompactionBoundarySeq
  ) {
    return SKIP_STALE_USAGE;
  }
  if (input.awaitingDropOrNewTurn) {
    return SKIP_AWAITING_DROP;
  }
  if (input.lastAttemptedTurnSeq === turnSeq) {
    return SKIP_ALREADY_ATTEMPTED;
  }
  return null;
}

/**
 * Decides whether an active turn should yield for compaction or an idle thread
 * should compact in place while enforcing tool-safety and loop invariants.
 */
export function evaluateAutoCompactDecision(
  input: AutoCompactDecisionInput,
): AutoCompactDecision {
  const preBoundarySkip =
    evaluateModeSkipReason(input) ?? evaluateUsageSkipReason(input);
  if (preBoundarySkip !== null) {
    return { action: DECISION_SKIP, reason: preBoundarySkip };
  }
  const turnSeq = input.activity.latestTurnStartedSeq;
  if (turnSeq === null) {
    return { action: DECISION_SKIP, reason: SKIP_NO_TURN };
  }
  const boundarySkip = evaluateBoundarySkipReason(input, turnSeq);
  if (boundarySkip !== null) {
    return { action: DECISION_SKIP, reason: boundarySkip };
  }
  return { action: DECISION_COMPACT, turnSeq };
}

/**
 * Confirms the steered turn itself finished cleanly after an unrejected yield
 * steer, rejecting user stops, newer prompts, newer started turns, rejected
 * steers, and mid-yield compactions so post-yield settlement never hijacks
 * naturally completed turns or double-compacts.
 */
export function canResumeAfterMidTurnYield(
  activity: RecentThreadActivity,
  yieldSteerSeq: number,
): boolean {
  if (
    activity.isCompactionTurn ||
    activity.latestCompactionBoundarySeq > yieldSteerSeq ||
    activity.latestInterruptedSeq > yieldSteerSeq ||
    activity.latestUserRequestSeq > yieldSteerSeq ||
    activity.latestRejectedYieldSteerSeq > yieldSteerSeq
  ) {
    return false;
  }
  if (
    activity.latestTurnStartedSeq !== null &&
    activity.latestTurnStartedSeq > yieldSteerSeq
  ) {
    return false;
  }
  const completed = activity.latestTurnCompleted;
  return (
    completed !== null &&
    completed.status === COMPLETED_TURN_STATUS &&
    completed.seq > yieldSteerSeq
  );
}

/**
 * Detects from persisted events that the completed idle turn ended because of
 * this plugin's unrejected mid-turn yield steer, enabling compaction and
 * continuation even after slow turns, plugin reloads, or BB server restarts.
 */
export function hasPersistedMidTurnYield(
  activity: RecentThreadActivity,
): boolean {
  const turnSeq = activity.latestTurnStartedSeq;
  return (
    turnSeq !== null &&
    activity.latestYieldSteerSeq > turnSeq &&
    canResumeAfterMidTurnYield(activity, activity.latestYieldSteerSeq)
  );
}

/** Inputs required to settle a yielded turn uniformly across RAM and persisted paths. */
export interface PostYieldDecisionInput {
  readonly activity: RecentThreadActivity;
  readonly yieldSteerSeq: number;
  readonly threshold: number | null;
  readonly usage: ContextUsageSnapshot | null;
  readonly consecutiveAutoCompactions: number;
}

/**
 * Resolves whether a yielded turn should cancel, compact-and-continue, or
 * resume directly without compacting so a plugin-initiated pause never strands
 * active work while enforcing the consecutive compaction safety cap.
 */
export function evaluatePostYieldDecision(
  input: PostYieldDecisionInput,
): PostYieldDecision {
  const { usage, threshold } = input;
  const rearmDrop =
    threshold !== null && usage !== null && usage.usedTokens < threshold;
  if (!canResumeAfterMidTurnYield(input.activity, input.yieldSteerSeq)) {
    return { action: POST_YIELD_ACTION_CANCEL, rearmDrop };
  }
  if (input.threshold === null) {
    return {
      action: POST_YIELD_ACTION_RESUME_WITHOUT_COMPACT,
      reason: YIELD_RESUME_REASON_DISABLED,
      rearmDrop,
    };
  }
  if (
    input.usage === null ||
    !Number.isFinite(input.usage.usedTokens) ||
    rearmDrop
  ) {
    return {
      action: POST_YIELD_ACTION_RESUME_WITHOUT_COMPACT,
      reason: rearmDrop
        ? YIELD_RESUME_REASON_BELOW_THRESHOLD
        : YIELD_RESUME_REASON_NO_USAGE,
      rearmDrop,
    };
  }
  if (input.consecutiveAutoCompactions >= AUTO_COMPACT_MAX_CONSECUTIVE) {
    return {
      action: POST_YIELD_ACTION_RESUME_WITHOUT_COMPACT,
      reason: YIELD_RESUME_REASON_MAX_CONSECUTIVE,
      rearmDrop,
    };
  }
  return {
    action: POST_YIELD_ACTION_COMPACT_CONTINUE,
    threshold: input.threshold,
    usage: input.usage,
  };
}

/**
 * Instructs an active `agy` turn via an agent-only steer to end cleanly at the
 * current step boundary so compaction can run and immediately resume work.
 */
export function buildMidTurnYieldPrompt(
  usedTokens: number,
  threshold: number,
): string {
  return (
    `${AUTO_COMPACT_MESSAGE_PREFIX}Context usage reached ` +
    `${usedTokens.toLocaleString(AUTO_COMPACT_TOKEN_LOCALE)} tokens ` +
    `(configured auto-compact cap: ${threshold.toLocaleString(AUTO_COMPACT_TOKEN_LOCALE)}). ` +
    "Pause right now so context can compact and automatically resume your session: " +
    "do not invoke any tools, briefly note your current step in one sentence, and end this turn immediately."
  );
}

/**
 * Instructs the agent-only continuation turn queued behind `compactFirst: true`
 * to resume work automatically after compaction without asking the user.
 */
export function buildPostCompactionResumePrompt(
  usedTokens: number,
  threshold: number,
): string {
  return (
    `${AUTO_COMPACT_MESSAGE_PREFIX}Context was automatically compacted after reaching ` +
    `${usedTokens.toLocaleString(AUTO_COMPACT_TOKEN_LOCALE)} tokens (configured cap: ${threshold.toLocaleString(AUTO_COMPACT_TOKEN_LOCALE)}). ` +
    "Continue running your in-progress task immediately from where you left off without pausing or asking to continue. " +
    "Only stop if the original request was already completely finished before compaction."
  );
}

const YIELD_RESUME_REASON_CLAUSES: Readonly<Record<YieldResumeReason, string>> =
  {
    [YIELD_RESUME_REASON_NO_USAGE]: "current context usage is unavailable",
    [YIELD_RESUME_REASON_DISABLED]:
      "auto-compaction was disabled while yielding",
    [YIELD_RESUME_REASON_BELOW_THRESHOLD]:
      "context usage is now below the configured auto-compact cap",
    [YIELD_RESUME_REASON_MAX_CONSECUTIVE]:
      "the consecutive automatic compaction safety limit for this prompt was reached",
  };

/**
 * Resumes an agent that paused for auto-compaction when compaction is skipped
 * so a plugin-initiated pause never leaves active work stopped and the model
 * receives the accurate reason for skipping compaction.
 */
export function buildYieldResumeWithoutCompactPrompt(
  reason: YieldResumeReason,
): string {
  return (
    `${AUTO_COMPACT_MESSAGE_PREFIX}Context compaction was skipped because ` +
    `${YIELD_RESUME_REASON_CLAUSES[reason]}. ` +
    "Continue running your in-progress task immediately from where you left off without pausing or asking to continue. " +
    "Only stop if the original request was already completely finished before pausing."
  );
}
