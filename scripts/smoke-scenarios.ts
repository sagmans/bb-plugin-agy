/**
 * Aggregates dialect/RPC, auto-compaction, manifest id, and SVG-to-spec parity
 * checks so `npm run smoke` verifies cross-bundle invariants offline.
 */

import { readFile } from "node:fs/promises";
import { z } from "zod";
import {
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
import { runAutoCompactSmokeScenarios } from "./smoke-auto-compact.ts";
import {
  type ExpectFn,
  runRpcAndDialectSmokeScenarios,
} from "./smoke-rpc-scenarios.ts";

const PACKAGE_JSON_URL = new URL("../package.json", import.meta.url);
const MASK_SVG_URL = new URL("../icons/antigravity.svg", import.meta.url);
const LOGO_SVG_URL = new URL("../icons/antigravity-logo.svg", import.meta.url);
const UTF8_ENCODING = "utf8" as const;
const PACKAGE_NAME_PREFIX = "bb-plugin-" as const;

const manifestSchema = z.object({
  name: z.string(),
  bb: z.object({
    experimental_providers: z.array(z.object({ id: z.string() })),
    branding: z.object({
      experimental_icons: z.record(z.string(), z.string()),
    }),
  }),
});

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
  await runAutoCompactSmokeScenarios(expect);
  await runManifestAndSvgParity(expect);
}
