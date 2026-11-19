/**
 * Aggregates dialect/RPC, auto-compaction policy/store/coordinator, manifest id,
 * and SVG-to-spec parity checks so `npm run smoke` verifies cross-bundle
 * invariants offline.
 */

import { readFile } from "node:fs/promises";
import { z } from "zod";
import {
  AutoCompactor,
  type AutoCompactorClient,
} from "../src/auto-compact.ts";
import { analyzeRecentThreadEvents } from "../src/auto-compact-events.ts";
import {
  AUTO_COMPACT_MODE_IDLE,
  AUTO_COMPACT_MODE_MID_TURN,
  type AutoCompactThreadCandidate,
  canResumeAfterMidTurnYield,
  DECISION_COMPACT,
  evaluateAutoCompactDecision,
} from "../src/auto-compact-policy.ts";
import { ThreadAutoCompactStore } from "../src/auto-compact-state.ts";
import {
  AUTO_COMPACT_TOKEN_THRESHOLD_DEFAULT,
  AUTO_COMPACT_YIELD_TIMEOUT_MS,
  DECLARED_PLUGIN_ICON_NAME,
  ICON_NAME,
  PROVIDER_ID,
} from "../src/constants.ts";
import {
  ANTIGRAVITY_ARCH_PATH,
  ANTIGRAVITY_BASE_BLUE,
  ANTIGRAVITY_CROWN_RIGHT_GRADIENT,
  ANTIGRAVITY_LEFT_SHOULDER_GRADIENT,
  ANTIGRAVITY_VIEWBOX,
  type RadialGradientSpec,
} from "../src/icon-spec.ts";
import {
  type ExpectFn,
  runRpcAndDialectSmokeScenarios,
} from "./smoke-rpc-scenarios.ts";

const PACKAGE_JSON_URL = new URL("../package.json", import.meta.url);
const MASK_SVG_URL = new URL("../icons/antigravity.svg", import.meta.url);
const LOGO_SVG_URL = new URL("../icons/antigravity-logo.svg", import.meta.url);
const UTF8_ENCODING = "utf8" as const;
const PACKAGE_NAME_PREFIX = "bb-plugin-" as const;

const THREAD_ID_PRIMARY = "thr_smoke_1" as const;
const THREAD_ID_SECONDARY = "thr_smoke_2" as const;
const THREAD_ID_EVICT = "thr_smoke_3" as const;
const LRU_CAPACITY_TWO = 2 as const;
const ACTIVE_STATUS = "active" as const;
const IDLE_STATUS = "idle" as const;
const COMPLETED_STATUS = "completed" as const;
const COMPACTION_ITEM_ID = "cmp_1" as const;
const COMPACTION_ITEM_TYPE = "contextCompaction" as const;
const TOOL_ITEM_ID = "tool_1" as const;
const TOOL_ITEM_TYPE = "commandExecution" as const;
const OPEN_TOOL_SKIP_REASON = "open-tool-execution" as const;
const COMPACTION_TURN_SKIP_REASON = "compaction-turn" as const;
const TURN_STARTED_EVENT = "turn/started" as const;
const TURN_COMPLETED_EVENT = "turn/completed" as const;
const ITEM_STARTED_EVENT = "item/started" as const;
const ITEM_COMPLETED_EVENT = "item/completed" as const;
const USAGE_UPDATED_EVENT = "thread/contextWindowUsage/updated" as const;
const INTERRUPTED_EVENT = "system/thread/interrupted" as const;

const ABOVE_THRESHOLD_TOKENS = 260_000 as const;
const MODEL_CONTEXT_WINDOW = 1_000_000 as const;
const SEQ_TURN_START = 10 as const;
const SEQ_TOOL_START = 11 as const;
const SEQ_TOOL_END = 12 as const;
const SEQ_USAGE_UPDATE = 13 as const;
const SEQ_TURN_COMPLETE = 14 as const;
const SEQ_INTERRUPT = 15 as const;
const BASE_CLOCK_MS = 1_000 as const;
const STALE_OFFSET_MS = 1_000 as const;
const ZERO_COUNT = 0 as const;

const manifestSchema = z.object({
  name: z.string(),
  bb: z.object({
    experimental_providers: z.array(z.object({ id: z.string() })),
    branding: z.object({
      experimental_icons: z.record(z.string(), z.string()),
    }),
  }),
});

/** Builds shared above-threshold policy inputs so each smoke case varies only mode and activity. */
function evaluateSmokePolicy(
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

/** Verifies mid-turn/idle policy decisions, tool guards, and interruption safety. */
function runAutoCompactPolicyScenarios(expect: ExpectFn): void {
  const openToolActivity = analyzeRecentThreadEvents([
    { seq: SEQ_USAGE_UPDATE, type: USAGE_UPDATED_EVENT },
    {
      seq: SEQ_TOOL_START,
      type: ITEM_STARTED_EVENT,
      data: { item: { id: TOOL_ITEM_ID, type: TOOL_ITEM_TYPE } },
    },
    { seq: SEQ_TURN_START, type: TURN_STARTED_EVENT },
  ]);
  const blockedDecision = evaluateSmokePolicy(
    AUTO_COMPACT_MODE_MID_TURN,
    openToolActivity,
  );

  const compactionTurnActivity = analyzeRecentThreadEvents([
    { seq: SEQ_USAGE_UPDATE, type: USAGE_UPDATED_EVENT },
    {
      seq: SEQ_TOOL_START,
      type: ITEM_STARTED_EVENT,
      data: { item: { id: COMPACTION_ITEM_ID, type: COMPACTION_ITEM_TYPE } },
    },
    { seq: SEQ_TURN_START, type: TURN_STARTED_EVENT },
  ]);
  const skippedCompactionTurn = evaluateSmokePolicy(
    AUTO_COMPACT_MODE_IDLE,
    compactionTurnActivity,
  );

  const closedToolActivity = analyzeRecentThreadEvents([
    { seq: SEQ_USAGE_UPDATE, type: USAGE_UPDATED_EVENT },
    {
      seq: SEQ_TOOL_END,
      type: ITEM_COMPLETED_EVENT,
      data: { item: { id: TOOL_ITEM_ID, type: TOOL_ITEM_TYPE } },
    },
    {
      seq: SEQ_TOOL_START,
      type: ITEM_STARTED_EVENT,
      data: { item: { id: TOOL_ITEM_ID, type: TOOL_ITEM_TYPE } },
    },
    { seq: SEQ_TURN_START, type: TURN_STARTED_EVENT },
  ]);
  const readyMidTurn = evaluateSmokePolicy(
    AUTO_COMPACT_MODE_MID_TURN,
    closedToolActivity,
  );
  const readyIdle = evaluateSmokePolicy(
    AUTO_COMPACT_MODE_IDLE,
    closedToolActivity,
  );

  const completedYield = analyzeRecentThreadEvents([
    {
      seq: SEQ_TURN_COMPLETE,
      type: TURN_COMPLETED_EVENT,
      data: { status: COMPLETED_STATUS },
    },
    { seq: SEQ_TURN_START, type: TURN_STARTED_EVENT },
  ]);
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
    usage: {
      usedTokens: ABOVE_THRESHOLD_TOKENS,
      modelContextWindow: MODEL_CONTEXT_WINDOW,
    },
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
  const baseCandidate: Omit<AutoCompactThreadCandidate, "status"> = {
    id: THREAD_ID_PRIMARY,
    providerId: PROVIDER_ID,
    archivedAt: null,
    deletedAt: null,
    queuedMessageCount: ZERO_COUNT,
    activeBackgroundAgentCount: ZERO_COUNT,
  };
  let liveStatus: string = ACTIVE_STATUS;
  let activity = analyzeRecentThreadEvents([
    { seq: SEQ_USAGE_UPDATE, type: USAGE_UPDATED_EVENT },
    { seq: SEQ_TURN_START, type: TURN_STARTED_EVENT },
  ]);

  const client: AutoCompactorClient = {
    readActiveThreshold: async () => AUTO_COMPACT_TOKEN_THRESHOLD_DEFAULT,
    readLiveThread: async () => ({ ...baseCandidate, status: liveStatus }),
    readContextUsage: async () => ({
      usedTokens: ABOVE_THRESHOLD_TOKENS,
      modelContextWindow: MODEL_CONTEXT_WINDOW,
    }),
    readRecentActivity: async () => activity,
    sendMidTurnYield: async () => {
      actions.push("yield");
      notifyYieldEntered();
      await new Promise<void>((resolve) => {
        releaseYieldSend = resolve;
      });
      return true;
    },
    sendCompactAndContinue: async () => {
      actions.push("resume");
    },
    sendIdleCompact: async () => {
      actions.push("idle-compact");
    },
    logYieldCancelled: () => {},
    logCheckError: () => {},
  };

  const compactor = new AutoCompactor(client, new AbortController());
  const activeRun = compactor.handleThreadEvents({
    ...baseCandidate,
    status: ACTIVE_STATUS,
  });
  await yieldEntered;
  liveStatus = IDLE_STATUS;
  activity = analyzeRecentThreadEvents([
    {
      seq: SEQ_TURN_COMPLETE,
      type: TURN_COMPLETED_EVENT,
      data: { status: COMPLETED_STATUS },
    },
    { seq: SEQ_USAGE_UPDATE, type: USAGE_UPDATED_EVENT },
    { seq: SEQ_TURN_START, type: TURN_STARTED_EVENT },
  ]);
  await compactor.handleThreadIdle({ ...baseCandidate, status: IDLE_STATUS });
  // A debounced idle thread.events notification must not drop the deferred idle check.
  await compactor.handleThreadEvents({ ...baseCandidate, status: IDLE_STATUS });
  releaseYieldSend();
  await activeRun;
  await new Promise<void>((resolve) => setTimeout(resolve, ZERO_COUNT));
  compactor.dispose();

  expect(
    "auto-compact-store-and-coordinator",
    storeHealthy &&
      JSON.stringify(actions) === JSON.stringify(["yield", "resume"]),
    { storeHealthy, actions },
  );
}

/** Confirms every gradient coordinate and color stop in `icon-spec.ts` appears in the SVG asset. */
function svgMatchesGradientSpec(
  svg: string,
  spec: RadialGradientSpec,
): boolean {
  const hasGeometry =
    svg.includes(`cx="${spec.cx}"`) &&
    svg.includes(`cy="${spec.cy}"`) &&
    svg.includes(`r="${spec.r}"`);
  const hasStops = spec.stops.every(
    (stop) =>
      svg.includes(`offset="${stop.offset}"`) &&
      svg.includes(`stop-color="${stop.stopColor}"`) &&
      svg.includes(`stop-opacity="${String(stop.stopOpacity)}"`),
  );
  return hasGeometry && hasStops;
}

/** Verifies manifest identifiers and SVG geometry/gradient parity with `src/icon-spec.ts`. */
async function runManifestAndSvgParity(expect: ExpectFn): Promise<void> {
  const [manifestRaw, maskSvg, logoSvg] = await Promise.all([
    readFile(PACKAGE_JSON_URL, UTF8_ENCODING),
    readFile(MASK_SVG_URL, UTF8_ENCODING),
    readFile(LOGO_SVG_URL, UTF8_ENCODING),
  ]);
  const manifest = manifestSchema.parse(JSON.parse(manifestRaw));

  expect(
    "manifest-ids",
    manifest.name === `${PACKAGE_NAME_PREFIX}${PROVIDER_ID}` &&
      DECLARED_PLUGIN_ICON_NAME === `${PROVIDER_ID}/${ICON_NAME}` &&
      manifest.bb.experimental_providers.some((p) => p.id === PROVIDER_ID) &&
      ICON_NAME in manifest.bb.branding.experimental_icons,
    {
      name: manifest.name,
      declaredIcon: DECLARED_PLUGIN_ICON_NAME,
      providers: manifest.bb.experimental_providers.map((p) => p.id),
      icons: Object.keys(manifest.bb.branding.experimental_icons),
    },
  );

  const svgAligned =
    maskSvg.includes(`viewBox="${ANTIGRAVITY_VIEWBOX}"`) &&
    maskSvg.includes(ANTIGRAVITY_ARCH_PATH) &&
    logoSvg.includes(`viewBox="${ANTIGRAVITY_VIEWBOX}"`) &&
    logoSvg.includes(ANTIGRAVITY_ARCH_PATH) &&
    logoSvg.includes(ANTIGRAVITY_BASE_BLUE) &&
    svgMatchesGradientSpec(logoSvg, ANTIGRAVITY_LEFT_SHOULDER_GRADIENT) &&
    svgMatchesGradientSpec(logoSvg, ANTIGRAVITY_CROWN_RIGHT_GRADIENT);

  expect("svg-spec-parity", svgAligned, {
    viewBox: ANTIGRAVITY_VIEWBOX,
    baseBlue: ANTIGRAVITY_BASE_BLUE,
  });
}

/** Runs all offline component, contract, and asset parity smoke scenarios. */
export async function runComponentSmokeScenarios(
  expect: ExpectFn,
): Promise<void> {
  await runRpcAndDialectSmokeScenarios(expect);
  runAutoCompactPolicyScenarios(expect);
  await runAutoCompactLifecycleScenarios(expect);
  await runManifestAndSvgParity(expect);
}
