/**
 * Parses and merges non-delta thread event windows into deterministic turn,
 * tool, and compaction boundary summaries so threshold decisions remain pure
 * and never race live tool executions or user-initiated stops.
 */

import { z } from "zod";
import {
  AUTO_COMPACT_AGENT_ONLY_VISIBILITY,
  AUTO_COMPACT_MESSAGE_PREFIX,
  AUTO_COMPACT_TEXT_BLOCK_TYPE,
  PROVIDER_ID,
} from "./constants.ts";

const ZERO_COUNT = 0 as const;
const FIRST_EVENT_INDEX = 0 as const;
const SINGLE_BLOCK_COUNT = 1 as const;
const EMPTY_TURN_STATUS = "" as const;
const COMMAND_RESOURCE_KIND = "command" as const;
const USER_INITIATOR = "user" as const;
const COMPACT_COMMAND_NAME = "compact" as const;
const COMPACT_COMMAND_TEXT = "/compact" as const;
const COMPACTION_SKIPPED_WARNING = "compaction-skipped" as const;

/** Non-tool SDK `ThreadItem` variants safe to steer around without aborting tools. */
const REASONING_ITEM_TYPE = "reasoning" as const;
const AGENT_MESSAGE_ITEM_TYPE = "agentMessage" as const;
const USER_MESSAGE_ITEM_TYPE = "userMessage" as const;
const COMPACTION_ITEM_TYPE = "contextCompaction" as const;

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

const REQUEST_KIND_COMPACT = "compact" as const;
const REQUEST_KIND_USER = "user" as const;

type ClientRequestKind =
  | typeof REQUEST_KIND_COMPACT
  | typeof REQUEST_KIND_USER
  | null;

/**
 * Item types that represent model output, user text, or compaction rather than
 * an executing tool; steering during these avoids aborting live commands or edits.
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
 * Tool item lifecycle events queried strictly disjoint from boundary and usage
 * queries so the item window budget tracks open tools without noise.
 */
export const AUTO_COMPACT_ITEM_EVENT_TYPES = [
  ITEM_STARTED_EVENT,
  ITEM_COMPLETED_EVENT,
] as const;

/**
 * Context usage events queried in a dedicated single-row lookup so high tool
 * volume can never evict the latest usage watermark.
 */
export const AUTO_COMPACT_USAGE_EVENT_TYPES = [
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
  // Accept any string so future SDK initiators never break `/compact` parsing
  // while still failing closed on any non-`"user"` initiator.
  initiator: z.string().optional(),
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

/**
 * Combines disjoint boundary, item, and usage event windows into one
 * newest-first stream so downstream boundary analysis runs in a single pass.
 */
export function mergeRecentThreadEvents(
  ...eventWindows: ReadonlyArray<readonly RecentThreadEvent[]>
): RecentThreadEvent[] {
  const bySeq = new Map<number, RecentThreadEvent>();
  for (const window of eventWindows) {
    for (const event of window) {
      bySeq.set(event.seq, event);
    }
  }
  return Array.from(bySeq.values()).sort((left, right) => right.seq - left.seq);
}

/** Identifies standalone `/compact` commands so they never reset user-turn counters. */
function isCompactClientRequest(
  blocks: readonly z.infer<typeof clientRequestBlockSchema>[],
): boolean {
  if (blocks.length !== SINGLE_BLOCK_COUNT) {
    return false;
  }
  const [first] = blocks;
  if (first === undefined || first.type !== AUTO_COMPACT_TEXT_BLOCK_TYPE) {
    return false;
  }
  if (first.text?.trim() === COMPACT_COMMAND_TEXT) {
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
      block.type === AUTO_COMPACT_TEXT_BLOCK_TYPE &&
      block.visibility === AUTO_COMPACT_AGENT_ONLY_VISIBILITY &&
      block.text?.startsWith(AUTO_COMPACT_MESSAGE_PREFIX) === true,
  );
}

/**
 * Isolates real user prompts and `/compact` requests from plugin continuations
 * and non-user messages so only human prompts reset loop-breaker counters.
 */
function classifyClientRequest(data: unknown): ClientRequestKind {
  const parsed = clientTurnRequestedDataSchema.safeParse(data);
  if (!parsed.success) {
    return null;
  }
  const blocks = parsed.data.input ?? [];
  if (isCompactClientRequest(blocks)) {
    return REQUEST_KIND_COMPACT;
  }
  if (isPluginAutoCompactRequest(parsed.data.originPluginId, blocks)) {
    return null;
  }
  if (
    parsed.data.initiator !== undefined &&
    parsed.data.initiator !== USER_INITIATOR
  ) {
    return null;
  }
  return REQUEST_KIND_USER;
}

/**
 * Prevents steering while a tool item started in the active turn is unfinished;
 * fails closed when an `item/started` payload cannot be parsed.
 */
function inspectTurnItemEvent(
  event: RecentThreadEvent,
  completedItemIds: Set<string>,
  state: { isCompactionTurn: boolean; hasOpenToolExecution: boolean },
): void {
  const parsed = itemEventDataSchema.safeParse(event.data);
  if (!parsed.success) {
    if (event.type === ITEM_STARTED_EVENT) {
      state.hasOpenToolExecution = true;
    }
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

/**
 * Recognizes compaction, context-clear, and skipped-compaction events as
 * boundaries so unshrinkable or freshly cleared contexts cannot loop.
 */
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

/** Closes the active-turn item window once a prior `turn/completed` boundary is reached. */
function recordTurnCompleted(
  event: RecentThreadEvent,
  acc: ActivityAccumulator,
): void {
  if (acc.latestTurnCompleted === null) {
    const parsed = turnCompletedDataSchema.safeParse(event.data);
    acc.latestTurnCompleted = {
      seq: event.seq,
      status: parsed.success ? parsed.data.status : EMPTY_TURN_STATUS,
    };
  }
  acc.insideCurrentTurn = false;
}

/** Separates user prompts from manual `/compact` requests for boundary tracking. */
function recordClientRequest(
  event: RecentThreadEvent,
  acc: ActivityAccumulator,
): void {
  const kind = classifyClientRequest(event.data);
  if (kind === REQUEST_KIND_USER) {
    acc.latestUserRequestSeq = Math.max(acc.latestUserRequestSeq, event.seq);
  } else if (kind === REQUEST_KIND_COMPACT) {
    acc.latestCompactRequestSeq = Math.max(
      acc.latestCompactRequestSeq,
      event.seq,
    );
  }
}

/** Updates turn, tool, usage, and compaction watermarks from one descending event row. */
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
 * Reduces a descending (`order: "desc"`) non-delta event window into the
 * boundary facts required for safe mid-turn and post-turn compaction decisions.
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
  const latestCompactSettlementSeq = Math.max(
    acc.latestTurnCompleted?.seq ?? ZERO_COUNT,
    acc.latestCompactionBoundarySeq,
    acc.latestInterruptedSeq,
    acc.latestUserRequestSeq,
  );
  const pendingCompactRequest =
    acc.latestCompactRequestSeq > latestCompactSettlementSeq;

  return {
    latestSeq: events[FIRST_EVENT_INDEX]?.seq ?? ZERO_COUNT,
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
