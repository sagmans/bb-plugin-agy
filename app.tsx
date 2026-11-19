/**
 * Replaces BB's monochrome CSS `mask-image` silhouette with the official
 * multicolor Antigravity mark across every provider and icon surface (sidebar
 * thread rows, composer pickers, thread headers, Provider usage page & sidebar
 * card, and Settings -> Providers). Kept stateless and free of plugin-scoped
 * hooks because BB mounts `experimental_providerIcon` inside an ErrorBoundary
 * outside `PluginScopeProvider`.
 */

import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { useId } from "react";
import {
  AGENT_PROVIDER_KIND,
  ANTIGRAVITY_ARCH_PATH,
  ANTIGRAVITY_BASE_BLUE,
  ANTIGRAVITY_CANVAS_SIZE,
  ANTIGRAVITY_CROWN_RIGHT_GRADIENT,
  ANTIGRAVITY_INTRINSIC_DIMENSION,
  ANTIGRAVITY_LEFT_SHOULDER_GRADIENT,
  ANTIGRAVITY_VIEWBOX,
  CLIP_ID_SUFFIX,
  CROWN_GRADIENT_ID_SUFFIX,
  DECLARED_PLUGIN_ICON_NAME,
  LEFT_GRADIENT_ID_SUFFIX,
  type RadialGradientSpec,
  REGISTERED_AGENT_PROVIDER_IDS,
  SVG_ID_PREFIX,
  UNSAFE_SVG_ID_CHARS,
} from "./src/icon-spec.ts";

/**
 * Renders one brand paint server from `icon-spec.ts` geometry so both mark
 * layers share a single gradient shape and cannot drift apart.
 */
function BrandRadialGradient({
  id,
  spec,
}: {
  id: string;
  spec: RadialGradientSpec;
}) {
  return (
    <radialGradient id={id} cx={spec.cx} cy={spec.cy} r={spec.r}>
      {spec.stops.map((stop) => (
        <stop
          key={stop.offset}
          offset={stop.offset}
          stopColor={stop.stopColor}
          stopOpacity={stop.stopOpacity}
        />
      ))}
    </radialGradient>
  );
}

/**
 * Generates instance-unique `<defs>` IDs so simultaneous icons on one screen
 * (thread list, composer picker, sidebar usage tabs) never collide or blank out
 * `url(#...)` paint servers when a sibling container hides.
 */
function AntigravityProviderIcon({ className }: { className?: string }) {
  const rawReactId = useId();
  const safeInstanceId = `${SVG_ID_PREFIX}-${rawReactId.replace(UNSAFE_SVG_ID_CHARS, "")}`;
  const clipId = `${safeInstanceId}-${CLIP_ID_SUFFIX}`;
  const leftGradId = `${safeInstanceId}-${LEFT_GRADIENT_ID_SUFFIX}`;
  const crownGradId = `${safeInstanceId}-${CROWN_GRADIENT_ID_SUFFIX}`;

  return (
    <svg
      width={ANTIGRAVITY_INTRINSIC_DIMENSION}
      height={ANTIGRAVITY_INTRINSIC_DIMENSION}
      viewBox={ANTIGRAVITY_VIEWBOX}
      fill="none"
      className={className}
      aria-hidden="true"
    >
      <defs>
        <clipPath id={clipId}>
          <path d={ANTIGRAVITY_ARCH_PATH} />
        </clipPath>
        <BrandRadialGradient
          id={leftGradId}
          spec={ANTIGRAVITY_LEFT_SHOULDER_GRADIENT}
        />
        <BrandRadialGradient
          id={crownGradId}
          spec={ANTIGRAVITY_CROWN_RIGHT_GRADIENT}
        />
      </defs>
      <g clipPath={`url(#${clipId})`}>
        <rect
          width={ANTIGRAVITY_CANVAS_SIZE}
          height={ANTIGRAVITY_CANVAS_SIZE}
          fill={ANTIGRAVITY_BASE_BLUE}
        />
        <rect
          width={ANTIGRAVITY_CANVAS_SIZE}
          height={ANTIGRAVITY_CANVAS_SIZE}
          fill={`url(#${leftGradId})`}
        />
        <rect
          width={ANTIGRAVITY_CANVAS_SIZE}
          height={ANTIGRAVITY_CANVAS_SIZE}
          fill={`url(#${crownGradId})`}
        />
      </g>
    </svg>
  );
}

/**
 * Registers multicolor SVG overrides on both provider icon slots and the
 * declared icon registry so every BB surface renders consistent branding.
 */
export default definePluginApp((app) => {
  for (const providerId of REGISTERED_AGENT_PROVIDER_IDS) {
    app.slots.experimental_providerIcon({
      providerKind: AGENT_PROVIDER_KIND,
      providerId,
      icon: AntigravityProviderIcon,
    });
  }
  app.experimental_icons.register({
    name: DECLARED_PLUGIN_ICON_NAME,
    component: AntigravityProviderIcon,
  });
});
