/**
 * Parses and merges non-delta thread event windows into deterministic turn,
 * tool, and compaction boundary summaries so threshold decisions remain pure
 * and never race live tool executions or user-initiated stops.
 */

import { z } from "zod";
import { AUTO_COMPACT_MESSAGE_PREFIX, PROVIDER_ID } from "./constants.ts";

const ZERO_COUNT = 0 as const;
const SINGLE_BLOCK_COUNT = 1 as const;
const TEXT_BLOCK_TYPE = "text" as const;
const COMMAND_RESOURCE_KIND = "command" as const;

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

const REASONING_ITEM_TYPE = "reasoning" as const;
const AGENT_MESSAGE_ITEM_TYPE = "agentMessage" as const;
const USER_MESSAGE_ITEM_TYPE = "userMessage" as const;
const COMPACTION_ITEM_TYPE = "compaction" as const;
const COMPACTION_SKIPPED_WARNING = "compaction-skipped" as const;
const COMPACT_COMMAND_NAME = "compact" as const;
const COMPACT_COMMAND_TEXT = "/compact" as const;
const AGENT_ONLY_VISIBILITY = "agent-only" as const;

const COMPACT_REQUEST_KIND = "compact" as const;
const USER_REQUEST_KIND = "user" as const;
const IGNORED_REQUEST_KIND = "ignore" as const;

/**
 * Item types that represent model output or user text rather than an executing
 * tool; steering during these items avoids aborting live commands or edits.
 */
const NON_TOOL_ITEM_TYPES: ReadonlySet<string> = new Set([
  REASONING_ITEM_TYPE,
  AGENT_MESSAGE_ITEM_TYPE,
  USER_MESSAGE_ITEM_TYPE,
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

/** Decouples pure event-window inspection from full SDK database row types. */
export interface RecentThreadEvent {
  readonly seq: number;
  readonly type: string;
  readonly data?: unknown;
}

/** Captures sequence watermarks needed to prevent stale or duplicate triggers. */
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

interface ActivityAccumulator {
  latestTurnStartedSeq: number | null;
  latestTurnCompleted: { seq: number; status: string } | null;
  latestCompactionBoundarySeq: number;
  latestUsageEventSeq: number;
  latestUserRequestSeq: number;
  latestInterruptedSeq: number;
  latestCompactRequestSeq: number;
  insideCurrentTurn: boolean;
  isCompactionTurn: boolean;
  hasOpenToolExecution: boolean;
  readonly completedItemIds: Set<string>;
}

/** Deduplicates overlapping boundary and item queries while preserving newest-first order. */
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

/** Separates human prompts from `/compact` and plugin/malformed events to guard loop counters. */
function classifyClientRequest(
  data: unknown,
):
  | typeof COMPACT_REQUEST_KIND
  | typeof USER_REQUEST_KIND
  | typeof IGNORED_REQUEST_KIND {
  const parsed = clientTurnRequestedDataSchema.safeParse(data);
  if (!parsed.success) {
    return IGNORED_REQUEST_KIND;
  }
  const blocks = parsed.data.input ?? [];
  if (isCompactClientRequest(blocks)) {
    return COMPACT_REQUEST_KIND;
  }
  if (isPluginAutoCompactRequest(parsed.data.originPluginId, blocks)) {
    return IGNORED_REQUEST_KIND;
  }
  return USER_REQUEST_KIND;
}

/** Prevents steering while a tool item started in the active turn is still unfinished. */
function inspectTurnItemEvent(
  event: RecentThreadEvent,
  acc: ActivityAccumulator,
): void {
  const parsed = itemEventDataSchema.safeParse(event.data);
  if (!parsed.success) {
    return;
  }
  const { id, type } = parsed.data.item;
  if (type === COMPACTION_ITEM_TYPE) {
    acc.isCompactionTurn = true;
  }
  if (event.type === ITEM_COMPLETED_EVENT) {
    acc.completedItemIds.add(id);
    return;
  }
  if (!acc.completedItemIds.has(id) && !NON_TOOL_ITEM_TYPES.has(type)) {
    acc.hasOpenToolExecution = true;
  }
}

/** Treats skipped-compaction warnings as boundaries so unshrinkable contexts do not loop. */
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

/** Closes the active-turn item window once a prior `turn/completed` boundary is reached. */
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

/** Tracks user-turn resets separately from pending manual `/compact` requests. */
function recordClientRequest(
  event: RecentThreadEvent,
  acc: ActivityAccumulator,
): void {
  const kind = classifyClientRequest(event.data);
  if (kind === USER_REQUEST_KIND) {
    acc.latestUserRequestSeq = Math.max(acc.latestUserRequestSeq, event.seq);
  } else if (kind === COMPACT_REQUEST_KIND) {
    acc.latestCompactRequestSeq = Math.max(
      acc.latestCompactRequestSeq,
      event.seq,
    );
  }
}

/**
 * Stops inspecting tool items once `turn/started` or `turn/completed` is crossed
 * in descending order so items from earlier turns never block the active turn.
 */
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
        inspectTurnItemEvent(event, acc);
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
 * the boundary facts needed for safe mid-turn and post-turn decisions without
 * scanning full thread histories.
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
    isCompactionTurn: false,
    hasOpenToolExecution: false,
    completedItemIds: new Set<string>(),
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
    isCompactionTurn: acc.isCompactionTurn || pendingCompactRequest,
    hasOpenToolExecution: acc.hasOpenToolExecution,
  };
}
