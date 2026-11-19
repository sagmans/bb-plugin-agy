/**
 * Pure validation schemas, event-window analysis, and trigger decisions for
 * Antigravity (`agy`) auto-compaction. Isolating policy from SDK I/O keeps
 * mid-turn continuation, idle compaction, and loop-prevention invariants
 * independently verifiable without network or daemon state.
 */

import { z } from "zod";
import {
  AUTO_COMPACT_MAX_CONSECUTIVE,
  AUTO_COMPACT_MESSAGE_PREFIX,
  AUTO_COMPACT_TOKEN_THRESHOLD_MAX,
  AUTO_COMPACT_TOKEN_THRESHOLD_MIN,
  PROVIDER_ID,
} from "./constants.ts";

const ACTIVE_STATUS = "active" as const;
const IDLE_STATUS = "idle" as const;
const ZERO_COUNT = 0 as const;
const SINGLE_BLOCK_COUNT = 1 as const;
const TEXT_BLOCK_TYPE = "text" as const;
const COMMAND_RESOURCE_KIND = "command" as const;
const TOKEN_LOCALE = "en-US" as const;

const TURN_STARTED_EVENT = "turn/started" as const;
const TURN_COMPLETED_EVENT = "turn/completed" as const;
const ITEM_STARTED_EVENT = "item/started" as const;
const ITEM_COMPLETED_EVENT = "item/completed" as const;
const THREAD_COMPACTED_EVENT = "thread/compacted" as const;
const THREAD_CONTEXT_CLEARED_EVENT = "thread/context/cleared" as const;
const CONTEXT_USAGE_UPDATED_EVENT =
  "thread/contextWindowUsage/updated" as const;
const CLIENT_TURN_REQUESTED_EVENT = "client/turn/requested" as const;
const THREAD_INTERRUPTED_EVENT = "system/thread/interrupted" as const;
const PROVIDER_WARNING_EVENT = "provider/warning" as const;

const COMPACTION_ITEM_TYPE = "compaction" as const;
const COMPACTION_SKIPPED_WARNING = "compaction-skipped" as const;
const COMPACT_COMMAND_NAME = "compact" as const;
const COMPACT_COMMAND_TEXT = "/compact" as const;
const COMPLETED_TURN_STATUS = "completed" as const;
const AGENT_ONLY_VISIBILITY = "agent-only" as const;

/**
 * Item types that represent model output or user text rather than an executing
 * tool; steering during these items avoids aborting live commands or edits.
 */
const NON_TOOL_ITEM_TYPES: ReadonlySet<string> = new Set([
  "reasoning",
  "agentMessage",
  "userMessage",
  COMPACTION_ITEM_TYPE,
]);

/**
 * Turn and compaction lifecycle events queried independently from high-volume
 * item events so `turn/started` never ages out on long multi-tool turns.
 */
export const AUTO_COMPACT_BOUNDARY_EVENT_TYPES = [
  TURN_STARTED_EVENT,
  TURN_COMPLETED_EVENT,
  THREAD_COMPACTED_EVENT,
  THREAD_CONTEXT_CLEARED_EVENT,
  CLIENT_TURN_REQUESTED_EVENT,
  THREAD_INTERRUPTED_EVENT,
  PROVIDER_WARNING_EVENT,
] as const;

/**
 * Recent item and usage events queried to detect open tool calls and confirm
 * context usage is strictly newer than the last compaction boundary.
 */
export const AUTO_COMPACT_ITEM_EVENT_TYPES = [
  TURN_STARTED_EVENT,
  TURN_COMPLETED_EVENT,
  ITEM_STARTED_EVENT,
  ITEM_COMPLETED_EVENT,
  CONTEXT_USAGE_UPDATED_EVENT,
] as const;

/** Merges boundary and item query windows into one descending, deduplicated stream. */
export function mergeRecentThreadEvents(
  boundaryEvents: readonly RecentThreadEvent[],
  itemEvents: readonly RecentThreadEvent[],
): RecentThreadEvent[] {
  const bySeq = new Map<number, RecentThreadEvent>();
  for (const event of boundaryEvents) {
    bySeq.set(event.seq, event);
  }
  for (const event of itemEvents) {
    bySeq.set(event.seq, event);
  }
  return Array.from(bySeq.values()).sort((left, right) => right.seq - left.seq);
}

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

const itemEventDataSchema = z.object({
  item: z.object({
    id: z.string(),
    type: z.string(),
  }),
});

const turnCompletedDataSchema = z.object({
  status: z.string(),
});

const warningDataSchema = z.object({
  category: z.string(),
});

const clientRequestBlockSchema = z.object({
  type: z.string(),
  text: z.string().optional(),
  visibility: z.string().optional(),
  mentions: z
    .array(
      z.object({
        resource: z.object({
          kind: z.string(),
          name: z.string().optional(),
        }),
      }),
    )
    .optional(),
});

const clientTurnRequestedDataSchema = z.object({
  input: z.array(clientRequestBlockSchema).optional(),
  originPluginId: z.string().nullable().optional(),
});

/** Subset of a thread DTO needed to decide compaction eligibility. */
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

/** Structural subset of `ThreadEventRow` needed for pure event inspection. */
export interface RecentThreadEvent {
  readonly seq: number;
  readonly type: string;
  readonly data?: unknown;
}

/** Summary extracted from the latest non-delta events of a thread. */
export interface RecentThreadActivity {
  readonly latestSeq: number;
  readonly latestTurnStartedSeq: number | null;
  readonly latestTurnCompleted: {
    readonly seq: number;
    readonly status: string;
  } | null;
  readonly latestCompactionBoundarySeq: number;
  readonly latestUsageEventSeq: number;
  readonly latestUserRequestSeq: number;
  readonly latestInterruptedSeq: number;
  readonly isCompactionTurn: boolean;
  readonly hasOpenToolExecution: boolean;
}

/** Inputs to the pure mid-turn compaction decision. */
export interface MidTurnDecisionInput {
  readonly enabled: boolean;
  readonly threshold: number;
  readonly usedTokens: number | null;
  readonly activity: RecentThreadActivity;
  readonly awaitingDropOrNewTurn: boolean;
  readonly lastAttemptedTurnSeq: number | undefined;
  readonly consecutiveAutoCompactions: number;
}

/** Inputs to the pure idle post-turn compaction decision. */
export interface IdleDecisionInput {
  readonly enabled: boolean;
  readonly threshold: number;
  readonly usedTokens: number | null;
  readonly activity: RecentThreadActivity;
  readonly awaitingDropOrNewTurn: boolean;
  readonly lastAttemptedTurnSeq: number | undefined;
}

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

/** Detects standalone `/compact` client requests so they never reset user-turn counters. */
function isCompactClientRequest(
  blocks: readonly z.infer<typeof clientRequestBlockSchema>[],
): boolean {
  if (blocks.length !== SINGLE_BLOCK_COUNT) {
    return false;
  }
  const [first] = blocks;
  if (first === undefined || first.type !== TEXT_BLOCK_TYPE) {
    return false;
  }
  if ((first.text ?? "").trim() === COMPACT_COMMAND_TEXT) {
    return true;
  }
  return (first.mentions ?? []).some(
    (mention) =>
      mention.resource.kind === COMMAND_RESOURCE_KIND &&
      mention.resource.name === COMPACT_COMMAND_NAME,
  );
}

/** Identifies plugin-authored yield and resume prompts so they do not look like new user tasks. */
function isPluginAutoCompactRequest(
  originPluginId: string | null | undefined,
  blocks: readonly z.infer<typeof clientRequestBlockSchema>[],
): boolean {
  if (originPluginId === PROVIDER_ID) {
    return true;
  }
  return blocks.some(
    (block) =>
      block.type === TEXT_BLOCK_TYPE &&
      block.visibility === AGENT_ONLY_VISIBILITY &&
      (block.text ?? "").startsWith(AUTO_COMPACT_MESSAGE_PREFIX),
  );
}

/** Classifies a `client/turn/requested` payload into compact, plugin, or user origin. */
function classifyClientRequest(
  data: unknown,
): "compact" | "plugin" | "user" | "unknown" {
  const parsed = clientTurnRequestedDataSchema.safeParse(data);
  if (!parsed.success) {
    return "unknown";
  }
  const blocks = parsed.data.input ?? [];
  if (isCompactClientRequest(blocks)) {
    return "compact";
  }
  if (isPluginAutoCompactRequest(parsed.data.originPluginId, blocks)) {
    return "plugin";
  }
  return "user";
}

/** Tracks per-item open/completed state within the current active turn. */
function inspectTurnItemEvent(
  event: RecentThreadEvent,
  completedItemIds: Set<string>,
  state: { isCompactionTurn: boolean; hasOpenToolExecution: boolean },
): void {
  const parsed = itemEventDataSchema.safeParse(event.data);
  if (!parsed.success) {
    return;
  }
  const { id, type } = parsed.data.item;
  if (type === COMPACTION_ITEM_TYPE) {
    state.isCompactionTurn = true;
  }
  if (event.type === ITEM_COMPLETED_EVENT) {
    completedItemIds.add(id);
    return;
  }
  if (!completedItemIds.has(id) && !NON_TOOL_ITEM_TYPES.has(type)) {
    state.hasOpenToolExecution = true;
  }
}

/** Updates compaction-boundary sequence for compacted, cleared, or skipped-warning events. */
function isCompactionBoundaryEvent(event: RecentThreadEvent): boolean {
  if (
    event.type === THREAD_COMPACTED_EVENT ||
    event.type === THREAD_CONTEXT_CLEARED_EVENT
  ) {
    return true;
  }
  if (event.type !== PROVIDER_WARNING_EVENT) {
    return false;
  }
  const parsed = warningDataSchema.safeParse(event.data);
  return parsed.success && parsed.data.category === COMPACTION_SKIPPED_WARNING;
}

interface ActivityAccumulator {
  latestTurnStartedSeq: number | null;
  latestTurnCompleted: { seq: number; status: string } | null;
  latestCompactionBoundarySeq: number;
  latestUsageEventSeq: number;
  latestUserRequestSeq: number;
  latestInterruptedSeq: number;
  latestCompactRequestSeq: number;
  insideCurrentTurn: boolean;
  readonly completedItemIds: Set<string>;
  readonly turnItems: {
    isCompactionTurn: boolean;
    hasOpenToolExecution: boolean;
  };
}

/** Records a `turn/completed` row once per descending scan and closes the current turn window. */
function recordTurnCompleted(
  event: RecentThreadEvent,
  acc: ActivityAccumulator,
): void {
  if (acc.latestTurnCompleted === null) {
    const parsed = turnCompletedDataSchema.safeParse(event.data);
    acc.latestTurnCompleted = {
      seq: event.seq,
      status: parsed.success ? parsed.data.status : "",
    };
  }
  acc.insideCurrentTurn = false;
}

/** Records a `client/turn/requested` row under user or compact origin buckets. */
function recordClientRequest(
  event: RecentThreadEvent,
  acc: ActivityAccumulator,
): void {
  const kind = classifyClientRequest(event.data);
  if (kind === "user") {
    acc.latestUserRequestSeq = Math.max(acc.latestUserRequestSeq, event.seq);
  } else if (kind === "compact") {
    acc.latestCompactRequestSeq = Math.max(
      acc.latestCompactRequestSeq,
      event.seq,
    );
  }
}

/** Incorporates one event from the descending window into the activity summary. */
function recordRecentEvent(
  event: RecentThreadEvent,
  acc: ActivityAccumulator,
): void {
  if (isCompactionBoundaryEvent(event)) {
    acc.latestCompactionBoundarySeq = Math.max(
      acc.latestCompactionBoundarySeq,
      event.seq,
    );
  }
  switch (event.type) {
    case TURN_STARTED_EVENT:
      acc.latestTurnStartedSeq ??= event.seq;
      acc.insideCurrentTurn = false;
      return;
    case TURN_COMPLETED_EVENT:
      recordTurnCompleted(event, acc);
      return;
    case ITEM_STARTED_EVENT:
    case ITEM_COMPLETED_EVENT:
      if (acc.insideCurrentTurn) {
        inspectTurnItemEvent(event, acc.completedItemIds, acc.turnItems);
      }
      return;
    case CONTEXT_USAGE_UPDATED_EVENT:
      acc.latestUsageEventSeq = Math.max(acc.latestUsageEventSeq, event.seq);
      return;
    case THREAD_INTERRUPTED_EVENT:
      acc.latestInterruptedSeq = Math.max(acc.latestInterruptedSeq, event.seq);
      return;
    case CLIENT_TURN_REQUESTED_EVENT:
      recordClientRequest(event, acc);
      return;
    default:
      return;
  }
}

/**
 * Summarizes a descending (`order: "desc"`) window of non-delta events into
 * the boundary facts needed for safe mid-turn and post-turn decisions.
 */
export function analyzeRecentThreadEvents(
  events: readonly RecentThreadEvent[],
): RecentThreadActivity {
  const acc: ActivityAccumulator = {
    latestTurnStartedSeq: null,
    latestTurnCompleted: null,
    latestCompactionBoundarySeq: ZERO_COUNT,
    latestUsageEventSeq: ZERO_COUNT,
    latestUserRequestSeq: ZERO_COUNT,
    latestInterruptedSeq: ZERO_COUNT,
    latestCompactRequestSeq: ZERO_COUNT,
    insideCurrentTurn: true,
    completedItemIds: new Set<string>(),
    turnItems: { isCompactionTurn: false, hasOpenToolExecution: false },
  };
  for (const event of events) {
    recordRecentEvent(event, acc);
  }
  const pendingCompactRequest =
    acc.latestCompactRequestSeq > (acc.latestTurnCompleted?.seq ?? ZERO_COUNT);

  return {
    latestSeq: events[0]?.seq ?? ZERO_COUNT,
    latestTurnStartedSeq: acc.latestTurnStartedSeq,
    latestTurnCompleted: acc.latestTurnCompleted,
    latestCompactionBoundarySeq: acc.latestCompactionBoundarySeq,
    latestUsageEventSeq: acc.latestUsageEventSeq,
    latestUserRequestSeq: acc.latestUserRequestSeq,
    latestInterruptedSeq: acc.latestInterruptedSeq,
    isCompactionTurn: acc.turnItems.isCompactionTurn || pendingCompactRequest,
    hasOpenToolExecution: acc.turnItems.hasOpenToolExecution,
  };
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
