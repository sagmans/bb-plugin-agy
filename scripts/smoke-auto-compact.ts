/**
 * Verifies auto-compaction event classification, pure post-yield policy, LRU
 * store recovery, and `AutoCompactor` lifecycle guarantees offline so regressions
 * in continuation, rejection handling, or reload recovery fail `npm run smoke`.
 */

import { AutoCompactor } from "../src/auto-compact.ts";
import {
  analyzeRecentThreadEvents,
  type RecentThreadEvent,
} from "../src/auto-compact-events.ts";
import {
  ACTIVE_THREAD_STATUS,
  AUTO_COMPACT_MODE_IDLE,
  AUTO_COMPACT_MODE_MID_TURN,
  buildYieldResumeWithoutCompactPrompt,
  canResumeAfterMidTurnYield,
  DECISION_COMPACT,
  hasPersistedMidTurnYield,
  IDLE_THREAD_STATUS,
  YIELD_RESUME_REASON_BELOW_THRESHOLD,
  YIELD_RESUME_REASON_DISABLED,
  YIELD_RESUME_REASON_MAX_CONSECUTIVE,
} from "../src/auto-compact-policy.ts";
import { ThreadAutoCompactStore } from "../src/auto-compact-state.ts";
import {
  AUTO_COMPACT_MAX_CONSECUTIVE,
  AUTO_COMPACT_TOKEN_THRESHOLD_DEFAULT,
  AUTO_COMPACT_YIELD_TIMEOUT_MS,
} from "../src/constants.ts";
import {
  BASE_CLOCK_MS,
  CLIENT_TURN_REJECTED_EVENT,
  COMPACTION_ITEM_ID,
  COMPACTION_ITEM_TYPE,
  COMPACTION_TURN_SKIP_REASON,
  COMPLETED_STATUS,
  createSmokeCompactorClient,
  evaluateSmokePolicy,
  INTERRUPTED_EVENT,
  ITEM_COMPLETED_EVENT,
  ITEM_STARTED_EVENT,
  LRU_CAPACITY_TWO,
  makeItemEvent,
  makePluginYieldRequestEvent,
  makeThreadCandidate,
  NEW_TURN_TARGET_KIND,
  OPEN_TOOL_SKIP_REASON,
  RAISED_THRESHOLD_TOKENS,
  SEQ_INTERRUPT,
  SEQ_TOOL_END,
  SEQ_TOOL_START,
  SEQ_TURN_COMPLETE,
  SEQ_TURN_START,
  SEQ_USAGE_UPDATE,
  SEQ_YIELD_REJECTED,
  SEQ_YIELD_STEER,
  STALE_OFFSET_MS,
  STEER_TARGET_KIND,
  THREAD_ID_EVICT,
  THREAD_ID_PRIMARY,
  THREAD_ID_SECONDARY,
  TOOL_ITEM_ID,
  TOOL_ITEM_TYPE,
  TURN_COMPLETED_EVENT,
  TURN_STARTED_EVENT,
  USAGE_UPDATED_EVENT,
  YIELD_REQUEST_ID,
  ZERO_COUNT,
} from "./smoke-auto-compact-fixtures.ts";
import { runAutoCompactRestartSmokeScenarios } from "./smoke-auto-compact-restart.ts";
import type { ExpectFn } from "./smoke-rpc-scenarios.ts";

/** Verifies mid-turn/idle policy decisions, tool guards, and interruption safety. */
function runAutoCompactPolicyScenarios(expect: ExpectFn): void {
  const usageEvent: RecentThreadEvent = {
    seq: SEQ_USAGE_UPDATE,
    type: USAGE_UPDATED_EVENT,
  };
  const turnStartEvent: RecentThreadEvent = {
    seq: SEQ_TURN_START,
    type: TURN_STARTED_EVENT,
  };
  const blockedDecision = evaluateSmokePolicy(
    AUTO_COMPACT_MODE_MID_TURN,
    analyzeRecentThreadEvents([
      usageEvent,
      makeItemEvent(
        SEQ_TOOL_START,
        ITEM_STARTED_EVENT,
        TOOL_ITEM_ID,
        TOOL_ITEM_TYPE,
      ),
      turnStartEvent,
    ]),
  );
  const skippedCompactionTurn = evaluateSmokePolicy(
    AUTO_COMPACT_MODE_IDLE,
    analyzeRecentThreadEvents([
      usageEvent,
      makeItemEvent(
        SEQ_TOOL_START,
        ITEM_STARTED_EVENT,
        COMPACTION_ITEM_ID,
        COMPACTION_ITEM_TYPE,
      ),
      turnStartEvent,
    ]),
  );
  const closedToolActivity = analyzeRecentThreadEvents([
    usageEvent,
    makeItemEvent(
      SEQ_TOOL_END,
      ITEM_COMPLETED_EVENT,
      TOOL_ITEM_ID,
      TOOL_ITEM_TYPE,
    ),
    makeItemEvent(
      SEQ_TOOL_START,
      ITEM_STARTED_EVENT,
      TOOL_ITEM_ID,
      TOOL_ITEM_TYPE,
    ),
    turnStartEvent,
  ]);
  const readyMidTurn = evaluateSmokePolicy(
    AUTO_COMPACT_MODE_MID_TURN,
    closedToolActivity,
  );
  const readyIdle = evaluateSmokePolicy(
    AUTO_COMPACT_MODE_IDLE,
    completedTurnActivity(usageEvent),
  );
  const completedYield = completedTurnActivity();
  const interruptedYield = analyzeRecentThreadEvents([
    { seq: SEQ_INTERRUPT, type: INTERRUPTED_EVENT },
    {
      seq: SEQ_TURN_COMPLETE,
      type: TURN_COMPLETED_EVENT,
      data: { status: COMPLETED_STATUS },
    },
  ]);

  expect(
    "auto-compact-tool-and-interrupt-guards",
    blockedDecision.action === "skip" &&
      blockedDecision.reason === OPEN_TOOL_SKIP_REASON &&
      skippedCompactionTurn.action === "skip" &&
      skippedCompactionTurn.reason === COMPACTION_TURN_SKIP_REASON &&
      readyMidTurn.action === DECISION_COMPACT &&
      readyIdle.action === DECISION_COMPACT &&
      canResumeAfterMidTurnYield(completedYield, SEQ_USAGE_UPDATE) &&
      !canResumeAfterMidTurnYield(interruptedYield, SEQ_USAGE_UPDATE),
    { blockedDecision, skippedCompactionTurn, readyMidTurn, readyIdle },
  );
}

/** Exercises bounded LRU eviction, stale-yield expiry, and drop re-arming. */
function verifyStoreEvictionAndRecovery(): boolean {
  const store = new ThreadAutoCompactStore(LRU_CAPACITY_TWO);
  const first = store.ensure(THREAD_ID_PRIMARY, BASE_CLOCK_MS);
  first.pendingYield = {
    steerSeq: SEQ_USAGE_UPDATE,
    startedAtMs: BASE_CLOCK_MS,
  };
  first.awaitingDropOrNewTurn = true;
  store.ensure(THREAD_ID_SECONDARY, BASE_CLOCK_MS);
  store.ensure(THREAD_ID_PRIMARY, BASE_CLOCK_MS);
  store.ensure(THREAD_ID_EVICT, BASE_CLOCK_MS);

  const expiredNow =
    BASE_CLOCK_MS + AUTO_COMPACT_YIELD_TIMEOUT_MS + STALE_OFFSET_MS;
  const yieldStillActive = store.hasPendingYield(THREAD_ID_PRIMARY, expiredNow);
  store.clearAwaitingDrop(THREAD_ID_PRIMARY);
  const primaryAfterRecovery = store.peek(THREAD_ID_PRIMARY);

  return (
    store.peek(THREAD_ID_SECONDARY) === null &&
    !yieldStillActive &&
    primaryAfterRecovery !== null &&
    primaryAfterRecovery.pendingYield === null &&
    primaryAfterRecovery.awaitingDropOrNewTurn === false
  );
}

/** Verifies `AutoCompactor` per-thread locking, deferred idle replay, and yield-resume flow. */
async function runAutoCompactLifecycleScenarios(
  expect: ExpectFn,
): Promise<void> {
  const storeHealthy = verifyStoreEvictionAndRecovery();
  const actions: string[] = [];
  let notifyYieldEntered = () => {};
  const yieldEntered = new Promise<void>((resolve) => {
    notifyYieldEntered = resolve;
  });
  let releaseYieldSend = () => {};
  let liveStatus: string = ACTIVE_THREAD_STATUS;
  let activity = analyzeRecentThreadEvents([
    { seq: SEQ_USAGE_UPDATE, type: USAGE_UPDATED_EVENT },
    { seq: SEQ_TURN_START, type: TURN_STARTED_EVENT },
  ]);

  const client = createSmokeCompactorClient(actions, {
    readLiveThread: async () =>
      makeThreadCandidate(THREAD_ID_PRIMARY, liveStatus),
    readRecentActivity: async () => activity,
    sendMidTurnYield: async () => {
      actions.push("yield");
      notifyYieldEntered();
      await new Promise<void>((resolve) => {
        releaseYieldSend = resolve;
      });
      return true;
    },
  });

  const compactor = new AutoCompactor(client, new AbortController());
  const activeRun = compactor.handleThreadEvents(
    makeThreadCandidate(THREAD_ID_PRIMARY, ACTIVE_THREAD_STATUS),
  );
  await yieldEntered;
  liveStatus = IDLE_THREAD_STATUS;
  activity = completedTurnActivity({
    seq: SEQ_USAGE_UPDATE,
    type: USAGE_UPDATED_EVENT,
  });
  const idlePrimary = makeThreadCandidate(
    THREAD_ID_PRIMARY,
    IDLE_THREAD_STATUS,
  );
  await compactor.handleThreadIdle(idlePrimary);
  // A debounced idle thread.events notification must not drop the deferred idle check.
  await compactor.handleThreadEvents(idlePrimary);
  releaseYieldSend();
  await activeRun;
  await new Promise<void>((resolve) => setTimeout(resolve, ZERO_COUNT));
  compactor.dispose();

  expect(
    "auto-compact-store-and-coordinator",
    storeHealthy &&
      JSON.stringify(actions) === JSON.stringify(["yield", "compact-continue"]),
    { storeHealthy, actions },
  );
}

/** Runs one isolated idle transition against a fresh or pre-populated store and returns recorded actions. */
async function runIdleRecoveryCase(
  activity: ReturnType<typeof analyzeRecentThreadEvents>,
  threshold: number | null = AUTO_COMPACT_TOKEN_THRESHOLD_DEFAULT,
  store?: ThreadAutoCompactStore,
): Promise<string[]> {
  const actions: string[] = [];
  const idleCandidate = makeThreadCandidate(
    THREAD_ID_SECONDARY,
    IDLE_THREAD_STATUS,
  );
  const compactor = new AutoCompactor(
    createSmokeCompactorClient(actions, {
      readActiveThreshold: async () => threshold,
      readLiveThread: async () => idleCandidate,
      readRecentActivity: async () => activity,
    }),
    new AbortController(),
    store,
  );
  await compactor.handleThreadIdle(idleCandidate);
  compactor.dispose();
  return actions;
}

/** Confirms an isolated coordinator run recorded exactly one expected action. */
function isSingleAction(actions: readonly string[], expected: string): boolean {
  return actions.length === 1 && actions[0] === expected;
}

/** Builds a completed turn event window with optional extra events between start and finish. */
function completedTurnActivity(
  ...middleEvents: RecentThreadEvent[]
): ReturnType<typeof analyzeRecentThreadEvents> {
  return analyzeRecentThreadEvents([
    {
      seq: SEQ_TURN_COMPLETE,
      type: TURN_COMPLETED_EVENT,
      data: { status: COMPLETED_STATUS },
    },
    ...middleEvents,
    { seq: SEQ_TURN_START, type: TURN_STARTED_EVENT },
  ]);
}

/** Verifies persisted yield recovery across reloads, threshold raises, disables, and caps. */
async function runAutoCompactYieldRecoveryScenarios(
  expect: ExpectFn,
): Promise<void> {
  const persistedYieldActivity = completedTurnActivity(
    { seq: SEQ_USAGE_UPDATE, type: USAGE_UPDATED_EVENT },
    makePluginYieldRequestEvent(SEQ_YIELD_STEER, STEER_TARGET_KIND),
  );
  const maxStore = new ThreadAutoCompactStore();
  maxStore.ensure(THREAD_ID_SECONDARY, Date.now()).consecutiveAutoCompactions =
    AUTO_COMPACT_MAX_CONSECUTIVE;
  const [
    reloadActions,
    lostAndRaisedActions,
    lostAndDisabledActions,
    maxConsecutiveActions,
  ] = await Promise.all([
    runIdleRecoveryCase(persistedYieldActivity),
    runIdleRecoveryCase(persistedYieldActivity, RAISED_THRESHOLD_TOKENS),
    runIdleRecoveryCase(persistedYieldActivity, null),
    runIdleRecoveryCase(
      persistedYieldActivity,
      AUTO_COMPACT_TOKEN_THRESHOLD_DEFAULT,
      maxStore,
    ),
  ]);
  const promptsAccurate = (
    [
      [YIELD_RESUME_REASON_DISABLED, "disabled"],
      [YIELD_RESUME_REASON_BELOW_THRESHOLD, "below"],
      [YIELD_RESUME_REASON_MAX_CONSECUTIVE, "safety limit"],
    ] as const
  ).every(([reason, snippet]) =>
    buildYieldResumeWithoutCompactPrompt(reason).includes(snippet),
  );

  expect(
    "auto-compact-yield-recovery-and-resume",
    hasPersistedMidTurnYield(persistedYieldActivity) &&
      promptsAccurate &&
      isSingleAction(reloadActions, "compact-continue") &&
      isSingleAction(
        lostAndRaisedActions,
        `resume-no-compact:${YIELD_RESUME_REASON_BELOW_THRESHOLD}`,
      ) &&
      isSingleAction(
        lostAndDisabledActions,
        `resume-no-compact:${YIELD_RESUME_REASON_DISABLED}`,
      ) &&
      isSingleAction(
        maxConsecutiveActions,
        `resume-no-compact:${YIELD_RESUME_REASON_MAX_CONSECUTIVE}`,
      ),
    {
      reloadActions,
      lostAndRaisedActions,
      lostAndDisabledActions,
      maxConsecutiveActions,
      promptsAccurate,
    },
  );
}

/** Verifies rejected yield steers and non-steer targets never trigger false resumes. */
async function runRejectedSteerScenarios(expect: ExpectFn): Promise<void> {
  const rejectedSteerActivity = completedTurnActivity(
    {
      seq: SEQ_YIELD_REJECTED,
      type: CLIENT_TURN_REJECTED_EVENT,
      data: { requestId: YIELD_REQUEST_ID },
    },
    { seq: SEQ_USAGE_UPDATE, type: USAGE_UPDATED_EVENT },
    makePluginYieldRequestEvent(SEQ_YIELD_STEER, STEER_TARGET_KIND),
  );
  const nonSteerTargetActivity = completedTurnActivity(
    makePluginYieldRequestEvent(SEQ_YIELD_STEER, NEW_TURN_TARGET_KIND),
  );
  const rejectedPersistedActions = await runIdleRecoveryCase(
    rejectedSteerActivity,
  );
  const ramStore = new ThreadAutoCompactStore();
  const now = Date.now();
  ramStore.ensure(THREAD_ID_SECONDARY, now).pendingYield = {
    steerSeq: SEQ_TOOL_END,
    startedAtMs: now,
  };
  const rejectedRamActions = await runIdleRecoveryCase(
    rejectedSteerActivity,
    AUTO_COMPACT_TOKEN_THRESHOLD_DEFAULT,
    ramStore,
  );

  expect(
    "auto-compact-rejected-and-non-steer-guards",
    !hasPersistedMidTurnYield(rejectedSteerActivity) &&
      !hasPersistedMidTurnYield(nonSteerTargetActivity) &&
      isSingleAction(rejectedPersistedActions, "idle-compact") &&
      isSingleAction(rejectedRamActions, "cancelled"),
    { rejectedPersistedActions, rejectedRamActions },
  );
}

/** Runs all offline auto-compaction policy, store, and recovery smoke scenarios. */
export async function runAutoCompactSmokeScenarios(
  expect: ExpectFn,
): Promise<void> {
  runAutoCompactPolicyScenarios(expect);
  await runAutoCompactLifecycleScenarios(expect);
  await runAutoCompactYieldRecoveryScenarios(expect);
  await runRejectedSteerScenarios(expect);
  await runAutoCompactRestartSmokeScenarios(expect);
}
