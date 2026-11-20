/** Connects persisted recovery to bb lifecycle events after all listeners are in place. */
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { AutoCompactor } from "./auto-compact.ts";
import {
  AutoCompactSdkClient,
  defineAutoCompactSettings,
} from "./auto-compact-client.ts";
import { AutoCompactJournal } from "./auto-compact-journal.ts";
import { ThreadAutoCompactStore } from "./auto-compact-state.ts";

/**
 * Registers the auto-compaction settings and thread lifecycle listeners;
 * called once from the server entry.
 */
export function registerAutoCompaction(bb: BbPluginApi): void {
  const settings = defineAutoCompactSettings(bb);
  const lifecycle = new AbortController();
  const journal = new AutoCompactJournal(bb.storage);
  const store = new ThreadAutoCompactStore(undefined, journal);
  const compactor = new AutoCompactor(
    new AutoCompactSdkClient(bb, settings, lifecycle.signal),
    lifecycle,
    store,
  );

  bb.events.on("thread.active", ({ thread }) => {
    compactor.handleThreadActive(thread.id);
  });
  bb.events.on("experimental_thread.events", ({ thread }) =>
    compactor.handleThreadEvents(thread),
  );
  bb.events.on("thread.idle", ({ thread }) =>
    compactor.handleThreadIdle(thread),
  );
  bb.events.on("thread.failed", ({ thread }) => {
    compactor.handleThreadFailed(thread.id);
  });
  bb.events.on("thread.archived", ({ thread }) => {
    compactor.forgetThread(thread.id);
  });
  bb.events.on("thread.deleted", ({ thread }) => {
    compactor.forgetThread(thread.id);
  });
  bb.onDispose(() => {
    compactor.dispose();
  });
  // Serial reads keep a server restart from flooding the SDK with simultaneous RPCs.
  void (async () => {
    for (const threadId of journal.pendingThreadIds()) {
      if (lifecycle.signal.aborted) break;
      await compactor.recoverYield(threadId);
    }
  })().catch((error: unknown) =>
    bb.log.error(`Auto-compaction recovery failed: ${String(error)}`),
  );
}
