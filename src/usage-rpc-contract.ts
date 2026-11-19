/**
 * Defines BB's `provider-usage.v1` RPC contract and pure host-to-UI quota
 * window mappers so schema validation and sidebar label rules stay decoupled
 * from server caching and host I/O orchestration.
 */

import { type BbPluginApi, defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  FIVE_HOUR_WINDOW_LABEL,
  PROVIDER_ID,
  WEEKLY_WINDOW_LABEL,
  WINDOW_LABEL_SEPARATOR,
} from "./constants.ts";

export const LIST_METHOD = "provider-usage.v1.listResources" as const;
export const GET_METHOD = "provider-usage.v1.getResource" as const;
export const USAGE_RPC_DESCRIPTION =
  "Host-local Antigravity quota usage. Inventory reads metadata only." as const;

export const DISCONNECTED_HOST_MESSAGE = "Machine is disconnected." as const;
export const MISSING_PROVIDER_USAGE_MESSAGE =
  "Antigravity returned no usage information." as const;
export const COLLECTION_FAILED_MESSAGE =
  "Usage could not be collected from this machine." as const;
export const REMOVED_RESOURCE_MESSAGE =
  "Usage resource no longer exists." as const;

const WEEKLY_KIND = "weekly" as const;
const CUSTOM_KIND = "custom" as const;
const FIVE_HOUR_SHORT = "5h" as const;
const MIN_USED_PERCENT = 0 as const;
const NOT_FOUND_INDEX = -1 as const;

const windowKindSchema = z.enum([
  "five-hour",
  "daily",
  WEEKLY_KIND,
  CUSTOM_KIND,
]);

const planFields = {
  plan: z
    .object({
      id: z.string().min(1),
      multiplier: z.number().int().positive().nullable(),
    })
    .nullable()
    .default(null),
  accountEmail: z.string().nullable(),
  planLabel: z.string().nullable(),
};

const windowSchema = z.object({
  kind: windowKindSchema.default(CUSTOM_KIND),
  id: z.string().min(1),
  label: z.string().min(1),
  usedPercent: z.number().nonnegative(),
  resetsAt: z.string().nullable(),
  model: z.string().nullable(),
  cost: z
    .object({
      usedUsdCents: z.number().nonnegative(),
      limitUsdCents: z.number().positive(),
    })
    .nullable(),
});

const usageSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    ...planFields,
    windows: z.array(windowSchema),
  }),
  z.object({ status: z.literal("not_installed"), ...planFields }),
  z.object({ status: z.literal("unauthenticated"), ...planFields }),
  z.object({ status: z.literal("expired"), ...planFields }),
  z.object({ status: z.literal("error"), ...planFields, message: z.string() }),
]);

const accountKeySchema = z.string().min(1).nullable().default(null);

const resourceSchema = z.object({
  accountKey: accountKeySchema,
  id: z.string().min(1),
  providerId: z.string().min(1),
  label: z.string().min(1),
  scope: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("shared") }),
    z.object({
      kind: z.literal("host"),
      hostId: z.string().min(1),
      hostName: z.string().min(1),
    }),
  ]),
});

const resourceUsageSchema = z.object({
  accountKey: accountKeySchema,
  observedAt: z.number().int().nonnegative().nullable(),
  usage: usageSchema,
});

/** Discoverable RPC contract expected by BB's Provider usage UI surfaces. */
export const usageSourceContract = defineRpcContract({
  [LIST_METHOD]: {
    input: z.object({}),
    output: z.object({
      label: z.string().min(1).optional(),
      resources: z.array(resourceSchema),
    }),
  },
  [GET_METHOD]: {
    input: z.object({ resourceId: z.string().min(1), refresh: z.boolean() }),
    output: resourceUsageSchema,
  },
});

export type ResourceUsage = z.output<typeof resourceUsageSchema>;

/** Isolates the bridge wire payload from the public `provider-usage.v1` RPC schema. */
export type BridgeUsage = NonNullable<
  Awaited<ReturnType<BbPluginApi["sdk"]["system"]["usageLimits"]>>[string]
>;

const bridgeWindowSchema = z
  .object({
    label: z.string().min(1),
    usedPercent: z.number(),
    resetsAt: z.string().nullable(),
  })
  .passthrough();

/** Validates untrusted `resourceId` strings received over the RPC boundary. */
export const resourceIdSchema = z.tuple([
  z.string().min(1),
  z.literal(PROVIDER_ID),
]);

/** Pairs host and provider ids so multi-host workspaces keep separate quota cards. */
export function resourceId(hostId: string): string {
  return JSON.stringify([hostId, PROVIDER_ID]);
}

/**
 * Uses `"weekly"` only for weekly windows (which BB abbreviates to `7d · …` in
 * the sidebar card) and keeps five-hour buckets `"custom"` with a pre-shortened
 * `5h · …` label because BB's `"five-hour"` kind expands to `"Five-hour limit"`
 * without compact sidebar abbreviation.
 */
function windowKind(label: string): z.output<typeof windowKindSchema> {
  return label.startsWith(WEEKLY_WINDOW_LABEL) ? WEEKLY_KIND : CUSTOM_KIND;
}

/** Shortens custom-kind labels so they fit the narrow sidebar card. */
function customLabel(label: string): string {
  return label.startsWith(FIVE_HOUR_WINDOW_LABEL)
    ? `${FIVE_HOUR_SHORT}${label.slice(FIVE_HOUR_WINDOW_LABEL.length)}`
    : label;
}

/**
 * Preserves the model-family suffix (`Gemini` vs `Claude/GPT`) when BB
 * reconstructs non-custom `"weekly"` window titles from `kind` + `model`.
 */
function windowModel(label: string): string | null {
  const index = label.indexOf(WINDOW_LABEL_SEPARATOR);
  return index === NOT_FOUND_INDEX
    ? null
    : label.slice(index + WINDOW_LABEL_SEPARATOR.length);
}

/**
 * Reports a failure while keeping the last good account key and timestamp, so
 * the card keeps its identity and "last updated" time.
 */
export function unavailable(
  message: string,
  previous: ResourceUsage | undefined,
): ResourceUsage {
  return {
    accountKey: previous?.accountKey ?? null,
    observedAt: previous?.observedAt ?? null,
    usage: {
      status: "error",
      plan: null,
      accountEmail: null,
      planLabel: null,
      message,
    },
  };
}

type Usage = ResourceUsage["usage"];
type UsageWindow = Extract<Usage, { status: "ok" }>["windows"][number];

/** Only `ok` and `error` results carry account details; other states hide them. */
function accountFields(raw: BridgeUsage) {
  const hasAccount = raw.status === "ok" || raw.status === "error";
  return {
    plan: null,
    accountEmail: hasAccount ? (raw.accountEmail ?? null) : null,
    planLabel: hasAccount ? (raw.planLabel ?? null) : null,
  };
}

/**
 * Reconstructs BB's typed window metadata from the host label while prefixing
 * `index` so two groups with identical window names keep distinct React keys.
 */
function toWindow(window: unknown, index: number): UsageWindow {
  const parsed = bridgeWindowSchema.parse(window);
  const kind = windowKind(parsed.label);
  const isCustom = kind === CUSTOM_KIND;
  return {
    kind,
    id: `${index}:${parsed.label}`,
    label: isCustom ? customLabel(parsed.label) : parsed.label,
    usedPercent: Math.max(MIN_USED_PERCENT, parsed.usedPercent),
    resetsAt: parsed.resetsAt,
    model: isCustom ? null : windowModel(parsed.label),
    cost: null,
  };
}

/** Enforces compile-time exhaustiveness via `never` if the SDK adds new statuses. */
function toUsage(raw: BridgeUsage): Usage {
  const base = accountFields(raw);
  switch (raw.status) {
    case "ok":
      return { status: "ok", ...base, windows: raw.windows.map(toWindow) };
    case "not_installed":
    case "unauthenticated":
    case "expired":
      return { status: raw.status, ...base };
    case "error":
      return { status: "error", ...base, message: raw.message };
    default:
      return unhandledStatus(raw);
  }
}

/** Fails loudly if the SDK adds a usage status this plugin does not map yet. */
function unhandledStatus(raw: never): never {
  throw new Error(`Unhandled usage status: ${JSON.stringify(raw)}`);
}

/**
 * Keeps RPC shape conversion pure so `UsageSource.load` owns only host checks,
 * caching, and error boundaries.
 */
export function toResourceUsage(
  raw: BridgeUsage,
  previous: ResourceUsage | undefined,
): ResourceUsage {
  const usage = toUsage(raw);
  return {
    accountKey: null,
    observedAt:
      usage.status === "ok" ? Date.now() : (previous?.observedAt ?? null),
    usage,
  };
}
