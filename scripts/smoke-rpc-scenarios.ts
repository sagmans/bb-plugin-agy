/**
 * Exercises host dialect fail-closed account probes, unsettled cache coalescing,
 * completion-time TTL refresh, and server `UsageSource` window label mapping,
 * refresh queuing, and host removal/disconnect states without a live BB daemon.
 */

import type { ProviderUsageResult } from "@get-bb/plugin-sdk/provider-bridge";
import {
  AGY_COMMAND,
  HTTP_NOT_FOUND,
  PROVIDER_DISPLAY_NAME,
  PROVIDER_ID,
} from "../src/constants.ts";
import {
  AgyAccountProbeError,
  type AgyAccountProbeStatus,
  createAntigravityDialect,
} from "../src/dialect.ts";
import {
  type BridgeUsage,
  DISCONNECTED_HOST_MESSAGE,
  REMOVED_RESOURCE_MESSAGE,
  resourceId,
} from "../src/usage-rpc-contract.ts";
import { UsageSource, type UsageSourceBackend } from "../src/usage-source.ts";

export type ExpectFn = (name: string, passed: boolean, detail: unknown) => void;

const HOST_ID = "host_local" as const;
const HOST_NAME = "Local Mac" as const;
const CONNECTED_STATUS = "connected" as const;
const DISCONNECTED_STATUS = "disconnected" as const;
const NOT_FOUND_ERROR_TEXT = "Host not found" as const;
const TRANSIENT_PROBE_ERROR_TEXT = "probe failed" as const;
const TEST_CACHE_TTL_MS = 10_000 as const;
const PAST_TTL_CLOCK_MS = 15_000 as const;
const WITHIN_TTL_CLOCK_MS = 5_000 as const;
const INITIAL_CLOCK_MS = 1_000 as const;
const UNGATE_DELAY_MS = 10 as const;

const BRIDGE_WINDOWS_FIXTURE = [
  { label: "Weekly · Gemini", usedPercent: 1, resetsAt: null },
  { label: "5 hours · Gemini", usedPercent: 5, resetsAt: null },
  { label: "Weekly · Claude/GPT", usedPercent: 10, resetsAt: null },
  { label: "5 hours · Claude/GPT", usedPercent: 25, resetsAt: null },
] as const;

const EXPECTED_MAPPED_WINDOWS = [
  {
    kind: "weekly",
    label: "Weekly · Gemini",
    model: "Gemini",
    usedPercent: 1,
  },
  { kind: "custom", label: "5h · Gemini", model: null, usedPercent: 5 },
  {
    kind: "weekly",
    label: "Weekly · Claude/GPT",
    model: "Claude/GPT",
    usedPercent: 10,
  },
  { kind: "custom", label: "5h · Claude/GPT", model: null, usedPercent: 25 },
] as const;

/** Models BB's HTTP-status-tagged host lookup failure without `Object.assign` mutation. */
class HttpStatusError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "HttpStatusError";
    this.status = status;
  }
}

/** Verifies `readAccount` returns `{ email: null }` only on `"ok"` and throws on non-ready states. */
async function runDialectAccountScenarios(expect: ExpectFn): Promise<void> {
  const makeDialect = (result: ProviderUsageResult) =>
    createAntigravityDialect({
      resolveCommand: async () => AGY_COMMAND,
      readUsage: async () => result,
    });

  const okAccount = await makeDialect({
    supported: true,
    usage: { status: "ok", accountEmail: null, planLabel: null, windows: [] },
  }).maintenance?.readAccount();
  expect(
    "dialect-account-ok",
    okAccount !== null && okAccount?.email === null,
    okAccount,
  );

  const signedOutAccount = await makeDialect({
    supported: true,
    usage: { status: "unauthenticated" },
  }).maintenance?.readAccount();
  expect(
    "dialect-account-unauthenticated",
    signedOutAccount === null,
    signedOutAccount,
  );

  const nonReadyResults: readonly ProviderUsageResult[] = [
    {
      supported: true,
      usage: {
        status: "error",
        message: TRANSIENT_PROBE_ERROR_TEXT,
        accountEmail: null,
        planLabel: null,
      },
    },
    { supported: true, usage: { status: "expired" } },
    { supported: true, usage: { status: "not_installed" } },
    { supported: false },
  ];

  const caughtStatuses: AgyAccountProbeStatus[] = [];
  for (const result of nonReadyResults) {
    try {
      await makeDialect(result).maintenance?.readAccount();
    } catch (error) {
      if (error instanceof AgyAccountProbeError) {
        caughtStatuses.push(error.status);
      }
    }
  }
  expect(
    "dialect-account-fail-closed",
    caughtStatuses.length === nonReadyResults.length,
    caughtStatuses,
  );
}

/**
 * Verifies `cachedUsage` reuses unsettled probes past TTL, evicts failed probes,
 * and measures the 10 s cache window from probe completion rather than launch.
 */
async function runDialectCacheScenarios(expect: ExpectFn): Promise<void> {
  let clock: number = INITIAL_CLOCK_MS;
  let spawnCount = 0;
  let resolveSlowProbe: ((value: ProviderUsageResult) => void) | undefined;

  const dialect = createAntigravityDialect({
    now: () => clock,
    cacheTtlMs: TEST_CACHE_TTL_MS,
    resolveCommand: async () => AGY_COMMAND,
    readUsage: () => {
      spawnCount += 1;
      if (spawnCount <= 2) {
        return new Promise((resolve) => {
          resolveSlowProbe = resolve;
        });
      }
      return Promise.resolve({
        supported: true,
        usage: {
          status: "ok",
          accountEmail: null,
          planLabel: null,
          windows: [],
        },
      });
    },
  });

  const firstCall = dialect.maintenance?.readUsage();
  await Promise.resolve();
  clock += PAST_TTL_CLOCK_MS;
  const secondCallWhileUnsettled = dialect.maintenance?.readUsage();
  const dedupedPastTtl = spawnCount === 1;
  resolveSlowProbe?.({
    supported: true,
    usage: {
      status: "error",
      message: TRANSIENT_PROBE_ERROR_TEXT,
      accountEmail: null,
      planLabel: null,
    },
  });
  await Promise.all([firstCall, secondCallWhileUnsettled]);

  const slowOkCall = dialect.maintenance?.readUsage();
  await Promise.resolve();
  clock += PAST_TTL_CLOCK_MS;
  resolveSlowProbe?.({
    supported: true,
    usage: { status: "ok", accountEmail: null, planLabel: null, windows: [] },
  });
  await slowOkCall;
  clock += WITHIN_TTL_CLOCK_MS;
  await dialect.maintenance?.readUsage();

  expect(
    "dialect-cache-dedup-and-eviction",
    dedupedPastTtl && spawnCount === 2,
    { dedupedPastTtl, spawnCount },
  );
}

/** Builds a reusable in-memory `UsageSourceBackend` to avoid duplicating mock wiring. */
function createMockUsageBackend(options: {
  getHostStatus?: () => string;
  isHostMissing?: () => boolean;
  readLimits: (refresh: boolean) => Promise<BridgeUsage>;
}): UsageSourceBackend {
  const statusOf = options.getHostStatus ?? (() => CONNECTED_STATUS);
  return {
    pluginId: PROVIDER_ID,
    logWarn: () => {},
    listHosts: async () => [
      { id: HOST_ID, name: HOST_NAME, status: statusOf() },
    ],
    getHost: async () => {
      if (options.isHostMissing?.()) {
        throw new HttpStatusError(NOT_FOUND_ERROR_TEXT, HTTP_NOT_FOUND);
      }
      return { id: HOST_ID, name: HOST_NAME, status: statusOf() };
    },
    listProviders: async () => [
      {
        id: PROVIDER_ID,
        pluginId: PROVIDER_ID,
        displayName: PROVIDER_DISPLAY_NAME,
      },
    ],
    readUsageLimits: async ({ refresh }) => ({
      [PROVIDER_ID]: await options.readLimits(refresh),
    }),
  };
}

/** Verifies `UsageSource` window `kind`/`label`/`model` reconstruction and 60s passive caching. */
async function runUsageSourceMappingScenario(expect: ExpectFn): Promise<void> {
  let hostStatus: string = CONNECTED_STATUS;
  let hostMissing = false;
  let calls = 0;

  const source = new UsageSource(
    createMockUsageBackend({
      getHostStatus: () => hostStatus,
      isHostMissing: () => hostMissing,
      readLimits: async () => {
        calls += 1;
        return {
          status: "ok",
          accountEmail: null,
          planLabel: null,
          windows: [...BRIDGE_WINDOWS_FIXTURE],
        };
      },
    }),
  );

  const id = resourceId(HOST_ID);
  const listed = await source.listResources();
  const collected = await source.collect(id, false);
  const cachedPassive = await source.collect(id, false);
  const mapped =
    collected.usage.status === "ok"
      ? collected.usage.windows.map(({ kind, label, model, usedPercent }) => ({
          kind,
          label,
          model,
          usedPercent,
        }))
      : [];

  expect(
    "usage-source-window-mapping",
    listed.resources.length === 1 &&
      calls === 1 &&
      cachedPassive.observedAt === collected.observedAt &&
      JSON.stringify(mapped) === JSON.stringify(EXPECTED_MAPPED_WINDOWS),
    mapped,
  );

  hostStatus = DISCONNECTED_STATUS;
  const disconnected = await source.collect(id, true);
  hostMissing = true;
  let removedError = "";
  try {
    await source.collect(id, true);
  } catch (error) {
    removedError = error instanceof Error ? error.message : String(error);
  }
  expect(
    "usage-source-disconnected-and-removed",
    disconnected.usage.status === "error" &&
      disconnected.usage.message === DISCONNECTED_HOST_MESSAGE &&
      removedError === REMOVED_RESOURCE_MESSAGE,
    { disconnected: disconnected.usage, removedError },
  );
}

/** Verifies `refresh: true` queues behind an active passive read and forwards `not_installed`. */
async function runUsageSourceRefreshScenario(expect: ExpectFn): Promise<void> {
  const refreshFlags: boolean[] = [];
  let releasePassive = () => {};

  const source = new UsageSource(
    createMockUsageBackend({
      readLimits: async (refresh) => {
        refreshFlags.push(refresh);
        if (!refresh) {
          await new Promise<void>((resolve) => {
            releasePassive = resolve;
          });
        }
        return { status: "not_installed" };
      },
    }),
  );

  const id = resourceId(HOST_ID);
  const passivePromise = source.collect(id, false);
  const refreshPromise = source.collect(id, true);
  setTimeout(() => releasePassive(), UNGATE_DELAY_MS);
  const [, refreshOutcome] = await Promise.all([
    passivePromise,
    refreshPromise,
  ]);
  expect(
    "usage-source-refresh-and-not-installed",
    JSON.stringify(refreshFlags) === JSON.stringify([false, true]) &&
      refreshOutcome.usage.status === "not_installed",
    { refreshFlags, status: refreshOutcome.usage.status },
  );
}

/** Executes all host-dialect and server-RPC contract smoke scenarios. */
export async function runRpcAndDialectSmokeScenarios(
  expect: ExpectFn,
): Promise<void> {
  await runDialectAccountScenarios(expect);
  await runDialectCacheScenarios(expect);
  await runUsageSourceMappingScenario(expect);
  await runUsageSourceRefreshScenario(expect);
}
