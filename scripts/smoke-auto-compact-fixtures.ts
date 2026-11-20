/**
 * Shared auto-compaction smoke fixtures so scenario files stay small and every
 * case builds events, candidates, and client stubs the same way.
 */

import type { AutoCompactorClient } from "../src/auto-compact.ts";
import {
  analyzeRecentThreadEvents,
  type RecentThreadEvent,
} from "../src/auto-compact-events.ts";
import {
  type AUTO_COMPACT_MODE_IDLE,
  AUTO_COMPACT_MODE_MID_TURN,
  type AutoCompactThreadCandidate,
  buildMidTurnYieldPrompt,
  evaluateAutoCompactDecision,
  IDLE_THREAD_STATUS,
} from "../src/auto-compact-policy.ts";
import {
  AUTO_COMPACT_AGENT_ONLY_VISIBILITY,
  AUTO_COMPACT_TEXT_BLOCK_TYPE,
  AUTO_COMPACT_TOKEN_THRESHOLD_DEFAULT,
  PROVIDER_ID,
} from "../src/constants.ts";

export const THREAD_ID_PRIMARY = "thr_smoke_1" as const;
export const THREAD_ID_SECONDARY = "thr_smoke_2" as const;
export const THREAD_ID_EVICT = "thr_smoke_3" as const;
export const LRU_CAPACITY_TWO = 2 as const;
export const COMPLETED_STATUS = "completed" as const;
export const COMPACTION_ITEM_ID = "cmp_1" as const;
export const COMPACTION_ITEM_TYPE = "contextCompaction" as const;
export const TOOL_ITEM_ID = "tool_1" as const;
export const TOOL_ITEM_TYPE = "commandExecution" as const;
export const OPEN_TOOL_SKIP_REASON = "open-tool-execution" as const;
export const COMPACTION_TURN_SKIP_REASON = "compaction-turn" as const;
export const TURN_STARTED_EVENT = "turn/started" as const;
export const TURN_COMPLETED_EVENT = "turn/completed" as const;
export const ITEM_STARTED_EVENT = "item/started" as const;
export const ITEM_COMPLETED_EVENT = "item/completed" as const;
export const USAGE_UPDATED_EVENT = "thread/contextWindowUsage/updated" as const;
export const CLIENT_TURN_REQUESTED_EVENT = "client/turn/requested" as const;
export const CLIENT_TURN_REJECTED_EVENT = "client/turn/rejected" as const;
export const INTERRUPTED_EVENT = "system/thread/interrupted" as const;
export const STEER_TARGET_KIND = "steer" as const;
export const NEW_TURN_TARGET_KIND = "new-turn" as const;
export const YIELD_REQUEST_ID = "req_yield_1" as const;

export const ABOVE_THRESHOLD_TOKENS = 260_000 as const;
export const RAISED_THRESHOLD_TOKENS = 300_000 as const;
export const MODEL_CONTEXT_WINDOW = 1_000_000 as const;
export const ABOVE_THRESHOLD_USAGE = {
  usedTokens: ABOVE_THRESHOLD_TOKENS,
  modelContextWindow: MODEL_CONTEXT_WINDOW,
} as const;
export const SEQ_TURN_START = 10 as const;
export const SEQ_TOOL_START = 11 as const;
export const SEQ_TOOL_END = 12 as const;
export const SEQ_YIELD_STEER = 13 as const;
export const SEQ_USAGE_UPDATE = 14 as const;
export const SEQ_YIELD_REJECTED = 15 as const;
export const SEQ_TURN_COMPLETE = 16 as const;
export const SEQ_INTERRUPT = 17 as const;
export const BASE_CLOCK_MS = 1_000 as const;
export const STALE_OFFSET_MS = 1_000 as const;
export const ZERO_COUNT = 0 as const;

/** Builds a realistic thread candidate so smoke cases override only id or status. */
export function makeThreadCandidate(
  id: string,
  status: string,
): AutoCompactThreadCandidate {
  return {
    id,
    providerId: PROVIDER_ID,
    status,
    archivedAt: null,
    deletedAt: null,
    queuedMessageCount: ZERO_COUNT,
    activeBackgroundAgentCount: ZERO_COUNT,
  };
}

/** Builds a persisted plugin `client/turn/requested` event for steer and non-steer checks. */
export function makePluginYieldRequestEvent(
  seq: number,
  targetKind:
    | typeof STEER_TARGET_KIND
    | typeof NEW_TURN_TARGET_KIND = STEER_TARGET_KIND,
): RecentThreadEvent {
  return {
    seq,
    type: CLIENT_TURN_REQUESTED_EVENT,
    data: {
      requestId: YIELD_REQUEST_ID,
      originPluginId: PROVIDER_ID,
      target: { kind: targetKind },
      input: [
        {
          type: AUTO_COMPACT_TEXT_BLOCK_TYPE,
          visibility: AUTO_COMPACT_AGENT_ONLY_VISIBILITY,
          text: buildMidTurnYieldPrompt(
            ABOVE_THRESHOLD_TOKENS,
            AUTO_COMPACT_TOKEN_THRESHOLD_DEFAULT,
          ),
        },
      ],
    },
  };
}

/** Builds one shared recording `AutoCompactorClient` stub for all offline coordinator cases. */
export function createSmokeCompactorClient(
  actions: string[],
  overrides: Partial<AutoCompactorClient>,
): AutoCompactorClient {
  const push = (label: string): void => {
    actions.push(label);
  };
  const pushTrue = (label: string): boolean => {
    actions.push(label);
    return true;
  };
  return {
    readActiveThreshold: async () => AUTO_COMPACT_TOKEN_THRESHOLD_DEFAULT,
    readLiveThread: async () =>
      makeThreadCandidate(THREAD_ID_PRIMARY, IDLE_THREAD_STATUS),
    readContextUsage: async () => ABOVE_THRESHOLD_USAGE,
    readRecentActivity: async () => analyzeRecentThreadEvents([]),
    sendMidTurnYield: async () => pushTrue("yield"),
    sendCompactAndContinue: async () => push("compact-continue"),
    sendResumeWithoutCompact: async (_id, reason) =>
      pushTrue(`resume-no-compact:${reason}`),
    sendIdleCompact: async () => push("idle-compact"),
    logYieldCancelled: () => push("cancelled"),
    logCheckError: () => push("error"),
    ...overrides,
  };
}

/** Builds shared above-threshold policy inputs so each smoke case varies only mode and activity. */
export function evaluateSmokePolicy(
  mode: typeof AUTO_COMPACT_MODE_MID_TURN | typeof AUTO_COMPACT_MODE_IDLE,
  activity: ReturnType<typeof analyzeRecentThreadEvents>,
) {
  const base = {
    enabled: true,
    threshold: AUTO_COMPACT_TOKEN_THRESHOLD_DEFAULT,
    usedTokens: ABOVE_THRESHOLD_TOKENS,
    activity,
    awaitingDropOrNewTurn: false,
    lastAttemptedTurnSeq: null,
  };
  return mode === AUTO_COMPACT_MODE_MID_TURN
    ? evaluateAutoCompactDecision({
        ...base,
        mode,
        consecutiveAutoCompactions: ZERO_COUNT,
      })
    : evaluateAutoCompactDecision({ ...base, mode });
}

/** Builds a tool or compaction item lifecycle event for policy boundary fixtures. */
export function makeItemEvent(
  seq: number,
  type: typeof ITEM_STARTED_EVENT | typeof ITEM_COMPLETED_EVENT,
  id: string,
  itemType: string,
): RecentThreadEvent {
  return { seq, type, data: { item: { id, type: itemType } } };
}
