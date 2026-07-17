import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCursorSnapshot, readCursorActivity, NOT_WIRED } from "./cursor.js";

const SAVED_DB = process.env["SPEND_AXI_CURSOR_DB"];
beforeAll(() => {
  delete process.env["SPEND_AXI_CURSOR_DB"];
});
afterAll(() => {
  if (SAVED_DB !== undefined) process.env["SPEND_AXI_CURSOR_DB"] = SAVED_DB;
});

function createTestDb(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "spend-axi-cursor-"));
  const path = join(dir, "ai-code-tracking.db");
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE ai_code_hashes (
      hash TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      fileExtension TEXT,
      fileName TEXT,
      requestId TEXT,
      conversationId TEXT,
      timestamp INTEGER,
      model TEXT,
      createdAt INTEGER NOT NULL
    );
  `);
  return { dir, path, db };
}

function insertRow(db: DatabaseSync, model: string, createdAtMs: number): void {
  db.prepare(
    "INSERT INTO ai_code_hashes (hash, source, model, createdAt) VALUES (?, ?, ?, ?)",
  ).run(`h-${createdAtMs}-${model}`, "test", model, createdAtMs);
}

function msForDate(dateStr: string, hour = 12): number {
  return Date.parse(`${dateStr}T${String(hour).padStart(2, "0")}:00:00Z`);
}

describe("readCursorActivity", () => {
  it("returns dbPresent:false when the DB is missing", () => {
    const a = readCursorActivity({
      dbPath: "/tmp/spend-axi-no-such-db",
      today: "2026-07-17",
    });
    expect(a.dbPresent).toBe(false);
    expect(a.requestsToday).toBe(0);
    expect(a.modelsToday).toEqual([]);
  });

  it("counts today's requests + distinct models (most-used first)", () => {
    const { dir, path, db } = createTestDb();
    try {
      const today = "2026-07-17";
      insertRow(db, "composer-2.5", msForDate(today, 10));
      insertRow(db, "composer-2.5", msForDate(today, 11));
      insertRow(db, "gpt-5.2", msForDate(today, 12));
      insertRow(db, "composer-2.5", msForDate("2026-07-16", 10)); // yesterday, excluded
      const a = readCursorActivity({ dbPath: path, today });
      expect(a.dbPresent).toBe(true);
      expect(a.requestsToday).toBe(3);
      expect(a.modelsToday).toEqual(["composer-2.5", "gpt-5.2"]);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns 0 requests when the DB has no rows for today", () => {
    const { dir, path, db } = createTestDb();
    try {
      insertRow(db, "composer-2.5", msForDate("2026-07-16", 10));
      const a = readCursorActivity({ dbPath: path, today: "2026-07-17" });
      expect(a.requestsToday).toBe(0);
      expect(a.modelsToday).toEqual([]);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns an error state when the table is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "spend-axi-cursor-"));
    const path = join(dir, "empty.db");
    try {
      new DatabaseSync(path).close(); // create an empty DB with no ai_code_hashes table
      const a = readCursorActivity({ dbPath: path, today: "2026-07-17" });
      expect(a.dbPresent).toBe(true);
      expect(a.error).toBeDefined();
      expect(a.requestsToday).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("buildCursorSnapshot", () => {
  it("flags dollar spend as not-wired with the live cap", () => {
    const snap = buildCursorSnapshot(50, {
      dbPresent: true,
      requestsToday: 2,
      modelsToday: ["composer-2.5"],
    });
    expect(snap.spendUsd).toBe(NOT_WIRED);
    expect(snap.headroomUsd).toBe(NOT_WIRED);
    expect(snap.pctUsed).toBe(NOT_WIRED);
    expect(snap.dailyCapUsd).toBe(50);
    expect(snap.status).toBe("not-wired");
    expect(snap.note.toLowerCase()).toContain("not yet readable");
    expect(snap.activity.requestsToday).toBe(2);
  });

  it("honors the configured cap", () => {
    const snap = buildCursorSnapshot(60, { dbPresent: false, requestsToday: 0, modelsToday: [] });
    expect(snap.dailyCapUsd).toBe(60);
  });
});
