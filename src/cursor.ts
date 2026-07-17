import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { cursorDbPath } from "./config.js";

/**
 * Cursor on-demand DOLLAR spend is NOT readable via any programmatic source
 * right now (captain ruling 2026-07-17, confirmed live):
 *   - `cursor-agent` CLI has no usage/billing/spend subcommand (only
 *     status/whoami/about/models).
 *   - The local `ai-code-tracking.db` tracks AI-generated code activity, not
 *     dollars (no cost/price column), and only the editor writes to it.
 *   - Cursor's server usage API (api2.cursor.sh) needs the OAuth token, which
 *     lives in the OS keychain (locked; quota-axi also reports cursor
 *     auth_required).
 *
 * This module surfaces the one real local usage signal — today's AI request
 * activity from the SQLite DB — clearly labeled as ACTIVITY (not spend), and a
 * config hook (`dailyCapUsd`) so the moment a usage-$ source is wired, the
 * headroom math activates. The `spend-axi/src/cursor.ts` wire-point is the
 * single place to add a `readCursorSpendUsd()` that returns a number.
 */
export const NOT_WIRED = "not wired";
const CURSOR_NOTE =
  "cursor $ spend not yet readable via API/CLI; wire a source in src/cursor.ts (daily cap config already live)";

export interface CursorActivity {
  /** Whether the local ai-code-tracking DB exists at the resolved path. */
  dbPresent: boolean;
  /** AI requests logged today (UTC) — ACTIVITY, not dollars. */
  requestsToday: number;
  /** Distinct models used today, most-used first. */
  modelsToday: string[];
  /** Set when the DB is present but the query failed (locked / missing table). */
  error?: string;
}

export interface CursorSnapshot {
  spendUsd: string;
  headroomUsd: string;
  pctUsed: string;
  dailyCapUsd: number;
  status: string;
  activity: CursorActivity;
  note: string;
}

export interface CursorOptions {
  dbPath?: string;
  /** Test override for "today" (UTC YYYY-MM-DD). */
  today?: string;
}

/**
 * Read today's Cursor request activity from the local ai-code-tracking DB.
 * Never throws: returns a clear error state so the snapshot stays complete.
 */
export function readCursorActivity(opts: CursorOptions = {}): CursorActivity {
  const dbPath = opts.dbPath ?? cursorDbPath();
  if (!existsSync(dbPath)) {
    return { dbPresent: false, requestsToday: 0, modelsToday: [] };
  }
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const countRow = db
      .prepare(
        "SELECT count(*) AS n FROM ai_code_hashes WHERE date(createdAt / 1000, 'unixepoch') = ?",
      )
      .get(today) as { n: number } | undefined;
    const requestsToday = Number(countRow?.n ?? 0);
    const modelRows = db
      .prepare(
        "SELECT model, count(*) AS n FROM ai_code_hashes WHERE date(createdAt / 1000, 'unixepoch') = ? GROUP BY model ORDER BY n DESC",
      )
      .all(today) as Array<{ model: string | null; n: number }>;
    const modelsToday = modelRows
      .map((r) => r.model)
      .filter((m): m is string => typeof m === "string" && m.length > 0);
    return { dbPresent: true, requestsToday, modelsToday };
  } catch (error) {
    return {
      dbPresent: true,
      requestsToday: 0,
      modelsToday: [],
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    try {
      db?.close();
    } catch {
      // already closed / failed — ignore
    }
  }
}

/**
 * Build the cursor snapshot. Dollar spend is flagged not-wired until a source
 * is wired in this module; the daily cap is read live from config so headroom
 * math activates the moment `readCursorSpendUsd()` returns a number.
 */
export function buildCursorSnapshot(dailyCapUsd: number, activity: CursorActivity): CursorSnapshot {
  return {
    spendUsd: NOT_WIRED,
    headroomUsd: NOT_WIRED,
    pctUsed: NOT_WIRED,
    dailyCapUsd,
    status: "not-wired",
    activity,
    note: CURSOR_NOTE,
  };
}
