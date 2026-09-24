import { randomUUID } from "node:crypto";
import { chmodSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

interface Migration {
  version: number;
  name: string;
  sql: string;
}

const migrations: readonly Migration[] = [
  {
    version: 1,
    name: "content_jobs",
    // IF NOT EXISTS adopts the original unversioned database without replacing
    // any job, lease, fingerprint, or provider receipt.
    sql: `
      CREATE TABLE IF NOT EXISTS postiz_content_jobs (
        id TEXT PRIMARY KEY,
        brand_id TEXT NOT NULL,
        content_fingerprint TEXT NOT NULL,
        input_json TEXT NOT NULL,
        output_json TEXT,
        state TEXT NOT NULL CHECK (state IN (
          'queued','processing','ready','rejected','submitting',
          'submitted','unknown','failed'
        )),
        mode TEXT NOT NULL CHECK (mode IN ('draft','schedule')),
        scheduled_at TEXT,
        postiz_id TEXT,
        postiz_state TEXT,
        platform_post_id TEXT,
        platform_url TEXT,
        last_error TEXT,
        failure_phase TEXT CHECK (failure_phase IN ('generation','submission')),
        lease_token TEXT,
        lease_owner TEXT,
        lease_expires_at INTEGER,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (brand_id, content_fingerprint)
      );
      CREATE INDEX IF NOT EXISTS postiz_content_jobs_claim
        ON postiz_content_jobs (brand_id, state, created_at, id);
      CREATE UNIQUE INDEX IF NOT EXISTS postiz_content_jobs_receipt
        ON postiz_content_jobs (postiz_id) WHERE postiz_id IS NOT NULL;
    `,
  },
  {
    version: 2,
    name: "audit_events",
    sql: `
      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY,
        job_id TEXT,
        brand_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        actor TEXT NOT NULL,
        reason TEXT NOT NULL,
        before_json TEXT,
        after_json TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS audit_events_job
        ON audit_events (job_id, created_at, id);
      CREATE INDEX IF NOT EXISTS audit_events_brand
        ON audit_events (brand_id, created_at, id);
    `,
  },
];

export const CONTENT_SCHEMA_VERSION = migrations[migrations.length - 1].version;

function appliedMigrations(db: DatabaseSync) {
  const exists = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
    )
    .get();
  return exists
    ? db
        .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
        .all()
    : [];
}

function validateHistory(rows: ReturnType<typeof appliedMigrations>): void {
  for (const [index, row] of rows.entries()) {
    const migration = migrations[index];
    if (
      !migration ||
      row.version !== migration.version ||
      row.name !== migration.name
    ) {
      throw new Error(
        "Database migration history is newer than or incompatible with this application",
      );
    }
  }
}

/**
 * Synchronous startup migration. Existing databases receive a consistent SQLite
 * backup before any schema changes; copying only the main file could lose WAL
 * data. Failed backups abort startup. Retain these backups until reviewed.
 */
export function migrateContentDatabase(
  db: DatabaseSync,
  options: { databasePath: string; now?: () => number },
): { version: number; backupPath: string | null } {
  const now = options.now ?? Date.now;
  const applied = appliedMigrations(db);
  validateHistory(applied);
  let backupPath: string | null = null;
  const hasTables = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1",
    )
    .get();
  if (
    hasTables &&
    applied.length < migrations.length &&
    options.databasePath !== ":memory:"
  ) {
    backupPath = `${options.databasePath}.pre-v${CONTENT_SCHEMA_VERSION}-${now()}-${randomUUID().slice(0, 8)}.sqlite`;
    db.prepare("VACUUM main INTO ?").run(backupPath);
    chmodSync(backupPath, 0o600);
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    // Another process may have completed migrations while this one backed up.
    const current = appliedMigrations(db);
    validateHistory(current);
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      );
    `);
    for (const migration of migrations.slice(current.length)) {
      db.exec(migration.sql);
      db.prepare(
        "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
      ).run(migration.version, migration.name, now());
    }
    db.exec("COMMIT");
    return { version: CONTENT_SCHEMA_VERSION, backupPath };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
