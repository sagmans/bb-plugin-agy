/**
 * Serves BB's discoverable `provider-usage.v1` RPC handlers for Antigravity so
 * both Settings -> Provider usage and the Sidebar usage card cache, deduplicate,
 * and refresh host-scoped quotas identically to built-in harness plugins.
 */

import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  HTTP_NOT_FOUND,
  PROVIDER_ID,
  SERVER_USAGE_CACHE_TTL_MS,
} from "./constants.ts";
import {
  type BridgeUsage,
  COLLECTION_FAILED_MESSAGE,
  DISCONNECTED_HOST_MESSAGE,
  GET_METHOD,
  LIST_METHOD,
  MISSING_PROVIDER_USAGE_MESSAGE,
  REMOVED_RESOURCE_MESSAGE,
  type ResourceUsage,
  resourceId,
  resourceIdSchema,
  toResourceUsage,
  USAGE_RPC_DESCRIPTION,
  unavailable,
  usageSourceContract,
} from "./usage-rpc-contract.ts";

const COLLECT_OPERATION = "provider-usage.collect" as const;
const DISCONNECTED_HOST_STATUS = "disconnected" as const;
const USAGE_CAPABILITY = "usage" as const;
const HOST_SCOPE_KIND = "host" as const;

/** Narrow host summary required by `UsageSource` so smoke scenarios need no full SDK stub. */
export interface UsageHostSummary {
  readonly id: string;
  readonly name: string;
  readonly status: string;
}

/** Narrow provider summary required to filter this plugin's own provider row. */
export interface UsageProviderSummary {
  readonly id: string;
  readonly pluginId?: string | null;
  readonly displayName: string;
}

/** Minimal SDK surface consumed by `UsageSource` for decoupled verification. */
export interface UsageSourceBackend {
  readonly pluginId: string;
  readonly logWarn: (message: string) => void;
  readonly listHosts: () => Promise<readonly UsageHostSummary[]>;
  readonly getHost: (args: { hostId: string }) => Promise<UsageHostSummary>;
  readonly listProviders: (args: {
    hostId: string;
    capability: typeof USAGE_CAPABILITY;
  }) => Promise<readonly UsageProviderSummary[]>;
  readonly readUsageLimits: (args: {
    hostId: string;
    providerId: string;
    refresh: boolean;
  }) => Promise<Readonly<Record<string, BridgeUsage | undefined>>>;
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
 * Holds per-host usage cache and in-flight coalescing state; exported so smoke
 * scenarios can verify server-side caching, refresh queuing, and label mapping.
 */
export class UsageSource {
  private readonly lastObserved = new Map<string, ResourceUsage>();
  private readonly inFlight = new Map<
    string,
    { readonly refresh: boolean; readonly promise: Promise<ResourceUsage> }
  >();
  private readonly backend: UsageSourceBackend;

  // Explicit field assignment keeps Node native type stripping compatible.
  constructor(backend: UsageSourceBackend) {
    this.backend = backend;
  }

  /** Prevents colliding with a same-id provider contributed by another plugin. */
  private isOwnProvider = (provider: UsageProviderSummary): boolean =>
    provider.id === PROVIDER_ID && provider.pluginId === this.backend.pluginId;

  /** Evicts cached state for removed hosts so disconnected cards do not leak memory. */
  async listResources() {
    const hosts = await this.backend.listHosts();
    const perHost = await Promise.all(
      hosts.map(async (host) => {
        const providers = await this.backend.listProviders({
          hostId: host.id,
          capability: USAGE_CAPABILITY,
        });
        return providers.filter(this.isOwnProvider).map((provider) => {
          const id = resourceId(host.id);
          return {
            accountKey: this.lastObserved.get(id)?.accountKey ?? null,
            id,
            providerId: provider.id,
            label: provider.displayName,
            scope: {
              kind: HOST_SCOPE_KIND,
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
    const host = await this.backend
      .getHost({ hostId })
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
    if (host.status === DISCONNECTED_HOST_STATUS) {
      return false;
    }
    const providers = await this.backend.listProviders({
      hostId,
      capability: USAGE_CAPABILITY,
    });
    if (!providers.some(this.isOwnProvider)) {
      throw new Error(REMOVED_RESOURCE_MESSAGE);
    }
    return true;
  }

  /**
   * Separates host existence checks, TTL caching, and bridge error recovery from
   * pure payload transformation so transient RPC failures preserve `observedAt`.
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
      const response = await this.backend.readUsageLimits({
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
      this.backend.logWarn(
        `op=${COLLECT_OPERATION} hostId=${hostId} providerId=${PROVIDER_ID} ` +
          `refresh=${refresh} elapsedMs=${elapsedMs} ` +
          `cause=${error instanceof Error ? error.message : String(error)}`,
      );
      return unavailable(COLLECTION_FAILED_MESSAGE, previous);
    }
  }
}

/**
 * Registers the `provider-usage.v1` RPC source with per-resource caching and
 * request coalescing; called once from the server entry.
 */
export function registerUsageSource(bb: BbPluginApi): void {
  const source = new UsageSource({
    pluginId: bb.pluginId,
    logWarn: (message) => bb.log.warn(message),
    listHosts: () => bb.sdk.hosts.list(),
    getHost: (args) => bb.sdk.hosts.get(args),
    listProviders: (args) => bb.sdk.providers.list(args),
    readUsageLimits: (args) => bb.sdk.system.usageLimits(args),
  });
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
