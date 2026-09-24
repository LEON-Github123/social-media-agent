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
  {
    version: 3,
    name: "content_operations",
    sql: `
      CREATE TABLE content_candidates (
        id TEXT PRIMARY KEY,
        brand_id TEXT NOT NULL,
        url_key TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        origin TEXT NOT NULL,
        source_id TEXT,
        input_json TEXT NOT NULL,
        document_json TEXT,
        primary_source INTEGER NOT NULL DEFAULT 0,
        fetch_state TEXT NOT NULL CHECK (fetch_state IN ('pending','fetched','failed')),
        status TEXT NOT NULL CHECK (status IN ('new','selected','rejected','needs_review','failed')),
        topic_id TEXT,
        legacy_job_ids_json TEXT NOT NULL DEFAULT '[]',
        legacy_conflict INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (brand_id, url_key, content_hash)
      );
      CREATE INDEX content_candidates_queue ON content_candidates (brand_id, status, created_at, id);
      CREATE TABLE candidate_origins (
        candidate_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        origin TEXT NOT NULL,
        first_seen_at INTEGER NOT NULL,
        PRIMARY KEY (candidate_id, source_id, origin)
      );
      CREATE TABLE source_checkpoints (
        brand_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        origin TEXT NOT NULL,
        primary_source INTEGER NOT NULL DEFAULT 0,
        config_hash TEXT,
        checkpoint_json TEXT,
        checked_at INTEGER,
        next_check_at INTEGER NOT NULL DEFAULT 0,
        last_failure TEXT,
        failure_count INTEGER NOT NULL DEFAULT 0,
        lease_token TEXT,
        lease_owner TEXT,
        lease_until INTEGER,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (brand_id, source_id)
      );
      CREATE INDEX source_checkpoints_due ON source_checkpoints (brand_id, next_check_at, checked_at);
      CREATE TABLE content_topics (
        id TEXT PRIMARY KEY,
        brand_id TEXT NOT NULL,
        identity_key TEXT NOT NULL,
        identity_json TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('ready','needs_review','rejected','existing')),
        reason TEXT NOT NULL,
        source_candidate_ids_json TEXT NOT NULL,
        source_metadata_json TEXT NOT NULL,
        proposed_identity_key TEXT,
        conflicting_topic_ids_json TEXT NOT NULL DEFAULT '[]',
        merged_into_topic_id TEXT,
        job_id TEXT UNIQUE,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (brand_id, identity_key)
      );
      CREATE TABLE topic_candidate_links (
        topic_id TEXT NOT NULL,
        candidate_id TEXT NOT NULL UNIQUE,
        PRIMARY KEY (topic_id, candidate_id)
      );
      CREATE INDEX content_topics_brand ON content_topics (brand_id, created_at, id);
      CREATE TABLE generation_attempts (
        id TEXT PRIMARY KEY,
        brand_id TEXT NOT NULL,
        job_id TEXT,
        kind TEXT NOT NULL CHECK (kind IN ('generation','preview')),
        day_key TEXT NOT NULL,
        time_zone TEXT NOT NULL,
        started_at INTEGER NOT NULL
      );
      CREATE INDEX generation_attempts_daily ON generation_attempts (brand_id, started_at);
      CREATE TABLE selection_model_calls (
        id TEXT PRIMARY KEY,
        brand_id TEXT NOT NULL,
        task TEXT NOT NULL CHECK (task IN ('selection','selection_review')),
        candidate_ids_json TEXT NOT NULL,
        started_at INTEGER NOT NULL
      );
      CREATE INDEX selection_model_calls_daily ON selection_model_calls (brand_id, started_at);
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
  const existingTables = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1",
    )
    .get();
  if (
    existingTables &&
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
