import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export type ContentJobState =
  | "queued"
  | "processing"
  | "ready"
  | "rejected"
  | "submitting"
  | "submitted"
  | "unknown"
  | "failed";

export type ContentJobMode = "draft" | "schedule";

export interface ContentJob {
  id: string;
  brandId: string;
  contentFingerprint: string;
  input: unknown;
  output: unknown | null;
  state: ContentJobState;
  mode: ContentJobMode;
  scheduledAt: string | null;
  postizId: string | null;
  /** The provider's observed state; submitted does not mean published. */
  postizState: string | null;
  platformPostId: string | null;
  platformUrl: string | null;
  lastError: string | null;
  failurePhase: "generation" | "submission" | null;
  leaseToken: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
  attemptCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface ClaimedContentJob extends ContentJob {
  state: "processing" | "submitting";
  leaseToken: string;
  leaseOwner: string;
  leaseExpiresAt: number;
}

export interface EnqueueContentJob {
  id: string;
  brandId: string;
  contentFingerprint: string;
  input: unknown;
  mode: ContentJobMode;
  scheduledAt?: string | null;
}

export interface ClaimContentJob {
  workerId: string;
  leaseMs: number;
  jobId?: string;
  brandId?: string;
}

export interface PostizReceipt {
  postizId: string;
  postizState?: string;
  platformPostId?: string;
  platformUrl?: string;
}

export class LeaseLostError extends Error {
  constructor(id: string) {
    super(`Content job ${id} is no longer owned by this lease`);
    this.name = "LeaseLostError";
  }
}

export class JobConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobConflictError";
  }
}

type BindValue = string | number | null;
type Row = Record<string, unknown>;

function requiredText(value: string, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function json(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new TypeError("Content job data must be JSON serializable");
  }
  return encoded;
}

function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

/**
 * Persists content work and its Postiz receipt, not a second platform scheduler.
 * A submission lease is committed before POST /posts. If its outcome is lost,
 * recovery quarantines the job instead of repeating that non-idempotent POST.
 */
export class ContentJobStore {
  private readonly db: DatabaseSync;
  private readonly now: () => number;

  constructor(path: string, options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
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
    `);
  }

  close(): void {
    this.db.close();
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private fromRow(row: Row): ContentJob {
    return {
      id: String(row.id),
      brandId: String(row.brand_id),
      contentFingerprint: String(row.content_fingerprint),
      input: JSON.parse(String(row.input_json)),
      output:
        row.output_json === null ? null : JSON.parse(String(row.output_json)),
      state: row.state as ContentJobState,
      mode: row.mode as ContentJobMode,
      scheduledAt: nullableText(row.scheduled_at),
      postizId: nullableText(row.postiz_id),
      postizState: nullableText(row.postiz_state),
      platformPostId: nullableText(row.platform_post_id),
      platformUrl: nullableText(row.platform_url),
      lastError: nullableText(row.last_error),
      failurePhase: row.failure_phase as ContentJob["failurePhase"],
      leaseToken: nullableText(row.lease_token),
      leaseOwner: nullableText(row.lease_owner),
      leaseExpiresAt:
        row.lease_expires_at === null ? null : Number(row.lease_expires_at),
      attemptCount: Number(row.attempt_count),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  get(id: string): ContentJob | null {
    const row = this.db
      .prepare("SELECT * FROM postiz_content_jobs WHERE id = ?")
      .get(id);
    return row ? this.fromRow(row) : null;
  }

  private requireJob(id: string): ContentJob {
    const job = this.get(id);
    if (!job) throw new JobConflictError(`Content job ${id} does not exist`);
    return job;
  }

  list(
    options: {
      state?: ContentJobState;
      brandId?: string;
      limit?: number;
      orderBy?: "createdAt" | "updatedAt";
    } = {},
  ): ContentJob[] {
    const filters: string[] = [];
    const values: BindValue[] = [];
    if (options.state !== undefined) {
      filters.push("state = ?");
      values.push(options.state);
    }
    if (options.brandId !== undefined) {
      filters.push("brand_id = ?");
      values.push(options.brandId);
    }
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000) {
      throw new TypeError("limit must be an integer between 1 and 10000");
    }
    const orderBy = options.orderBy ?? "createdAt";
    if (orderBy !== "createdAt" && orderBy !== "updatedAt") {
      throw new TypeError("orderBy must be createdAt or updatedAt");
    }
    // Select only fixed identifiers; callers cannot inject an SQL sort expression.
    const orderColumn = orderBy === "updatedAt" ? "updated_at" : "created_at";
    values.push(limit);
    return this.db
      .prepare(
        `
      SELECT * FROM postiz_content_jobs
      ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""}
      ORDER BY ${orderColumn}, id LIMIT ?
    `,
      )
      .all(...values)
      .map((row) => this.fromRow(row));
  }

  enqueue(input: EnqueueContentJob): ContentJob {
    requiredText(input.id, "id");
    requiredText(input.brandId, "brandId");
    requiredText(input.contentFingerprint, "contentFingerprint");
    if (input.mode !== "draft" && input.mode !== "schedule") {
      throw new TypeError("mode must be draft or schedule");
    }
    const scheduledAt = input.scheduledAt ?? null;
    if (scheduledAt !== null && !Number.isFinite(Date.parse(scheduledAt))) {
      throw new TypeError("scheduledAt must be a valid date");
    }
    if (input.mode === "schedule" && scheduledAt === null) {
      throw new TypeError("A scheduled job requires scheduledAt");
    }
    const inputJson = json(input.input);
    return this.transaction(() => {
      const byId = this.get(input.id);
      const byFingerprint = this.db
        .prepare(
          `
        SELECT * FROM postiz_content_jobs WHERE brand_id = ? AND content_fingerprint = ?
      `,
        )
        .get(input.brandId, input.contentFingerprint);
      const existing =
        byId ?? (byFingerprint ? this.fromRow(byFingerprint) : null);
      if (existing) {
        if (
          existing.brandId !== input.brandId ||
          existing.contentFingerprint !== input.contentFingerprint ||
          existing.mode !== input.mode ||
          existing.scheduledAt !== scheduledAt ||
          json(existing.input) !== inputJson
        ) {
          throw new JobConflictError(
            "A content job identity cannot be reused with different data",
          );
        }
        return existing;
      }
      const now = this.now();
      this.db
        .prepare(
          `
        INSERT INTO postiz_content_jobs (
          id, brand_id, content_fingerprint, input_json, state, mode,
          scheduled_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?)
      `,
        )
        .run(
          input.id,
          input.brandId,
          input.contentFingerprint,
          inputJson,
          input.mode,
          scheduledAt,
          now,
          now,
        );
      return this.requireJob(input.id);
    });
  }

  private leaseDuration(leaseMs: number): number {
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1) {
      throw new TypeError("leaseMs must be a positive integer");
    }
    return leaseMs;
  }

  private claim(
    options: ClaimContentJob,
    from: "queued" | "ready",
    to: "processing" | "submitting",
  ): ClaimedContentJob | null {
    requiredText(options.workerId, "workerId");
    this.leaseDuration(options.leaseMs);
    return this.transaction(() => {
      const filters = ["state = ?"];
      const values: BindValue[] = [from];
      if (options.jobId !== undefined) {
        filters.push("id = ?");
        values.push(options.jobId);
      }
      if (options.brandId !== undefined) {
        filters.push("brand_id = ?");
        values.push(options.brandId);
      }
      const row = this.db
        .prepare(
          `
        SELECT id FROM postiz_content_jobs WHERE ${filters.join(" AND ")}
        ORDER BY created_at, id LIMIT 1
      `,
        )
        .get(...values);
      if (!row) return null;
      const id = String(row.id);
      const now = this.now();
      const result = this.db
        .prepare(
          `
        UPDATE postiz_content_jobs SET state = ?, lease_token = ?, lease_owner = ?,
          lease_expires_at = ?, updated_at = ?, attempt_count = attempt_count + 1
        WHERE id = ? AND state = ?
      `,
        )
        .run(
          to,
          randomUUID(),
          options.workerId,
          now + options.leaseMs,
          now,
          id,
          from,
        );
      return Number(result.changes) === 1
        ? (this.requireJob(id) as ClaimedContentJob)
        : null;
    });
  }

  claimGeneration(options: ClaimContentJob): ClaimedContentJob | null {
    return this.claim(options, "queued", "processing");
  }

  /** Call and commit this before making Postiz's non-idempotent create request. */
  claimSubmit(options: ClaimContentJob): ClaimedContentJob | null {
    return this.claim(options, "ready", "submitting");
  }

  renewLease(id: string, token: string, leaseMs: number): ClaimedContentJob {
    this.leaseDuration(leaseMs);
    const now = this.now();
    const result = this.db
      .prepare(
        `
      UPDATE postiz_content_jobs SET lease_expires_at = ?, updated_at = ?
      WHERE id = ? AND lease_token = ? AND lease_expires_at > ?
        AND state IN ('processing', 'submitting')
    `,
      )
      .run(now + leaseMs, now, id, token, now);
    if (Number(result.changes) !== 1) throw new LeaseLostError(id);
    return this.requireJob(id) as ClaimedContentJob;
  }

  private finishLease(
    id: string,
    token: string,
    expected: "processing" | "submitting",
    assignments: string,
    values: BindValue[],
  ): ContentJob {
    const now = this.now();
    const result = this.db
      .prepare(
        `
      UPDATE postiz_content_jobs SET ${assignments}, lease_token = NULL,
        lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE id = ? AND state = ? AND lease_token = ? AND lease_expires_at > ?
    `,
      )
      .run(...values, now, id, expected, token, now);
    if (Number(result.changes) !== 1) throw new LeaseLostError(id);
    return this.requireJob(id);
  }

  completeGeneration(
    id: string,
    token: string,
    output: unknown,
    decision: "ready" | "rejected" = "ready",
  ): ContentJob {
    if (decision !== "ready" && decision !== "rejected")
      throw new TypeError("Invalid generation decision");
    return this.finishLease(
      id,
      token,
      "processing",
      "state = ?, output_json = ?, last_error = NULL, failure_phase = NULL",
      [decision, json(output)],
    );
  }

  failGeneration(id: string, token: string, error: string): ContentJob {
    return this.finishLease(
      id,
      token,
      "processing",
      "state = 'failed', last_error = ?, failure_phase = 'generation'",
      [error],
    );
  }

  private receiptValues(receipt: PostizReceipt): BindValue[] {
    requiredText(receipt.postizId, "postizId");
    for (const field of [
      "postizState",
      "platformPostId",
      "platformUrl",
    ] as const) {
      if (receipt[field] !== undefined) requiredText(receipt[field], field);
    }
    return [
      receipt.postizId,
      receipt.postizState ?? null,
      receipt.platformPostId ?? null,
      receipt.platformUrl ?? null,
    ];
  }

  recordSubmitted(
    id: string,
    token: string,
    receipt: PostizReceipt,
  ): ContentJob {
    return this.finishLease(
      id,
      token,
      "submitting",
      `
      state = 'submitted', postiz_id = ?, postiz_state = ?, platform_post_id = ?,
      platform_url = ?, last_error = NULL, failure_phase = NULL
    `,
      this.receiptValues(receipt),
    );
  }

  markUnknown(id: string, token: string, error: string): ContentJob {
    return this.finishLease(
      id,
      token,
      "submitting",
      "state = 'unknown', last_error = ?, failure_phase = 'submission'",
      [error],
    );
  }

  /** Only for a definitive refusal proving no Postiz job was created. */
  failSubmission(id: string, token: string, error: string): ContentJob {
    return this.finishLease(
      id,
      token,
      "submitting",
      "state = 'failed', last_error = ?, failure_phase = 'submission'",
      [error],
    );
  }

  recoverExpired(): { generation: number; submission: number } {
    return this.transaction(() => {
      const now = this.now();
      const generation = this.db
        .prepare(
          `
        UPDATE postiz_content_jobs SET state = 'queued', lease_token = NULL,
          lease_owner = NULL, lease_expires_at = NULL, updated_at = ?,
          last_error = 'Generation lease expired; queued for recovery', failure_phase = NULL
        WHERE state = 'processing' AND lease_expires_at <= ?
      `,
        )
        .run(now, now);
      const submission = this.db
        .prepare(
          `
        UPDATE postiz_content_jobs SET state = 'unknown', lease_token = NULL,
          lease_owner = NULL, lease_expires_at = NULL, updated_at = ?,
          last_error = 'Submission lease expired; verify Postiz before any further action',
          failure_phase = 'submission'
        WHERE state = 'submitting' AND lease_expires_at <= ?
      `,
        )
        .run(now, now);
      return {
        generation: Number(generation.changes),
        submission: Number(submission.changes),
      };
    });
  }

  /** Explicit operator action. Unknown submissions can never be retried here. */
  retry(id: string): ContentJob {
    return this.transaction(() => {
      const job = this.requireJob(id);
      if (job.state !== "failed" && job.state !== "rejected") {
        throw new JobConflictError(`Cannot retry a ${job.state} content job`);
      }
      const state =
        job.state === "failed" && job.failurePhase === "submission"
          ? "ready"
          : "queued";
      this.db
        .prepare(
          `
        UPDATE postiz_content_jobs SET state = ?, last_error = NULL, failure_phase = NULL,
          output_json = CASE WHEN ? = 'queued' THEN NULL ELSE output_json END,
          updated_at = ? WHERE id = ?
      `,
        )
        .run(state, state, this.now(), id);
      return this.requireJob(id);
    });
  }

  /** The caller must first verify the exact existing Postiz ID remotely. */
  bindUnknown(id: string, receipt: PostizReceipt): ContentJob {
    const values = this.receiptValues(receipt);
    const result = this.db
      .prepare(
        `
      UPDATE postiz_content_jobs SET state = 'submitted', postiz_id = ?,
        postiz_state = ?, platform_post_id = ?, platform_url = ?,
        last_error = NULL, failure_phase = NULL, updated_at = ?
      WHERE id = ? AND state = 'unknown'
    `,
      )
      .run(...values, this.now(), id);
    if (Number(result.changes) !== 1)
      throw new JobConflictError(
        "Only an unknown job can bind an existing Postiz receipt",
      );
    return this.requireJob(id);
  }

  /**
   * updatedAt also records sync attempt time so missing remote results cannot
   * monopolize the next batch. A missing result proves nothing about deletion
   * or publishing status; preserve all provider identities and observed state.
   */
  markSyncChecked(id: string): ContentJob {
    const result = this.db
      .prepare(
        `
      UPDATE postiz_content_jobs SET updated_at = ?
      WHERE id = ? AND state = 'submitted'
    `,
      )
      .run(this.now(), id);
    if (Number(result.changes) !== 1) {
      throw new JobConflictError(
        "Only a submitted job can record a sync check",
      );
    }
    return this.requireJob(id);
  }

  recordPlatformResult(id: string, receipt: PostizReceipt): ContentJob {
    this.receiptValues(receipt);
    return this.transaction(() => {
      const job = this.requireJob(id);
      if (job.state !== "submitted" || job.postizId !== receipt.postizId) {
        throw new JobConflictError(
          "Platform result must match the job's recorded Postiz ID",
        );
      }
      if (
        job.platformPostId &&
        receipt.platformPostId &&
        job.platformPostId !== receipt.platformPostId
      ) {
        throw new JobConflictError(
          "Cannot replace an existing platform post identity",
        );
      }
      this.db
        .prepare(
          `
        UPDATE postiz_content_jobs SET postiz_state = COALESCE(?, postiz_state),
          platform_post_id = COALESCE(?, platform_post_id),
          platform_url = COALESCE(?, platform_url), updated_at = ? WHERE id = ?
      `,
        )
        .run(
          receipt.postizState ?? null,
          receipt.platformPostId ?? null,
          receipt.platformUrl ?? null,
          this.now(),
          id,
        );
      return this.requireJob(id);
    });
  }
}
