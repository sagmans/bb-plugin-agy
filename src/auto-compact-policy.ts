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
  AUTO_COMPACT_TOKEN_THRESHOLD_MAX,
  AUTO_COMPACT_TOKEN_THRESHOLD_MIN,
  PROVIDER_ID,
} from "./constants.ts";

export * from "./auto-compact-events.ts";

const ACTIVE_STATUS = "active" as const;
const IDLE_STATUS = "idle" as const;
const ZERO_COUNT = 0 as const;
const TOKEN_LOCALE = "en-US" as const;
const COMPLETED_TURN_STATUS = "completed" as const;

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

/** Captures active-turn facts needed to avoid tool interruption and infinite loops. */
export interface MidTurnDecisionInput {
  readonly enabled: boolean;
  readonly threshold: number;
  readonly usedTokens: number | null;
  readonly activity: RecentThreadActivity;
  readonly awaitingDropOrNewTurn: boolean;
  readonly lastAttemptedTurnSeq: number | undefined;
  readonly consecutiveAutoCompactions: number;
}

/** Captures idle-thread facts needed for safe post-turn background compaction. */
export interface IdleDecisionInput {
  readonly enabled: boolean;
  readonly threshold: number;
  readonly usedTokens: number | null;
  readonly activity: RecentThreadActivity;
  readonly awaitingDropOrNewTurn: boolean;
  readonly lastAttemptedTurnSeq: number | undefined;
}

/** Discriminates actionable compactions from diagnostic skip reasons. */
export type AutoCompactDecision =
  | {
      readonly action: "compact";
      readonly turnSeq: number;
      readonly usedTokens: number;
    }
  | { readonly action: "skip"; readonly reason: string };

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

/** Shared live-thread guard preventing queue and subagent races. */
function isLiveUnqueuedAgyThread(
  thread: AutoCompactThreadCandidate,
  expectedStatus: string,
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

/** Restricts idle compaction to live, idle `agy` threads without queued work. */
export function isEligibleIdleAutoCompactThread(
  thread: AutoCompactThreadCandidate,
): boolean {
  return isLiveUnqueuedAgyThread(thread, IDLE_STATUS);
}

/** Restricts mid-turn checks to live, active `agy` threads without queued work. */
export function isEligibleActiveAutoCompactThread(
  thread: AutoCompactThreadCandidate,
): boolean {
  return isLiveUnqueuedAgyThread(thread, ACTIVE_STATUS);
}

type ThresholdUsageValidation =
  | { readonly ok: true; readonly usedTokens: number }
  | { readonly ok: false; readonly reason: string };

type TurnGuardValidation =
  | { readonly ok: true; readonly turnSeq: number }
  | { readonly ok: false; readonly reason: string };

/** Checks shared threshold and usage preconditions before mode-specific guards. */
function validateThresholdAndUsage(
  enabled: boolean,
  threshold: number,
  usedTokens: number | null,
): ThresholdUsageValidation {
  if (!enabled) {
    return { ok: false, reason: SKIP_DISABLED };
  }
  if (!autoCompactThresholdSchema.safeParse(threshold).success) {
    return { ok: false, reason: SKIP_INVALID_THRESHOLD };
  }
  if (
    usedTokens === null ||
    !Number.isFinite(usedTokens) ||
    usedTokens < ZERO_COUNT
  ) {
    return { ok: false, reason: SKIP_MISSING_USAGE };
  }
  if (usedTokens < threshold) {
    return { ok: false, reason: SKIP_BELOW_THRESHOLD };
  }
  return { ok: true, usedTokens };
}

/** Enforces shared turn-boundary and loop-prevention checks for both modes. */
function validateTurnCompactionGuards(
  activity: RecentThreadActivity,
  awaitingDropOrNewTurn: boolean,
  lastAttemptedTurnSeq: number | undefined,
): TurnGuardValidation {
  if (activity.latestTurnStartedSeq === null) {
    return { ok: false, reason: SKIP_NO_TURN };
  }
  if (activity.latestTurnStartedSeq <= activity.latestCompactionBoundarySeq) {
    return { ok: false, reason: SKIP_ALREADY_COMPACTED };
  }
  if (
    activity.latestUsageEventSeq > ZERO_COUNT &&
    activity.latestUsageEventSeq <= activity.latestCompactionBoundarySeq
  ) {
    return { ok: false, reason: SKIP_STALE_USAGE };
  }
  if (awaitingDropOrNewTurn) {
    return { ok: false, reason: SKIP_AWAITING_DROP };
  }
  if (lastAttemptedTurnSeq === activity.latestTurnStartedSeq) {
    return { ok: false, reason: SKIP_ALREADY_ATTEMPTED };
  }
  return { ok: true, turnSeq: activity.latestTurnStartedSeq };
}

/** Runs threshold, usage, and turn-boundary checks shared by active and idle paths. */
function evaluateBaseAutoCompactDecision(
  input: IdleDecisionInput,
): AutoCompactDecision {
  const usageCheck = validateThresholdAndUsage(
    input.enabled,
    input.threshold,
    input.usedTokens,
  );
  if (!usageCheck.ok) {
    return { action: "skip", reason: usageCheck.reason };
  }
  const guardCheck = validateTurnCompactionGuards(
    input.activity,
    input.awaitingDropOrNewTurn,
    input.lastAttemptedTurnSeq,
  );
  if (!guardCheck.ok) {
    return { action: "skip", reason: guardCheck.reason };
  }
  return {
    action: "compact",
    turnSeq: guardCheck.turnSeq,
    usedTokens: usageCheck.usedTokens,
  };
}

/**
 * Decides whether an active turn should yield for compaction and immediately
 * resume, ensuring no running tool is aborted and no loop can form.
 */
export function evaluateMidTurnAutoCompactDecision(
  input: MidTurnDecisionInput,
): AutoCompactDecision {
  if (input.activity.isCompactionTurn) {
    return { action: "skip", reason: SKIP_COMPACTION_TURN };
  }
  if (input.activity.hasOpenToolExecution) {
    return { action: "skip", reason: SKIP_OPEN_TOOL };
  }
  if (input.consecutiveAutoCompactions >= AUTO_COMPACT_MAX_CONSECUTIVE) {
    return { action: "skip", reason: SKIP_MAX_CONSECUTIVE };
  }
  return evaluateBaseAutoCompactDecision(input);
}

/**
 * Decides whether an idle thread should trigger post-turn compaction without
 * looping when compaction skips or leaves usage above the configured threshold.
 */
export function evaluateIdleAutoCompactDecision(
  input: IdleDecisionInput,
): AutoCompactDecision {
  return evaluateBaseAutoCompactDecision(input);
}

/** Confirms a steered mid-turn yield ended normally rather than by user Stop. */
export function canResumeAfterMidTurnYield(
  activity: RecentThreadActivity,
  yieldSteerSeq: number,
): boolean {
  if (activity.latestInterruptedSeq > yieldSteerSeq) {
    return false;
  }
  return (
    activity.latestTurnCompleted !== null &&
    activity.latestTurnCompleted.status === COMPLETED_TURN_STATUS
  );
}

/**
 * Builds the agent-only steer prompt that asks an active `agy` turn to yield
 * at the current step boundary so compaction can run and immediately resume.
 */
export function buildMidTurnYieldPrompt(
  usedTokens: number,
  threshold: number,
): string {
  return (
    `${AUTO_COMPACT_MESSAGE_PREFIX}Context usage reached ${usedTokens.toLocaleString(TOKEN_LOCALE)} tokens ` +
    `(configured auto-compact cap: ${threshold.toLocaleString(TOKEN_LOCALE)}). ` +
    "Pause right now so context can compact and automatically resume your session: " +
    "do not invoke any tools, briefly note your current step in one sentence, and end this turn immediately."
  );
}

/**
 * Builds the agent-only continuation prompt queued behind `compactFirst: true`
 * so the session resumes immediately after compaction without stopping.
 */
export function buildPostCompactionResumePrompt(
  usedTokens: number,
  threshold: number,
): string {
  return (
    `${AUTO_COMPACT_MESSAGE_PREFIX}Context was automatically compacted after reaching ` +
    `${usedTokens.toLocaleString(TOKEN_LOCALE)} tokens (configured cap: ${threshold.toLocaleString(TOKEN_LOCALE)}). ` +
    "Continue running your in-progress task immediately from where you left off without pausing or asking to continue. " +
    "Only stop if the original request was already completely finished before compaction."
  );
}
