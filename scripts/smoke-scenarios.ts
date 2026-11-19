/**
 * Aggregates dialect/RPC, auto-compaction boundary, manifest id, and SVG-to-spec
 * parity checks so `npm run smoke` verifies cross-bundle invariants offline.
 */

import { readFile } from "node:fs/promises";
import {
  analyzeRecentThreadEvents,
  canResumeAfterMidTurnYield,
  evaluateMidTurnAutoCompactDecision,
} from "../src/auto-compact-policy.ts";
import {
  AUTO_COMPACT_TOKEN_THRESHOLD_DEFAULT,
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
const PACKAGE_NAME_PREFIX = "bb-plugin-" as const;
const ABOVE_THRESHOLD_TOKENS = 260_000 as const;
const SEQ_TURN_START = 10 as const;
const SEQ_TOOL_START = 11 as const;
const SEQ_TOOL_END = 12 as const;
const SEQ_USAGE_UPDATE = 13 as const;
const SEQ_TURN_COMPLETE = 14 as const;
const SEQ_INTERRUPT = 15 as const;
const ZERO_COUNT = 0 as const;

/** Verifies mid-turn auto-compaction waits for open tools and respects user interruptions. */
function runAutoCompactScenarios(expect: ExpectFn): void {
  const openToolActivity = analyzeRecentThreadEvents([
    { seq: SEQ_USAGE_UPDATE, type: "thread/contextWindowUsage/updated" },
    {
      seq: SEQ_TOOL_START,
      type: "item/started",
      data: { item: { id: "tool_1", type: "commandExecution" } },
    },
    { seq: SEQ_TURN_START, type: "turn/started" },
  ]);
  const blockedDecision = evaluateMidTurnAutoCompactDecision({
    enabled: true,
    threshold: AUTO_COMPACT_TOKEN_THRESHOLD_DEFAULT,
    usedTokens: ABOVE_THRESHOLD_TOKENS,
    activity: openToolActivity,
    awaitingDropOrNewTurn: false,
    lastAttemptedTurnSeq: undefined,
    consecutiveAutoCompactions: ZERO_COUNT,
  });

  const closedToolActivity = analyzeRecentThreadEvents([
    { seq: SEQ_USAGE_UPDATE, type: "thread/contextWindowUsage/updated" },
    {
      seq: SEQ_TOOL_END,
      type: "item/completed",
      data: { item: { id: "tool_1", type: "commandExecution" } },
    },
    {
      seq: SEQ_TOOL_START,
      type: "item/started",
      data: { item: { id: "tool_1", type: "commandExecution" } },
    },
    { seq: SEQ_TURN_START, type: "turn/started" },
  ]);
  const readyDecision = evaluateMidTurnAutoCompactDecision({
    enabled: true,
    threshold: AUTO_COMPACT_TOKEN_THRESHOLD_DEFAULT,
    usedTokens: ABOVE_THRESHOLD_TOKENS,
    activity: closedToolActivity,
    awaitingDropOrNewTurn: false,
    lastAttemptedTurnSeq: undefined,
    consecutiveAutoCompactions: ZERO_COUNT,
  });

  const completedYield = analyzeRecentThreadEvents([
    {
      seq: SEQ_TURN_COMPLETE,
      type: "turn/completed",
      data: { status: "completed" },
    },
    { seq: SEQ_TURN_START, type: "turn/started" },
  ]);
  const interruptedYield = analyzeRecentThreadEvents([
    { seq: SEQ_INTERRUPT, type: "system/thread/interrupted" },
    {
      seq: SEQ_TURN_COMPLETE,
      type: "turn/completed",
      data: { status: "completed" },
    },
  ]);

  expect(
    "auto-compact-tool-and-interrupt-guards",
    blockedDecision.action === "skip" &&
      blockedDecision.reason === "open-tool-execution" &&
      readyDecision.action === "compact" &&
      canResumeAfterMidTurnYield(completedYield, SEQ_USAGE_UPDATE) &&
      !canResumeAfterMidTurnYield(interruptedYield, SEQ_USAGE_UPDATE),
    { blockedDecision, readyDecision },
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
    readFile(PACKAGE_JSON_URL, "utf8"),
    readFile(MASK_SVG_URL, "utf8"),
    readFile(LOGO_SVG_URL, "utf8"),
  ]);
  const manifest = JSON.parse(manifestRaw) as {
    name: string;
    bb: {
      experimental_providers: { id: string }[];
      branding: { experimental_icons: Record<string, string> };
    };
  };

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
  runAutoCompactScenarios(expect);
  await runManifestAndSvgParity(expect);
}
