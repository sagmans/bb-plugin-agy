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
const STEER_TARGET_KIND = "steer" as const;
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
const CLIENT_TURN_REJECTED_EVENT = "client/turn/rejected" as const;
const THREAD_INTERRUPTED_EVENT = "system/thread/interrupted" as const;
const PROVIDER_WARNING_EVENT = "provider/warning" as const;

const REQUEST_KIND_COMPACT = "compact" as const;
const REQUEST_KIND_YIELD_STEER = "yield-steer" as const;
const REQUEST_KIND_USER = "user" as const;

type ClientRequestKind =
  | typeof REQUEST_KIND_COMPACT
  | typeof REQUEST_KIND_YIELD_STEER
  | typeof REQUEST_KIND_USER
  | null;

interface ClassifiedClientRequest {
  readonly kind: ClientRequestKind;
  readonly requestId: string | undefined;
}

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
  CLIENT_TURN_REJECTED_EVENT,
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
  requestId: z.string().optional(),
  // Accept any string so future SDK initiators never break `/compact` parsing
  // while still failing closed on any non-`"user"` initiator.
  initiator: z.string().optional(),
  target: z
    .object({
      kind: z.string(),
    })
    .optional(),
  input: z.array(clientRequestBlockSchema).optional(),
  originPluginId: z.string().nullable().optional(),
});

const clientTurnRejectedDataSchema = z.object({
  requestId: z.string(),
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
  readonly latestYieldSteerSeq: number;
  /** Malformed rejections also cancel recovery when their target cannot be established. */
  readonly latestRejectedYieldSteerSeq: number;
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

/** Matches plugin-authored agent-only control blocks without coupling to full prose. */
function hasAgentOnlyTextPrefix(
  blocks: readonly z.infer<typeof clientRequestBlockSchema>[],
): boolean {
  return blocks.some(
    (block) =>
      block.type === AUTO_COMPACT_TEXT_BLOCK_TYPE &&
      block.visibility === AUTO_COMPACT_AGENT_ONLY_VISIBILITY &&
      block.text?.startsWith(AUTO_COMPACT_MESSAGE_PREFIX) === true,
  );
}

/**
 * Isolates real user prompts, `/compact` requests, and protocol-level plugin
 * yield steers (`originPluginId` + `target.kind === "steer"` + agent-only prefix)
 * from continuations so only human prompts reset loop counters and non-steer
 * turns never trigger yield recovery.
 */
function classifyClientRequest(data: unknown): ClassifiedClientRequest {
  const parsed = clientTurnRequestedDataSchema.safeParse(data);
  if (!parsed.success) {
    return { kind: null, requestId: undefined };
  }
  const { requestId, originPluginId, target, initiator } = parsed.data;
  const blocks = parsed.data.input ?? [];
  if (isCompactClientRequest(blocks)) {
    return { kind: REQUEST_KIND_COMPACT, requestId };
  }
  if (originPluginId === PROVIDER_ID) {
    const isYieldSteer =
      target?.kind === STEER_TARGET_KIND && hasAgentOnlyTextPrefix(blocks);
    return {
      kind: isYieldSteer ? REQUEST_KIND_YIELD_STEER : null,
      requestId,
    };
  }
  if (hasAgentOnlyTextPrefix(blocks)) {
    return { kind: null, requestId };
  }
  if (initiator !== undefined && initiator !== USER_INITIATOR) {
    return { kind: null, requestId };
  }
  return { kind: REQUEST_KIND_USER, requestId };
}

/**
 * Prevents steering while a tool item started in the active turn is unfinished;
 * fails closed when an `item/started` payload cannot be parsed.
 */
function inspectTurnItemEvent(
  event: RecentThreadEvent,
  acc: ActivityAccumulator,
): void {
  const parsed = itemEventDataSchema.safeParse(event.data);
  if (!parsed.success) {
    if (event.type === ITEM_STARTED_EVENT) {
      acc.hasOpenToolExecution = true;
    }
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
  latestYieldSteerSeq: number;
  latestRejectedYieldSteerSeq: number;
  latestInterruptedSeq: number;
  latestCompactRequestSeq: number;
  insideCurrentTurn: boolean;
  isCompactionTurn: boolean;
  hasOpenToolExecution: boolean;
  readonly completedItemIds: Set<string>;
  readonly rejectedRequestIds: Set<string>;
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

/**
 * Separates user prompts, manual `/compact` requests, and unrejected plugin
 * yield steers so only human prompts reset loop counters and rejected steers
 * never falsely trigger post-yield resumption.
 */
function recordClientRequest(
  event: RecentThreadEvent,
  acc: ActivityAccumulator,
): void {
  const { kind, requestId } = classifyClientRequest(event.data);
  if (kind === REQUEST_KIND_USER) {
    acc.latestUserRequestSeq = Math.max(acc.latestUserRequestSeq, event.seq);
  } else if (kind === REQUEST_KIND_COMPACT) {
    acc.latestCompactRequestSeq = Math.max(
      acc.latestCompactRequestSeq,
      event.seq,
    );
  } else if (kind === REQUEST_KIND_YIELD_STEER) {
    if (requestId !== undefined && acc.rejectedRequestIds.has(requestId)) {
      acc.latestRejectedYieldSteerSeq = Math.max(
        acc.latestRejectedYieldSteerSeq,
        event.seq,
      );
      return;
    }
    acc.latestYieldSteerSeq = Math.max(acc.latestYieldSteerSeq, event.seq);
  }
}

/**
 * Records rejected turn request ids in descending order so a rejected mid-turn
 * yield steer is excluded before its older `client/turn/requested` row is read;
 * malformed rejections fail closed against pending yields.
 */
function recordClientRejected(
  event: RecentThreadEvent,
  acc: ActivityAccumulator,
): void {
  const parsed = clientTurnRejectedDataSchema.safeParse(event.data);
  if (parsed.success) {
    acc.rejectedRequestIds.add(parsed.data.requestId);
    return;
  }
  acc.latestRejectedYieldSteerSeq = Math.max(
    acc.latestRejectedYieldSteerSeq,
    event.seq,
  );
}

/**
 * Stops active-turn tool inspection once descending traversal crosses a turn
 * boundary while keeping boundary, usage, and request watermarks current.
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
    case CLIENT_TURN_REJECTED_EVENT:
      recordClientRejected(event, acc);
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
    latestYieldSteerSeq: ZERO_COUNT,
    latestRejectedYieldSteerSeq: ZERO_COUNT,
    latestInterruptedSeq: ZERO_COUNT,
    latestCompactRequestSeq: ZERO_COUNT,
    insideCurrentTurn: true,
    isCompactionTurn: false,
    hasOpenToolExecution: false,
    completedItemIds: new Set<string>(),
    rejectedRequestIds: new Set<string>(),
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
    latestYieldSteerSeq: acc.latestYieldSteerSeq,
    latestRejectedYieldSteerSeq: acc.latestRejectedYieldSteerSeq,
    latestInterruptedSeq: acc.latestInterruptedSeq,
    isCompactionTurn: acc.isCompactionTurn || pendingCompactRequest,
    hasOpenToolExecution: acc.hasOpenToolExecution,
  };
}
