import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { migrateContentDatabase } from "./migrations.js";
import { validateJobInput } from "./validation.js";
import {
  ContentOperationsStore,
  type GenerationQuotaOptions,
} from "./operations-store.js";
import { JobConflictError, LeaseLostError } from "./store-errors.js";
export { JobConflictError, LeaseLostError } from "./store-errors.js";
export type {
  ContentCandidate,
  ContentTopic,
  SourceCheckpoint,
  SourceCheckpointState,
  GenerationQuota,
  GenerationAttempt,
  SelectionModelCall,
  GenerationQuotaOptions,
  CandidateStatus,
  CandidateBatch,
} from "./operations-store.js";

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
  /** Applied to generation claims only; hard maximum is three starts per day. */
  quota?: GenerationQuotaOptions;
}

export interface PostizReceipt {
  postizId: string;
  postizState?: string;
  platformPostId?: string;
  platformUrl?: string;
}

export interface OperatorAction {
  reason?: string;
  actor?: string;
}

export interface RepairFailedJob {
  reason: string;
  actor?: string;
  /** Replaces only input.brand; source and account identities stay fixed. */
  brandSnapshot?: unknown;
  toDraft?: boolean;
}

export interface AuditEvent {
  id: string;
  jobId: string | null;
  brandId: string;
  eventType: string;
  actor: string;
  reason: string;
  before: unknown | null;
  after: unknown | null;
  createdAt: number;
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
export class ContentJobStore extends ContentOperationsStore {
  readonly migrationBackupPath: string | null;

  constructor(path: string, options: { now?: () => number } = {}) {
    const now = options.now ?? Date.now;
    const db = new DatabaseSync(path);
    let backupPath: string | null;
    try {
      db.exec(`
        PRAGMA busy_timeout = 5000;
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
      `);
      backupPath = migrateContentDatabase(db, {
        databasePath: path,
        now,
      }).backupPath;
    } catch (error) {
      db.close();
      throw error;
    }
    super(db, now);
    this.migrationBackupPath = backupPath;
  }

  close(): void {
    this.db.close();
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

  private auditJob(
    eventType: string,
    before: ContentJob,
    after: ContentJob,
    action: { reason: string; actor?: string },
  ): void {
    this.db
      .prepare(
        `INSERT INTO audit_events (
          id, job_id, brand_id, event_type, actor, reason,
          before_json, after_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        before.id,
        before.brandId,
        eventType,
        requiredText(action.actor ?? "operator", "actor"),
        requiredText(action.reason, "reason"),
        json(before),
        json(after),
        this.now(),
      );
  }

  listAuditEvents(
    options: { jobId?: string; brandId?: string; limit?: number } = {},
  ): AuditEvent[] {
    const filters: string[] = [];
    const values: BindValue[] = [];
    if (options.jobId !== undefined) {
      filters.push("job_id = ?");
      values.push(options.jobId);
    }
    if (options.brandId !== undefined) {
      filters.push("brand_id = ?");
      values.push(options.brandId);
    }
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000) {
      throw new TypeError("limit must be an integer between 1 and 10000");
    }
    return this.db
      .prepare(
        `SELECT * FROM audit_events
         ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""}
         ORDER BY created_at, rowid LIMIT ?`,
      )
      .all(...values, limit)
      .map((row) => ({
        id: String(row.id),
        jobId: nullableText(row.job_id),
        brandId: String(row.brand_id),
        eventType: String(row.event_type),
        actor: String(row.actor),
        reason: String(row.reason),
        before:
          row.before_json === null ? null : JSON.parse(String(row.before_json)),
        after:
          row.after_json === null ? null : JSON.parse(String(row.after_json)),
        createdAt: Number(row.created_at),
      }));
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
      // Writing starts use the persisted evidence score. Legacy jobs without a
      // selected topic have score zero; submission order remains oldest first.
      const order =
        to === "processing"
          ? `(SELECT COALESCE(MAX(CAST(json_extract(evidence.value, '$.totalScore') AS REAL)), 0)
            FROM content_topics topic, json_each(topic.source_metadata_json) evidence
            WHERE topic.job_id = postiz_content_jobs.id AND topic.merged_into_topic_id IS NULL) DESC, created_at, id`
          : "created_at, id";
      const row = this.db
        .prepare(
          `
        SELECT id,brand_id FROM postiz_content_jobs WHERE ${filters.join(" AND ")}
        ORDER BY ${order} LIMIT 1
      `,
        )
        .get(...values);
      if (!row) return null;
      const id = String(row.id);
      if (
        to === "processing" &&
        !this.reserveWritingAttempt({
          ...options.quota,
          brandId: String(row.brand_id),
          jobId: id,
          kind: "generation",
        })
      )
        return null;
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
  retry(id: string, action: OperatorAction = {}): ContentJob {
    return this.transaction(() => {
      const job = this.requireJob(id);
      this.requireRepairable(job);
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
      const after = this.requireJob(id);
      this.auditJob("job.retried", job, after, {
        ...action,
        reason: action.reason ?? "Explicit operator retry",
      });
      return after;
    });
  }

  private requireRepairable(job: ContentJob): void {
    if (
      !["failed", "rejected"].includes(job.state) ||
      job.postizId !== null ||
      job.platformPostId !== null ||
      job.platformUrl !== null
    ) {
      throw new JobConflictError(
        "Only failed or rejected jobs without a provider receipt can be repaired or retried",
      );
    }
  }

  /**
   * Explicit repair never creates a new identity or releases deduplication.
   * Regeneration is required after every repair; the audit retains the old
   * output and errors even when the live job is reset to queued.
   */
  repairFailed(id: string, options: RepairFailedJob): ContentJob {
    requiredText(options.reason, "reason");
    if (options.toDraft !== undefined && typeof options.toDraft !== "boolean") {
      throw new TypeError("toDraft must be a boolean");
    }
    return this.transaction(() => {
      const before = this.requireJob(id);
      this.requireRepairable(before);
      const original = before.input;
      if (
        !original ||
        typeof original !== "object" ||
        Array.isArray(original)
      ) {
        throw new JobConflictError(
          "Cannot repair a job with invalid persisted input",
        );
      }
      const input = { ...(original as Record<string, unknown>) };
      if (options.brandSnapshot !== undefined)
        input.brand = options.brandSnapshot;
      const brand = input.brand;
      if (
        !brand ||
        typeof brand !== "object" ||
        Array.isArray(brand) ||
        (brand as Record<string, unknown>).id !== before.brandId
      ) {
        throw new JobConflictError(
          "A repaired brand snapshot must keep the job's brand ID",
        );
      }
      // Shared validation checks the final snapshot and its existing sources
      // even for a mode-only repair. Preserve account and source values as stored.
      input.brand = validateJobInput(input).brand;
      this.db
        .prepare(
          `UPDATE postiz_content_jobs SET input_json = ?, mode = ?, scheduled_at = ?,
            state = 'queued', output_json = NULL, last_error = NULL,
            failure_phase = NULL, lease_token = NULL, lease_owner = NULL,
            lease_expires_at = NULL, updated_at = ? WHERE id = ?`,
        )
        .run(
          json(input),
          options.toDraft ? "draft" : before.mode,
          options.toDraft ? null : before.scheduledAt,
          this.now(),
          id,
        );
      const after = this.requireJob(id);
      this.auditJob("job.repaired", before, after, options);
      return after;
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
