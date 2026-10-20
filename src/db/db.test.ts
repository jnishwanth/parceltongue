import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { openDb, schemaVersion, type DB } from "./db.js";

const TEMP_DIR = mkdtempSync(join(tmpdir(), "parceltongue-db-"));

afterAll(() => {
  rmSync(TEMP_DIR, { recursive: true, force: true });
});

const TABLES = (db: DB) =>
  (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>
  ).map((r) => r.name);

describe("openDb", () => {
  it("applies the v1 schema to an in-memory database", () => {
    const db = openDb(":memory:");
    try {
      expect(schemaVersion(db)).toBe(1);
      expect(TABLES(db)).toEqual(["events", "packages", "schema_migrations"]);
      // The PRD §7 dedupe key exists as the COALESCE expression index
      // (a plain UNIQUE cannot cover NULL occurred_at — M2 caveat).
      const indexes = (
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
          )
          .all() as Array<{ name: string }>
      ).map((r) => r.name);
      expect(indexes).toEqual(["idx_events_awb", "uq_events_dedupe"]);
      // One migration row, stamped with a UTC ISO time.
      const rows = db
        .prepare("SELECT version, applied_at FROM schema_migrations")
        .all() as Array<{ version: number; applied_at: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.version).toBe(1);
      expect(rows[0]!.applied_at).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
      );
    } finally {
      db.close();
    }
  });

  it("enforces the pragmas on a file database", () => {
    const db = openDb(join(TEMP_DIR, "pragmas.db"));
    try {
      const getPragma = (name: string): unknown => {
        const row = db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown>;
        return Object.values(row)[0];
      };
      expect(getPragma("foreign_keys")).toBe(1);
      expect(getPragma("journal_mode")).toBe("wal");
      expect(getPragma("synchronous")).toBe(1); // NORMAL
      expect(getPragma("busy_timeout")).toBe(5000);
    } finally {
      db.close();
    }
  });

  it("creates missing parent directories for file paths", () => {
    const db = openDb(join(TEMP_DIR, "nested", "deeper", "parceltongue.db"));
    try {
      expect(schemaVersion(db)).toBe(1);
    } finally {
      db.close();
    }
  });

  it("enforces the events → packages foreign key", () => {
    const db = openDb(":memory:");
    try {
      expect(() =>
        db
          .prepare(
            `INSERT INTO events (awb, description, first_seen_at)
             VALUES ('9999999999999', 'no such parcel', '2026-10-20T00:00:00.000Z')`,
          )
          .run(),
      ).toThrow(/FOREIGN KEY constraint failed/);
    } finally {
      db.close();
    }
  });
});

describe("migrations", () => {
  it("are idempotent across reopens of the same file", () => {
    const path = join(TEMP_DIR, "idempotent.db");
    openDb(path).close();

    const db = openDb(path);
    try {
      expect(schemaVersion(db)).toBe(1);
      const rows = db
        .prepare("SELECT COUNT(*) AS n FROM schema_migrations")
        .get() as { n: number };
      expect(rows.n).toBe(1);
      // Schema still intact after the no-op reopen.
      expect(TABLES(db)).toEqual(["events", "packages", "schema_migrations"]);
    } finally {
      db.close();
    }
  });
});
