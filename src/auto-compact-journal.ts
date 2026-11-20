/** Persists only the watermarks needed to recover yielded work across plugin reloads. */
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { ThreadAutoCompactState } from "./auto-compact-state.ts";

/** Turn identity and loop limits must survive the coordinator's in-memory cache. */
export type JournalState = Pick<
  ThreadAutoCompactState,
  | "lastAttemptedMidTurnSeq"
  | "lastAttemptedIdleTurnSeq"
  | "lastUserRequestSeq"
  | "consecutiveAutoCompactions"
  | "awaitingDropOrNewTurn"
>;

/** SQLite stores the rearm latch as an integer, while the policy consumes a boolean. */
type JournalRow = Omit<JournalState, "awaitingDropOrNewTurn"> & {
  readonly awaitingDropOrNewTurn: number;
};
const LATCH_SET = 1 as const;

/** Migration indexes and statement text are immutable after release. */
const MIGRATIONS = [
  `CREATE TABLE auto_compact_journal (
    threadId TEXT PRIMARY KEY NOT NULL,
    lastAttemptedMidTurnSeq INTEGER,
    lastAttemptedIdleTurnSeq INTEGER,
    lastUserRequestSeq INTEGER NOT NULL,
    consecutiveAutoCompactions INTEGER NOT NULL
  )`,
  "ALTER TABLE auto_compact_journal ADD COLUMN awaitingDropOrNewTurn INTEGER NOT NULL DEFAULT 0 CHECK (awaitingDropOrNewTurn IN (0, 1))",
  // Older rows cannot distinguish a cleared latch from a completed compaction.
  "UPDATE auto_compact_journal SET awaitingDropOrNewTurn = 1 WHERE lastAttemptedIdleTurnSeq IS NOT NULL",
];
const READ = `SELECT lastAttemptedMidTurnSeq, lastAttemptedIdleTurnSeq,
  lastUserRequestSeq, consecutiveAutoCompactions, awaitingDropOrNewTurn
  FROM auto_compact_journal WHERE threadId = ?`;
const SAVE = `INSERT INTO auto_compact_journal
  (threadId, lastAttemptedMidTurnSeq, lastAttemptedIdleTurnSeq,
   lastUserRequestSeq, consecutiveAutoCompactions, awaitingDropOrNewTurn)
  VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(threadId) DO UPDATE SET
  lastAttemptedMidTurnSeq = excluded.lastAttemptedMidTurnSeq,
  lastAttemptedIdleTurnSeq = excluded.lastAttemptedIdleTurnSeq,
  lastUserRequestSeq = excluded.lastUserRequestSeq,
  consecutiveAutoCompactions = excluded.consecutiveAutoCompactions,
  awaitingDropOrNewTurn = excluded.awaitingDropOrNewTurn`;
const CLEAR_LATCH =
  "UPDATE auto_compact_journal SET awaitingDropOrNewTurn = 0 WHERE threadId = ? AND awaitingDropOrNewTurn = 1";
const REMOVE = "DELETE FROM auto_compact_journal WHERE threadId = ?";
const PENDING = `SELECT threadId FROM auto_compact_journal
  WHERE lastAttemptedMidTurnSeq IS NOT NULL AND
    (lastAttemptedIdleTurnSeq IS NULL OR lastAttemptedIdleTurnSeq < lastAttemptedMidTurnSeq)`;

/** Keeps per-thread decisions durable independently of event subscriptions. */
export class AutoCompactJournal {
  private readonly readRow;
  private readonly saveRow;
  private readonly removeRow;
  private readonly clearLatch;
  private readonly pendingRows;

  /** Shares the database handle owned and closed by the plugin host. */
  constructor(storage: BbPluginApi["storage"]) {
    const database = storage.database();
    storage.migrate(database, MIGRATIONS);
    this.readRow = database.prepare<[string], JournalRow>(READ);
    this.saveRow = database.prepare(SAVE);
    this.removeRow = database.prepare(REMOVE);
    this.clearLatch = database.prepare(CLEAR_LATCH);
    this.pendingRows = database.prepare<[], { threadId: string }>(PENDING);
  }

  /** Restores prior attempts so a replay cannot steer the same turn again. */
  read(threadId: string): JournalState | undefined {
    const row = this.readRow.get(threadId);
    return (
      row && {
        ...row,
        awaitingDropOrNewTurn: row.awaitingDropOrNewTurn === LATCH_SET,
      }
    );
  }

  /** Writes correlated watermarks atomically to preserve loop limits on restart. */
  save(threadId: string, state: JournalState): void {
    this.saveRow.run(
      threadId,
      state.lastAttemptedMidTurnSeq,
      state.lastAttemptedIdleTurnSeq,
      state.lastUserRequestSeq,
      state.consecutiveAutoCompactions,
      Number(state.awaitingDropOrNewTurn),
    );
  }

  /** Clears even an evicted latch after a real drop without creating rows for low-usage threads. */
  clearAwaitingDrop(threadId: string): void {
    // Most below-threshold observations belong to threads with no journal row.
    if (this.readRow.get(threadId)?.awaitingDropOrNewTurn === LATCH_SET) {
      this.clearLatch.run(threadId);
    }
  }

  /** Retires state once its thread no longer needs recovery. */
  delete(threadId: string): void {
    this.removeRow.run(threadId);
  }

  /** Limits startup reconciliation to threads whose last yield may need settlement. */
  pendingThreadIds(): string[] {
    const rows: { threadId: string }[] = this.pendingRows.all();
    return rows.map((row) => row.threadId);
  }
}
