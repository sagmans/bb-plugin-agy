/** Exercises restart recovery through plugin registration and a durable journal. */
import { DatabaseSync } from "node:sqlite";
import { setImmediate } from "node:timers/promises";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { RecentThreadEvent } from "../src/auto-compact-events.ts";
import { AutoCompactJournal } from "../src/auto-compact-journal.ts";
import {
  ACTIVE_THREAD_STATUS,
  type AutoCompactThreadCandidate,
  IDLE_THREAD_STATUS,
} from "../src/auto-compact-policy.ts";
import { registerAutoCompaction } from "../src/auto-compact-registration.ts";
import {
  AUTO_COMPACT_AGENT_ONLY_VISIBILITY,
  AUTO_COMPACT_MAX_CONSECUTIVE,
  AUTO_COMPACT_TOKEN_THRESHOLD_DEFAULT,
} from "../src/constants.ts";
import {
  ABOVE_THRESHOLD_USAGE,
  CLIENT_TURN_REQUESTED_EVENT,
  COMPLETED_STATUS,
  INTERRUPTED_EVENT,
  makePluginYieldRequestEvent,
  makeThreadCandidate,
  SEQ_INTERRUPT,
  SEQ_TURN_COMPLETE,
  SEQ_TURN_START,
  SEQ_USAGE_UPDATE,
  STEER_TARGET_KIND,
  THREAD_ID_PRIMARY,
  TURN_COMPLETED_EVENT,
  TURN_STARTED_EVENT,
  USAGE_UPDATED_EVENT,
  YIELD_REQUEST_ID,
  ZERO_COUNT,
} from "./smoke-auto-compact-fixtures.ts";
import type { ExpectFn } from "./smoke-rpc-scenarios.ts";

const DATABASE_PATH = ":memory:";
const ACTIVE_EVENTS_TOPIC = "experimental_thread.events";
const IDLE_TOPIC = "thread.idle";
const STEER_MODE = "steer";
const START_MODE = "start";
const SENT_DELIVERY = "sent";
const QUEUED_DELIVERY = "queued";
const QUEUED_MESSAGE_ID = "msg_smoke_restart";
const FIRST_REQUEST_INDEX = 0;
const SINGLE_REQUEST_COUNT = 1;
const SEQ_AFTER_USAGE = SEQ_USAGE_UPDATE + 1;

type SendArgs = Parameters<BbPluginApi["sdk"]["threads"]["send"]>[0];
type ThreadListener = (payload: {
  thread: AutoCompactThreadCandidate;
}) => void | Promise<void>;

/** Creates a new registration and isolated listener set for each plugin load. */
function loadRestartRegistration(host: {
  storage: BbPluginApi["storage"];
  liveThread: () => AutoCompactThreadCandidate;
  history: readonly RecentThreadEvent[];
  send: (args: SendArgs) => Promise<unknown>;
  compact: () => Promise<void>;
  logError: (message: string) => void;
}) {
  const { storage, liveThread, history, send, compact, logError } = host;
  const listeners = new Map<string, ThreadListener>();
  let dispose = () => {};
  const bb = {
    pluginId: liveThread().providerId,
    storage,
    settings: {
      define: () => ({
        get: async () => ({
          autoCompactEnabled: true,
          autoCompactTokenThreshold: AUTO_COMPACT_TOKEN_THRESHOLD_DEFAULT,
        }),
      }),
    },
    events: {
      on: (topic: string, listener: ThreadListener) => {
        listeners.set(topic, listener);
      },
    },
    onDispose: (callback: () => void) => {
      dispose = callback;
    },
    sdk: {
      threads: {
        get: async () => liveThread(),
        context: async () => ({ usage: ABOVE_THRESHOLD_USAGE }),
        events: {
          list: async ({ types }: { types: readonly string[] }) =>
            history.filter((event) => types.includes(event.type)),
        },
        send,
        compact,
      },
    },
    log: {
      info: () => {},
      warn: logError,
      error: logError,
    },
  } as unknown as BbPluginApi;
  registerAutoCompaction(bb);
  return {
    emit: async (topic: string) => {
      const listener = listeners.get(topic);
      if (listener === undefined) throw new Error(`Missing listener ${topic}`);
      await listener({ thread: liveThread() });
    },
    unload: () => {
      listeners.clear();
      dispose();
    },
  };
}

/** Holds the fake host's database and history across individual plugin loads. */
function createRestartHarness(continuationAcknowledgement?: Promise<void>) {
  const database = new DatabaseSync(DATABASE_PATH);
  const history: RecentThreadEvent[] = [
    { seq: SEQ_USAGE_UPDATE, type: USAGE_UPDATED_EVENT },
    { seq: SEQ_TURN_START, type: TURN_STARTED_EVENT },
  ];
  const sends: SendArgs[] = [];
  const errors: string[] = [];
  let compactCalls: number = ZERO_COUNT;
  let status: string = ACTIVE_THREAD_STATUS;
  let appliedMigrations: number = ZERO_COUNT;
  const storage = {
    database: () => database,
    migrate: (_database: DatabaseSync, statements: string[]) => {
      for (const statement of statements.slice(appliedMigrations)) {
        database.exec(statement);
        appliedMigrations++;
      }
    },
  } as unknown as BbPluginApi["storage"];

  /** Mirrors a persisted request using the actual control message from registration. */
  async function send(args: SendArgs) {
    sends.push(args);
    if (args.mode === STEER_MODE) {
      history.unshift({
        seq: SEQ_AFTER_USAGE,
        type: CLIENT_TURN_REQUESTED_EVENT,
        data: {
          requestId: YIELD_REQUEST_ID,
          originPluginId: args.originPluginId,
          target: { kind: STEER_TARGET_KIND },
          input: args.input,
        },
      });
    }
    if (args.mode === START_MODE) await continuationAcknowledgement;
    return args.compactFirst === true
      ? { delivery: QUEUED_DELIVERY, queuedMessage: { id: QUEUED_MESSAGE_ID } }
      : { delivery: SENT_DELIVERY };
  }

  return {
    load: () =>
      loadRestartRegistration({
        storage,
        liveThread: () => makeThreadCandidate(THREAD_ID_PRIMARY, status),
        history,
        send,
        compact: async () => {
          compactCalls++;
        },
        logError: (message) => {
          errors.push(message);
        },
      }),
    sends,
    errors,
    get compactCalls() {
      return compactCalls;
    },
    close: () => database.close(),
    finish: (interrupted: boolean) => {
      status = IDLE_THREAD_STATUS;
      history.unshift({
        seq: SEQ_TURN_COMPLETE,
        type: TURN_COMPLETED_EVENT,
        data: { status: COMPLETED_STATUS },
      });
      if (interrupted) {
        history.unshift({ seq: SEQ_INTERRUPT, type: INTERRUPTED_EVENT });
      }
    },
    seedCappedYield: () => {
      const journal = new AutoCompactJournal(storage);
      journal.save(THREAD_ID_PRIMARY, {
        awaitingDropOrNewTurn: false,
        lastAttemptedMidTurnSeq: SEQ_TURN_START,
        lastAttemptedIdleTurnSeq: null,
        lastUserRequestSeq: ZERO_COUNT,
        consecutiveAutoCompactions: AUTO_COMPACT_MAX_CONSECUTIVE,
      });
      history.unshift(makePluginYieldRequestEvent(SEQ_AFTER_USAGE));
    },
  };
}

/** Checks that recovery uses a hidden continuation with the requested compaction mode. */
function isContinuation(send: SendArgs | undefined, compact: boolean): boolean {
  return (
    send?.mode === START_MODE &&
    (send.compactFirst === true) === compact &&
    send.input[FIRST_REQUEST_INDEX]?.visibility ===
      AUTO_COMPACT_AGENT_ONLY_VISIBILITY
  );
}

/** Recovers a missed idle transition once and suppresses a repeated active steer on reload. */
async function verifyMissedIdle(expect: ExpectFn): Promise<void> {
  let acknowledge = () => {};
  const host = createRestartHarness(
    new Promise<void>((resolve) => {
      acknowledge = resolve;
    }),
  );
  let plugin = host.load();
  try {
    await plugin.emit(ACTIVE_EVENTS_TOPIC);
    plugin.unload();
    plugin = host.load();
    await setImmediate();
    await plugin.emit(ACTIVE_EVENTS_TOPIC);
    const beforeIdle = host.sends.length;
    plugin.unload();
    host.finish(false);
    plugin = host.load();
    await setImmediate();
    const afterStartup = host.sends.length;
    plugin.unload();
    plugin = host.load();
    await setImmediate();
    acknowledge();
    await setImmediate();
    expect(
      "auto-compact-restart-recovers-missed-idle-once",
      beforeIdle === SINGLE_REQUEST_COUNT &&
        host.sends[FIRST_REQUEST_INDEX]?.mode === STEER_MODE &&
        afterStartup === beforeIdle + SINGLE_REQUEST_COUNT &&
        host.sends.length === afterStartup &&
        isContinuation(host.sends[beforeIdle], true) &&
        host.compactCalls === ZERO_COUNT &&
        host.errors.length === ZERO_COUNT,
      {
        beforeIdle,
        afterStartup,
        requests: host.sends.length,
        errors: host.errors,
      },
    );
  } finally {
    acknowledge();
    plugin.unload();
    host.close();
  }
}

/** Restores the persisted breaker and keeps a stopped yield quiescent across reloads. */
async function verifyCappedAndStopped(expect: ExpectFn): Promise<void> {
  const capped = createRestartHarness();
  const stopped = createRestartHarness();
  capped.seedCappedYield();
  capped.finish(false);
  const cappedPlugin = capped.load();
  let stoppedPlugin = stopped.load();
  try {
    await stoppedPlugin.emit(ACTIVE_EVENTS_TOPIC);
    stoppedPlugin.unload();
    stopped.finish(true);
    stoppedPlugin = stopped.load();
    await setImmediate();
    await stoppedPlugin.emit(IDLE_TOPIC);
    expect(
      "auto-compact-restart-honors-cap-and-stop",
      capped.sends.length === SINGLE_REQUEST_COUNT &&
        isContinuation(capped.sends[FIRST_REQUEST_INDEX], false) &&
        capped.compactCalls === ZERO_COUNT &&
        stopped.sends.length === SINGLE_REQUEST_COUNT &&
        stopped.sends[FIRST_REQUEST_INDEX]?.mode === STEER_MODE &&
        stopped.compactCalls === ZERO_COUNT &&
        capped.errors.length === ZERO_COUNT &&
        stopped.errors.length === ZERO_COUNT,
      {
        cappedRequests: capped.sends.map(({ mode }) => mode),
        stoppedRequests: stopped.sends.map(({ mode }) => mode),
        stoppedCompactions: stopped.compactCalls,
        errors: [...capped.errors, ...stopped.errors],
      },
    );
  } finally {
    cappedPlugin.unload();
    stoppedPlugin.unload();
    capped.close();
    stopped.close();
  }
}

/** Verifies startup and replay against full registration with the SDK boundary stubbed. */
export async function runAutoCompactRestartSmokeScenarios(
  expect: ExpectFn,
): Promise<void> {
  await verifyMissedIdle(expect);
  await verifyCappedAndStopped(expect);
}
