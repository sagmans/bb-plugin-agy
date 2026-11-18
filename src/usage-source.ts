/**
 * Serves BB's discoverable `provider-usage.v1` RPC contract for Antigravity so
 * both Settings -> Provider usage and the Sidebar usage card discover, cache,
 * deduplicate, and refresh host-scoped Antigravity quotas identically to
 * built-in harness plugins.
 */

import { type BbPluginApi, defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  FIVE_HOUR_WINDOW_LABEL,
  PROVIDER_ID,
  SERVER_USAGE_CACHE_TTL_MS,
  WEEKLY_WINDOW_LABEL,
  WINDOW_LABEL_SEPARATOR,
} from "./constants.ts";

const LIST_METHOD = "provider-usage.v1.listResources" as const;
const GET_METHOD = "provider-usage.v1.getResource" as const;
const COLLECT_OPERATION = "provider-usage.collect" as const;
const USAGE_RPC_DESCRIPTION =
  "Host-local Antigravity quota usage. Inventory reads metadata only." as const;

/** Compact form bb's sidebar card has room for. */
const FIVE_HOUR_SHORT = "5h" as const;

const DISCONNECTED_HOST_MESSAGE = "Machine is disconnected." as const;
const MISSING_PROVIDER_USAGE_MESSAGE =
  "Antigravity returned no usage information." as const;
const COLLECTION_FAILED_MESSAGE =
  "Usage could not be collected from this machine." as const;
const REMOVED_RESOURCE_MESSAGE = "Usage resource no longer exists." as const;
const HTTP_NOT_FOUND = 404 as const;

const windowKindSchema = z.enum(["five-hour", "daily", "weekly", "custom"]);

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
  kind: windowKindSchema.default("custom"),
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

type ResourceUsage = z.output<typeof resourceUsageSchema>;

/** One provider's usage as the host bridge returns it, before RPC shaping. */
type BridgeUsage = NonNullable<
  Awaited<ReturnType<BbPluginApi["sdk"]["system"]["usageLimits"]>>[string]
>;

/** A provider row from bb's provider inventory. */
type ProviderRow = Awaited<
  ReturnType<BbPluginApi["sdk"]["providers"]["list"]>
>[number];

const bridgeWindowSchema = z
  .object({
    label: z.string().min(1),
    usedPercent: z.number(),
    resetsAt: z.string().nullable(),
  })
  .passthrough();

const resourceIdSchema = z.tuple([z.string().min(1), z.literal(PROVIDER_ID)]);

/** Resource ids pair host and provider so each machine gets its own usage card. */
function resourceId(hostId: string): string {
  return JSON.stringify([hostId, PROVIDER_ID]);
}

/**
 * Uses `"weekly"` only for weekly windows (which BB abbreviates to `7d · …` in
 * the sidebar card) and keeps five-hour buckets `"custom"` with a pre-shortened
 * `5h · …` label because BB's `"five-hour"` kind expands to `"Five-hour limit"`
 * without compact sidebar abbreviation.
 */
function windowKind(label: string): z.output<typeof windowKindSchema> {
  return label.startsWith(WEEKLY_WINDOW_LABEL) ? "weekly" : "custom";
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
  return index === -1
    ? null
    : label.slice(index + WINDOW_LABEL_SEPARATOR.length);
}

/**
 * Reports a failure while keeping the last good account key and timestamp, so
 * the card keeps its identity and "last updated" time.
 */
function unavailable(
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
 * Turns one host label back into bb's window fields; the index keeps ids
 * unique when two groups share a label.
 */
function toWindow(window: unknown, index: number): UsageWindow {
  const parsed = bridgeWindowSchema.parse(window);
  const kind = windowKind(parsed.label);
  const isCustom = kind === "custom";
  return {
    kind,
    id: `${index}:${parsed.label}`,
    label: isCustom ? customLabel(parsed.label) : parsed.label,
    usedPercent: Math.max(0, parsed.usedPercent),
    resetsAt: parsed.resetsAt,
    model: isCustom ? null : windowModel(parsed.label),
    cost: null,
  };
}

/** Maps each bridge status to its RPC usage shape; `never` keeps it exhaustive. */
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
 * Maps the host bridge's usage result to the RPC shape, outside load() so the
 * mapping stays pure and load() only owns I/O, caching and errors.
 */
function toResourceUsage(
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

/**
 * Holds the per-host usage cache and in-flight reads behind the RPC handlers;
 * a class keeps each step a small, separately judged method.
 */
class UsageSource {
  private readonly lastObserved = new Map<string, ResourceUsage>();
  private readonly inFlight = new Map<
    string,
    { readonly refresh: boolean; readonly promise: Promise<ResourceUsage> }
  >();
  private readonly bb: BbPluginApi;

  // An explicit field, not a parameter property: Node's type stripping
  // (used by the smoke script) rejects parameter properties.
  constructor(bb: BbPluginApi) {
    this.bb = bb;
  }

  /** Only this plugin's own provider row counts; a same-id provider from another plugin does not. */
  private isOwnProvider = (provider: ProviderRow): boolean =>
    provider.id === PROVIDER_ID && provider.pluginId === this.bb.pluginId;

  /** Lists one usage resource per host that runs this provider, and drops cache for gone hosts. */
  async listResources() {
    const hosts = await this.bb.sdk.hosts.list();
    const perHost = await Promise.all(
      hosts.map(async (host) => {
        const providers = await this.bb.sdk.providers.list({
          hostId: host.id,
          capability: "usage",
        });
        return providers.filter(this.isOwnProvider).map((provider) => {
          const id = resourceId(host.id);
          return {
            accountKey: this.lastObserved.get(id)?.accountKey ?? null,
            id,
            providerId: provider.id,
            label: provider.displayName,
            scope: {
              kind: "host" as const,
              hostId: host.id,
              hostName: host.name,
            },
          };
        });
      }),
    );
    const resources = perHost.flat();
    const liveIds = new Set(resources.map((resource) => resource.id));
    for (const cachedId of this.lastObserved.keys()) {
      if (!liveIds.has(cachedId)) {
        this.lastObserved.delete(cachedId);
      }
    }
    return { resources };
  }

  /**
   * Coalesces concurrent UI reads (`Settings -> Provider usage` + Sidebar card)
   * while ensuring an explicit `refresh: true` waits for any passive read and
   * then performs a fresh collection.
   */
  async collect(id: string, refresh: boolean): Promise<ResourceUsage> {
    const active = this.inFlight.get(id);
    if (active !== undefined) {
      if (!refresh || active.refresh) {
        return active.promise;
      }
      await active.promise.catch(() => {});
      return this.collect(id, refresh);
    }
    const promise = this.load(id, refresh).finally(() => {
      this.inFlight.delete(id);
    });
    this.inFlight.set(id, { refresh, promise });
    return promise;
  }

  /**
   * Fails with "resource removed" when the host or this provider is gone, so
   * bb drops the card instead of showing a stale one.
   */
  private async assertResourceExists(hostId: string): Promise<boolean> {
    const host = await this.bb.sdk.hosts
      .get({ hostId })
      .catch((error: unknown) => {
        if (
          error instanceof Error &&
          "status" in error &&
          error.status === HTTP_NOT_FOUND
        ) {
          throw new Error(REMOVED_RESOURCE_MESSAGE, { cause: error });
        }
        throw error;
      });
    if (host.status === "disconnected") {
      return false;
    }
    const providers = await this.bb.sdk.providers.list({
      hostId,
      capability: "usage",
    });
    if (!providers.some(this.isOwnProvider)) {
      throw new Error(REMOVED_RESOURCE_MESSAGE);
    }
    return true;
  }

  /**
   * Reads one host's usage: checks the host and provider still exist, serves
   * a fresh cache entry, otherwise asks the host bridge.
   */
  private async load(id: string, refresh: boolean): Promise<ResourceUsage> {
    const startedAt = Date.now();
    const [hostId] = resourceIdSchema.parse(JSON.parse(id));
    const previous = this.lastObserved.get(id);

    if (!(await this.assertResourceExists(hostId))) {
      return unavailable(DISCONNECTED_HOST_MESSAGE, previous);
    }
    if (!refresh && isFresh(previous)) {
      return previous;
    }

    try {
      const response = await this.bb.sdk.system.usageLimits({
        hostId,
        providerId: PROVIDER_ID,
        refresh,
      });
      const raw = response[PROVIDER_ID];
      if (raw === undefined) {
        return unavailable(MISSING_PROVIDER_USAGE_MESSAGE, previous);
      }
      const result = toResourceUsage(raw, previous);
      this.lastObserved.set(id, result);
      return result;
    } catch (error) {
      const elapsedMs = Date.now() - startedAt;
      this.bb.log.warn(
        `op=${COLLECT_OPERATION} hostId=${hostId} providerId=${PROVIDER_ID} ` +
          `refresh=${refresh} elapsedMs=${elapsedMs} ` +
          `cause=${error instanceof Error ? error.message : String(error)}`,
      );
      return unavailable(COLLECTION_FAILED_MESSAGE, previous);
    }
  }
}

/** A passive read reuses a successful result younger than the server cache TTL. */
function isFresh(
  previous: ResourceUsage | undefined,
): previous is ResourceUsage {
  return (
    previous?.usage.status === "ok" &&
    previous.observedAt !== null &&
    Date.now() - previous.observedAt < SERVER_USAGE_CACHE_TTL_MS
  );
}

/**
 * Registers the `provider-usage.v1` RPC source with per-resource caching and
 * request coalescing; called once from the server entry.
 */
export function registerUsageSource(bb: BbPluginApi): void {
  const source = new UsageSource(bb);
  bb.rpc.register(
    usageSourceContract,
    {
      [LIST_METHOD]: () => source.listResources(),
      [GET_METHOD]: ({ resourceId: id, refresh }) =>
        source.collect(id, refresh),
    },
    {
      experimental_discoverable: true,
      experimental_description: USAGE_RPC_DESCRIPTION,
    },
  );
}
