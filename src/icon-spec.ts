/**
 * Centralizes official Antigravity brand geometry, gradient stops, and slot
 * identifiers so frontend icon surfaces never embed magic values inline and
 * remain visually identical across light/dark themes and desktop/mobile views.
 */

import { ANTIGRAVITY_BRAND_TINT, ICON_NAME, PROVIDER_ID } from "./constants.ts";

/** One colour stop of a brand gradient. */
export interface RadialStopSpec {
  readonly offset: string;
  readonly stopColor: string;
  readonly stopOpacity: number;
}

/** Geometry and stops of one brand radial gradient. */
export interface RadialGradientSpec {
  readonly cx: string;
  readonly cy: string;
  readonly r: string;
  readonly stops: readonly RadialStopSpec[];
}

/** Targets agent-provider icon slots in BB's shared ProviderIcon host renderer. */
export const AGENT_PROVIDER_KIND = "agent" as const;

/**
 * Id bb assigns when Antigravity is configured through the generic ACP
 * provider instead of this plugin; painting it too keeps threads created that
 * way from falling back to the monochrome mask.
 */
export const GENERIC_ACP_ANTIGRAVITY_PROVIDER_ID =
  "acp-antigravity-acp" as const;

/** Every agent-provider id whose icon slot this plugin paints. */
export const REGISTERED_AGENT_PROVIDER_IDS: readonly string[] = [
  PROVIDER_ID,
  GENERIC_ACP_ANTIGRAVITY_PROVIDER_ID,
];

/**
 * Overrides the namespaced glyph declared in `server.ts` so host `<Icon>`
 * call sites also render the multicolor mark once the frontend bundle loads.
 */
export const DECLARED_PLUGIN_ICON_NAME = `${PROVIDER_ID}/${ICON_NAME}`;

/**
 * Matches BB's 16x16 provider icon coordinate grid so optical weight and
 * baseline alignment stay consistent next to Codex, Claude Code, and Pi.
 */
export const ANTIGRAVITY_VIEWBOX = "0 0 16 16" as const;
export const ANTIGRAVITY_CANVAS_SIZE = 16 as const;

/**
 * Prevents iOS and macOS WebKit from falling back to the 300px replaced-element
 * intrinsic width when BB's `ProviderIcon` host wrapper applies `min-w-max`
 * (`min-width: max-content`) while passing `size-full` (`width: 100%`), which
 * otherwise crushes the adjacent mobile composer model label down to 0px. A
 * 1px presentation floor stays below every host icon size (`size-3.5`,
 * `size-4`, `size-6`) so CSS utility classes always govern the rendered box.
 */
export const ANTIGRAVITY_INTRINSIC_DIMENSION = 1 as const;
/** Outline of the Antigravity arch; it clips every colour layer. */
export const ANTIGRAVITY_ARCH_PATH =
  "M14.1452 14.6818C14.9937 15.3182 16.2664 14.894 15.0997 13.7273C11.5998 10.3333 12.3421 1 7.99366 1C3.64518 1 4.3876 10.3333 0.887603 13.7273C-0.385123 15 0.993664 15.3182 1.84215 14.6818C5.13002 12.4545 4.9179 8.5303 7.99366 8.5303C11.0694 8.5303 10.8573 12.4545 14.1452 14.6818Z" as const;

/**
 * Removes colons emitted by React's `useId()` because WebKit/Safari SVG
 * `url(#...)` paint servers can fail when fragment identifiers contain colons.
 */
export const UNSAFE_SVG_ID_CHARS = /[^a-zA-Z0-9_-]/gu;
/** Namespaces paint-server ids so they cannot collide with host SVG ids. */
export const SVG_ID_PREFIX = "agy-icon" as const;
export const CLIP_ID_SUFFIX = "clip" as const;
export const LEFT_GRADIENT_ID_SUFFIX = "left" as const;
export const CROWN_GRADIENT_ID_SUFFIX = "crown" as const;

/**
 * Sampled from `/Applications/Antigravity.app/Contents/Resources/icon.icns`
 * so the multicolor gradient matches the official desktop application icon.
 */
export const ANTIGRAVITY_BASE_BLUE = ANTIGRAVITY_BRAND_TINT;

/** Green-to-teal glow on the arch's left shoulder. */
export const ANTIGRAVITY_LEFT_SHOULDER_GRADIENT: RadialGradientSpec = {
  cx: "30%",
  cy: "28%",
  r: "52%",
  stops: [
    { offset: "0%", stopColor: "#7EBF6E", stopOpacity: 1 },
    { offset: "52%", stopColor: "#41A3BA", stopOpacity: 0.85 },
    { offset: "100%", stopColor: "#4390F0", stopOpacity: 0 },
  ],
};

/** Orange-to-violet glow across the crown and right side. */
export const ANTIGRAVITY_CROWN_RIGHT_GRADIENT: RadialGradientSpec = {
  cx: "60%",
  cy: "16%",
  r: "56%",
  stops: [
    { offset: "0%", stopColor: "#F1882E", stopOpacity: 1 },
    { offset: "48%", stopColor: "#DA6C69", stopOpacity: 0.9 },
    { offset: "78%", stopColor: "#8086D6", stopOpacity: 0.45 },
    { offset: "100%", stopColor: ANTIGRAVITY_BASE_BLUE, stopOpacity: 0 },
  ],
};
