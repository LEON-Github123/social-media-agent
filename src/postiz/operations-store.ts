import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { fromZonedTime } from "date-fns-tz";
import { JobConflictError, LeaseLostError } from "./store-errors.js";
import {
  normalizeSourceUrl,
  sourceMaterialKey,
  sourceUrlKey,
  stableHash,
} from "./identity.js";
import {
  sourceInputSchema,
  sourceDocumentSchema,
  validateJobInput,
  type SourceInput,
  type SourceDocument,
} from "./validation.js";
import type {
  ExistingTopic,
  SelectionResult,
  TopicIdentity,
  TopicSourceMetadata,
} from "./operations-types.js";
import type { ContentJob, EnqueueContentJob } from "./store.js";
import { conflictingHistory, topicIdentityKey } from "./selector.js";

type Row = Record<string, unknown>;
type Bind = string | number | null;
export type CandidateStatus =
  "new" | "selected" | "rejected" | "needs_review" | "failed";
export interface ContentCandidate {
  id: string;
  brandId: string;
  urlKey: string;
  contentHash: string;
  origin: string;
  sourceId: string | null;
  input: SourceInput;
  document: SourceDocument | null;
  primary: boolean;
  fetchState: "pending" | "fetched" | "failed";
  status: CandidateStatus;
  topicId: string | null;
  legacyJobIds: string[];
  legacyConflict: boolean;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}
export interface CandidateBatch {
  brandId: string;
  origin: string;
  sourceId?: string;
  primary?: boolean;
  inputs: SourceInput[];
}
export interface SourceCheckpointState {
  brandId: string;
  sourceId: string;
  origin: string;
  primary: boolean;
  configHash: string | null;
  checkpoint: unknown;
  checkedAt: number | null;
  nextCheckAt: number;
  lastFailure: string | null;
  failureCount: number;
  leaseToken: string | null;
  leaseOwner: string | null;
  leaseUntil: number | null;
  updatedAt: number;
}
export interface SourceCheckpoint extends SourceCheckpointState {
  leaseToken: string;
  leaseUntil: number;
}
export interface ContentTopic extends ExistingTopic {
  brandId: string;
  identityKey: string;
  title: string;
  status: "ready" | "needs_review" | "rejected" | "existing";
  reason: string;
  jobId: string | null;
  createdAt: number;
  updatedAt: number;
  sourceMetadata: TopicSourceMetadata[];
  proposedIdentityKey: string | null;
  conflictingTopicIds: string[];
  mergedIntoTopicId: string | null;
}
export interface GenerationQuotaOptions {
  limit?: number;
  timeZone?: string;
}
export interface GenerationQuota {
  brandId: string;
  limit: number;
  timeZone: string;
  dayKey: string;
  used: number;
  remaining: number;
  startsAt: number;
  resetsAt: number;
}
export interface GenerationAttempt {
  id: string;
  brandId: string;
  jobId: string | null;
  kind: "generation" | "preview";
  dayKey: string;
  timeZone: string;
  startedAt: number;
}

export interface SelectionModelCall {
  id: string;
  brandId: string;
  task: "selection" | "selection_review";
  candidateIds: string[];
  startedAt: number;
}

function text(value: string, name: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new TypeError(`${name} must be non-empty`);
  return value;
}
function encode(value: unknown): string {
  const result = JSON.stringify(value);
  if (result === undefined)
    throw new TypeError("Value must be JSON serializable");
  return result;
}
function nullable(value: unknown): string | null {
  return value == null ? null : String(value);
}
function integer(
  value: number,
  name: string,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new TypeError(`${name} must be an integer between ${min} and ${max}`);
  return value;
}

/** Shared durable operations. ContentJobStore owns connection lifetime. */
export abstract class ContentOperationsStore {
  private transactionDepth = 0;
  private savepointSequence = 0;
  constructor(
    protected readonly db: DatabaseSync,
    protected readonly now: () => number,
  ) {}
  abstract get(id: string): ContentJob | null;
  abstract enqueue(input: EnqueueContentJob): ContentJob;

  protected transaction<T>(action: () => T): T {
    const outer = this.transactionDepth === 0;
    const savepoint = `content_operation_${++this.savepointSequence}`;
    this.db.exec(outer ? "BEGIN IMMEDIATE" : `SAVEPOINT ${savepoint}`);
    this.transactionDepth++;
    try {
      const result = action();
      this.db.exec(outer ? "COMMIT" : `RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (error) {
      this.db.exec(outer ? "ROLLBACK" : `ROLLBACK TO SAVEPOINT ${savepoint}`);
      if (!outer) this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
      throw error;
    } finally {
      this.transactionDepth--;
    }
  }

  protected recordAudit(event: {
    brandId: string;
    eventType: string;
    reason: string;
    actor?: string;
    jobId?: string | null;
    before?: unknown;
    after?: unknown;
  }): void {
    this.db
      .prepare(
        `INSERT INTO audit_events (
      id, job_id, brand_id, event_type, actor, reason, before_json, after_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        event.jobId ?? null,
        text(event.brandId, "brandId"),
        text(event.eventType, "eventType"),
        text(event.actor ?? "operator", "actor"),
        text(event.reason, "reason"),
        event.before === undefined ? null : encode(event.before),
        event.after === undefined ? null : encode(event.after),
        this.now(),
      );
  }

  private quotaWindow(
    brandId: string,
    options: GenerationQuotaOptions,
  ): GenerationQuota {
    text(brandId, "brandId");
    const limit = integer(options.limit ?? 3, "Daily generation limit", 1, 3);
    const timeZone = options.timeZone ?? "Asia/Shanghai";
    const now = this.now();
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);
    const part = (type: string) =>
      parts.find((item) => item.type === type)!.value;
    const dayKey = `${part("year")}-${part("month")}-${part("day")}`;
    const nextDayKey = new Date(Date.parse(`${dayKey}T00:00:00Z`) + 86_400_000)
      .toISOString()
      .slice(0, 10);
    const startsAt = fromZonedTime(`${dayKey}T00:00:00`, timeZone).getTime();
    const resetsAt = fromZonedTime(
      `${nextDayKey}T00:00:00`,
      timeZone,
    ).getTime();
    // Count actual starts in this local calendar day, including reservations
    // recorded under an earlier timezone setting. Never refund failures/crashes.
    const used = Number(
      this.db
        .prepare(
          "SELECT COUNT(*) AS n FROM generation_attempts WHERE brand_id = ? AND started_at >= ? AND started_at < ?",
        )
        .get(brandId, startsAt, resetsAt)!.n,
    );
    return {
      brandId,
      limit,
      timeZone,
      dayKey,
      used,
      remaining: Math.max(0, limit - used),
      startsAt,
      resetsAt,
    };
  }

  getGenerationQuota(
    options: GenerationQuotaOptions & { brandId: string },
  ): GenerationQuota {
    return this.quotaWindow(options.brandId, options);
  }

  protected reserveWritingAttempt(
    options: GenerationQuotaOptions & {
      brandId: string;
      kind: "generation" | "preview";
      jobId?: string;
    },
  ): GenerationAttempt | null {
    const quota = this.quotaWindow(options.brandId, options);
    if (!quota.remaining) return null;
    const attempt: GenerationAttempt = {
      id: randomUUID(),
      brandId: options.brandId,
      jobId: options.jobId ?? null,
      kind: options.kind,
      dayKey: quota.dayKey,
      timeZone: quota.timeZone,
      startedAt: this.now(),
    };
    this.db
      .prepare(
        "INSERT INTO generation_attempts (id,brand_id,job_id,kind,day_key,time_zone,started_at) VALUES (?,?,?,?,?,?,?)",
      )
      .run(
        attempt.id,
        attempt.brandId,
        attempt.jobId,
        attempt.kind,
        attempt.dayKey,
        attempt.timeZone,
        attempt.startedAt,
      );
    return attempt;
  }

  reserveGenerationAttempt(
    options: GenerationQuotaOptions & { brandId: string; kind: "preview" },
  ): GenerationAttempt | null {
    if (options.kind !== "preview")
      throw new TypeError("Explicit writing reservations are for preview only");
    return this.transaction(() => this.reserveWritingAttempt(options));
  }

  recordSelectionModelCall(options: {
    brandId: string;
    task: "selection" | "selection_review";
    candidateIds: string[];
  }): string {
    text(options.brandId, "brandId");
    if (!["selection", "selection_review"].includes(options.task))
      throw new TypeError("Invalid selection model task");
    if (
      options.candidateIds.length > 20 ||
      new Set(options.candidateIds).size !== options.candidateIds.length
    )
      throw new TypeError("Selection handles at most 20 distinct candidates");
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO selection_model_calls (id,brand_id,task,candidate_ids_json,started_at) VALUES (?,?,?,?,?)",
      )
      .run(
        id,
        options.brandId,
        options.task,
        encode(options.candidateIds),
        this.now(),
      );
    return id;
  }

  listGenerationAttempts(options: {
    brandId: string;
    since?: number;
    until?: number;
  }): GenerationAttempt[] {
    return this.db
      .prepare(
        "SELECT * FROM generation_attempts WHERE brand_id=? AND started_at>=? AND started_at<? ORDER BY started_at,rowid",
      )
      .all(
        options.brandId,
        options.since ?? 0,
        options.until ?? Number.MAX_SAFE_INTEGER,
      )
      .map((row) => ({
        id: String(row.id),
        brandId: String(row.brand_id),
        jobId: nullable(row.job_id),
        kind: row.kind as GenerationAttempt["kind"],
        dayKey: String(row.day_key),
        timeZone: String(row.time_zone),
        startedAt: Number(row.started_at),
      }));
  }

  listSelectionModelCalls(options: {
    brandId: string;
    since?: number;
    until?: number;
  }): SelectionModelCall[] {
    return this.db
      .prepare(
        "SELECT * FROM selection_model_calls WHERE brand_id=? AND started_at>=? AND started_at<? ORDER BY started_at,rowid",
      )
      .all(
        options.brandId,
        options.since ?? 0,
        options.until ?? Number.MAX_SAFE_INTEGER,
      )
      .map((row) => ({
        id: String(row.id),
        brandId: String(row.brand_id),
        task: row.task as SelectionModelCall["task"],
        candidateIds: JSON.parse(String(row.candidate_ids_json)),
        startedAt: Number(row.started_at),
      }));
  }

  private candidateFromRow(row: Row): ContentCandidate {
    return {
      id: String(row.id),
      brandId: String(row.brand_id),
      urlKey: String(row.url_key),
      contentHash: String(row.content_hash),
      origin: String(row.origin),
      sourceId: nullable(row.source_id),
      input: JSON.parse(String(row.input_json)),
      document:
        row.document_json === null
          ? null
          : JSON.parse(String(row.document_json)),
      primary: Boolean(row.primary_source),
      fetchState: row.fetch_state as ContentCandidate["fetchState"],
      status: row.status as CandidateStatus,
      topicId: nullable(row.topic_id),
      legacyJobIds: JSON.parse(String(row.legacy_job_ids_json)),
      legacyConflict: Boolean(row.legacy_conflict),
      lastError: nullable(row.last_error),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  getCandidate(id: string): ContentCandidate | null {
    const row = this.db
      .prepare("SELECT * FROM content_candidates WHERE id = ?")
      .get(id);
    return row ? this.candidateFromRow(row) : null;
  }

  listCandidates(
    options: {
      brandId?: string;
      status?: CandidateStatus;
      fetchState?: ContentCandidate["fetchState"];
      limit?: number;
    } = {},
  ): ContentCandidate[] {
    const filters: string[] = [];
    const values: Bind[] = [];
    for (const [column, value] of [
      ["brand_id", options.brandId],
      ["status", options.status],
      ["fetch_state", options.fetchState],
    ] as const) {
      if (value !== undefined) {
        filters.push(`${column} = ?`);
        values.push(value);
      }
    }
    return this.db
      .prepare(
        `SELECT * FROM content_candidates ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""} ORDER BY created_at,id LIMIT ?`,
      )
      .all(...values, integer(options.limit ?? 20, "limit", 1, 10000))
      .map((row) => this.candidateFromRow(row));
  }

  private legacyMatches(
    brandId: string,
    source: SourceInput,
  ): { ids: string[]; exact: boolean } {
    const key = sourceUrlKey(source.url);
    const material = sourceMaterialKey(source);
    const rows = this.db
      .prepare(
        `SELECT j.id,j.input_json FROM postiz_content_jobs j
      LEFT JOIN content_topics t ON t.job_id = j.id WHERE j.brand_id = ? AND t.id IS NULL`,
      )
      .all(brandId);
    const ids: string[] = [];
    let exact = false;
    for (const row of rows) {
      const input = JSON.parse(String(row.input_json)) as { sources?: unknown };
      if (!Array.isArray(input?.sources)) continue;
      for (const value of input.sources) {
        const parsed = sourceInputSchema.safeParse(value);
        if (!parsed.success || sourceUrlKey(parsed.data.url) !== key) continue;
        ids.push(String(row.id));
        // A bare historical web URL carries no event/version evidence.
        if (
          key.startsWith("x-status:") ||
          ((parsed.data.text || parsed.data.title || parsed.data.publishedAt) &&
            material === sourceMaterialKey(parsed.data))
        )
          exact = true;
      }
    }
    return { ids: [...new Set(ids)], exact };
  }

  upsertCandidates(batch: CandidateBatch): ContentCandidate[] {
    text(batch.brandId, "brandId");
    text(batch.origin, "origin");
    if (batch.inputs.length > 500)
      throw new TypeError("Candidate batches contain at most 500 inputs");
    const inputs = batch.inputs.map((input) => ({
      ...sourceInputSchema.parse(input),
      url: normalizeSourceUrl(input.url),
    }));
    return this.transaction(() =>
      inputs.map((input) => {
        const urlKey = sourceUrlKey(input.url);
        const contentHash = sourceMaterialKey(input);
        const id = stableHash({ brandId: batch.brandId, urlKey, contentHash });
        const previous = this.getCandidate(id);
        const now = this.now();
        if (previous) {
          // A duplicate discovery does not revive a failed/rejected/review job.
          // It may add previously absent inline evidence for the same X status.
          const fill = !previous.document && input.text;
          this.db
            .prepare(
              `UPDATE content_candidates SET primary_source = MAX(primary_source, ?),
          input_json = ?, document_json = ?, fetch_state = ?, updated_at = ? WHERE id = ?`,
            )
            .run(
              batch.primary ? 1 : 0,
              encode(fill ? input : previous.input),
              encode(fill ? input : previous.document),
              fill && previous.fetchState !== "failed"
                ? "fetched"
                : previous.fetchState,
              now,
              id,
            );
        } else {
          const legacy = this.legacyMatches(batch.brandId, input);
          const status: CandidateStatus = legacy.ids.length
            ? legacy.exact
              ? "selected"
              : "needs_review"
            : "new";
          this.db
            .prepare(
              `INSERT INTO content_candidates (
          id,brand_id,url_key,content_hash,origin,source_id,input_json,document_json,primary_source,
          fetch_state,status,legacy_job_ids_json,legacy_conflict,last_error,created_at,updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            )
            .run(
              id,
              batch.brandId,
              urlKey,
              contentHash,
              batch.origin,
              batch.sourceId ?? null,
              encode(input),
              input.text ? encode(input) : null,
              batch.primary ? 1 : 0,
              input.text ? "fetched" : "pending",
              status,
              encode(legacy.ids),
              legacy.ids.length && !legacy.exact ? 1 : 0,
              legacy.ids.length
                ? legacy.exact
                  ? "An existing content job already owns this source event"
                  : "Legacy job shares this URL; confirm a distinct event before selecting"
                : null,
              now,
              now,
            );
        }
        this.db
          .prepare(
            "INSERT OR IGNORE INTO candidate_origins (candidate_id,source_id,origin,first_seen_at) VALUES (?,?,?,?)",
          )
          .run(id, batch.sourceId ?? "manual", batch.origin, now);
        return this.getCandidate(id)!;
      }),
    );
  }

  recordCandidateDocument(
    id: string,
    document: SourceDocument,
  ): ContentCandidate {
    const parsed = sourceDocumentSchema.parse(document);
    const changed = this.db
      .prepare(
        `UPDATE content_candidates SET document_json = ?, fetch_state = 'fetched', last_error = NULL, updated_at = ?
      WHERE id = ? AND fetch_state != 'failed'`,
      )
      .run(encode(parsed), this.now(), id);
    if (!changed.changes)
      throw new JobConflictError(
        "Candidate is missing or requires an explicit extraction retry",
      );
    return this.getCandidate(id)!;
  }

  failCandidateFetch(id: string, error: string): ContentCandidate {
    const changed = this.db
      .prepare(
        `UPDATE content_candidates SET fetch_state = 'failed', status = 'failed', last_error = ?, updated_at = ?
      WHERE id = ? AND topic_id IS NULL AND status = 'new'`,
      )
      .run(text(error, "error"), this.now(), id);
    if (!changed.changes)
      throw new JobConflictError(
        "Only a new unassigned candidate can record extraction failure",
      );
    return this.getCandidate(id)!;
  }

  retryCandidate(
    id: string,
    options: { brandId: string; reason: string; actor?: string },
  ): ContentCandidate {
    return this.transaction(() => {
      const before = this.getCandidate(id);
      if (
        !before ||
        before.brandId !== options.brandId ||
        before.topicId ||
        before.legacyConflict ||
        !["failed", "rejected", "needs_review"].includes(before.status)
      )
        throw new JobConflictError(
          "Only an unassigned candidate without an unresolved legacy job can be retried",
        );
      this.db
        .prepare(
          "UPDATE content_candidates SET status='new', fetch_state=?, last_error=NULL, updated_at=? WHERE id=?",
        )
        .run(before.document ? "fetched" : "pending", this.now(), id);
      const after = this.getCandidate(id)!;
      this.recordAudit({
        eventType: "candidate.retried",
        ...options,
        before,
        after,
      });
      return after;
    });
  }

  resolveCandidateLegacy(
    id: string,
    options: { brandId: string; reason: string; actor?: string },
  ): ContentCandidate {
    return this.transaction(() => {
      const before = this.getCandidate(id);
      if (
        !before ||
        before.brandId !== options.brandId ||
        !before.legacyConflict ||
        before.topicId ||
        before.status !== "needs_review"
      )
        throw new JobConflictError(
          "Only an unresolved legacy candidate can be confirmed as a distinct event",
        );
      for (const jobId of before.legacyJobIds) {
        const linked = this.get(jobId);
        if (
          !linked ||
          ["submitting", "unknown"].includes(linked.state) ||
          linked.postizId !== null ||
          linked.platformPostId !== null ||
          linked.platformUrl !== null
        ) {
          throw new JobConflictError(
            "Legacy work has an uncertain submission or provider receipt; reconcile it before confirming another event",
          );
        }
      }
      this.db
        .prepare(
          "UPDATE content_candidates SET status='new', legacy_conflict=0, last_error=NULL, updated_at=? WHERE id=?",
        )
        .run(this.now(), id);
      const after = this.getCandidate(id)!;
      this.recordAudit({
        eventType: "candidate.legacy_resolved",
        ...options,
        before,
        after,
      });
      return after;
    });
  }

  ensureSources(options: {
    brandId: string;
    sources: {
      id: string;
      origin: string;
      primary?: boolean;
      configHash?: string;
    }[];
  }): void {
    text(options.brandId, "brandId");
    this.transaction(() => {
      for (const source of options.sources) {
        text(source.id, "sourceId");
        text(source.origin, "origin");
        this.db
          .prepare(
            `INSERT INTO source_checkpoints (brand_id,source_id,origin,primary_source,config_hash,updated_at) VALUES (?,?,?,?,?,?)
          ON CONFLICT(brand_id,source_id) DO UPDATE SET
          checkpoint_json=CASE WHEN config_hash IS NOT excluded.config_hash THEN NULL ELSE checkpoint_json END,
          next_check_at=CASE WHEN config_hash IS NOT excluded.config_hash THEN 0 ELSE next_check_at END,
          failure_count=CASE WHEN config_hash IS NOT excluded.config_hash THEN 0 ELSE failure_count END,
          last_failure=CASE WHEN config_hash IS NOT excluded.config_hash THEN NULL ELSE last_failure END,
          lease_token=CASE WHEN config_hash IS NOT excluded.config_hash THEN NULL ELSE lease_token END,
          lease_owner=CASE WHEN config_hash IS NOT excluded.config_hash THEN NULL ELSE lease_owner END,
          lease_until=CASE WHEN config_hash IS NOT excluded.config_hash THEN NULL ELSE lease_until END,
          origin=excluded.origin,primary_source=excluded.primary_source,config_hash=excluded.config_hash,updated_at=excluded.updated_at`,
          )
          .run(
            options.brandId,
            source.id,
            source.origin,
            source.primary ? 1 : 0,
            source.configHash ?? null,
            this.now(),
          );
      }
    });
  }

  private sourceFromRow(row: Row): SourceCheckpointState {
    return {
      brandId: String(row.brand_id),
      sourceId: String(row.source_id),
      origin: String(row.origin),
      primary: Boolean(row.primary_source),
      configHash: nullable(row.config_hash),
      checkpoint:
        row.checkpoint_json === null
          ? null
          : JSON.parse(String(row.checkpoint_json)),
      checkedAt: row.checked_at === null ? null : Number(row.checked_at),
      nextCheckAt: Number(row.next_check_at),
      lastFailure: nullable(row.last_failure),
      failureCount: Number(row.failure_count),
      leaseToken: nullable(row.lease_token),
      leaseOwner: nullable(row.lease_owner),
      leaseUntil: row.lease_until === null ? null : Number(row.lease_until),
      updatedAt: Number(row.updated_at),
    };
  }
  listSourceCheckpoints(options: { brandId: string }): SourceCheckpointState[] {
    return this.db
      .prepare(
        "SELECT * FROM source_checkpoints WHERE brand_id=? ORDER BY source_id",
      )
      .all(options.brandId)
      .map((row) => this.sourceFromRow(row));
  }
  claimDueSource(options: {
    brandId: string;
    sourceIds: string[];
    workerId: string;
    leaseMs: number;
    excludeSourceIds?: string[];
  }): SourceCheckpoint | null {
    text(options.workerId, "workerId");
    integer(options.leaseMs, "leaseMs", 1);
    const ids = [...new Set(options.sourceIds)].filter(
      (id) => !options.excludeSourceIds?.includes(id),
    );
    if (!ids.length) return null;
    if (ids.length > 500)
      throw new TypeError("At most 500 sources can be claimed at once");
    return this.transaction(() => {
      const now = this.now();
      const row = this.db
        .prepare(
          `SELECT * FROM source_checkpoints WHERE brand_id=? AND source_id IN (${ids.map(() => "?").join(",")})
        AND next_check_at<=? AND (lease_until IS NULL OR lease_until<=?) ORDER BY checked_at,source_id LIMIT 1`,
        )
        .get(options.brandId, ...ids, now, now);
      if (!row) return null;
      const token = randomUUID();
      this.db
        .prepare(
          "UPDATE source_checkpoints SET lease_token=?,lease_owner=?,lease_until=?,updated_at=? WHERE brand_id=? AND source_id=?",
        )
        .run(
          token,
          options.workerId,
          now + options.leaseMs,
          now,
          options.brandId,
          String(row.source_id),
        );
      return this.sourceFromRow(
        this.db
          .prepare(
            "SELECT * FROM source_checkpoints WHERE brand_id=? AND source_id=?",
          )
          .get(options.brandId, String(row.source_id))!,
      ) as SourceCheckpoint;
    });
  }
  private checkSourceLease(
    claim: Pick<SourceCheckpoint, "brandId" | "sourceId" | "leaseToken">,
  ): SourceCheckpointState {
    const row = this.db
      .prepare(
        "SELECT * FROM source_checkpoints WHERE brand_id=? AND source_id=? AND lease_token=? AND lease_until>?",
      )
      .get(claim.brandId, claim.sourceId, claim.leaseToken, this.now());
    if (!row) throw new LeaseLostError(`source:${claim.sourceId}`);
    return this.sourceFromRow(row);
  }
  completeSourceCheck(
    claim: Pick<SourceCheckpoint, "brandId" | "sourceId" | "leaseToken">,
    result: {
      checkedAt: number;
      nextCheckAt: number;
      checkpoint: unknown;
      inputs: SourceInput[];
      origin: string;
      primary?: boolean;
    },
  ): { inserted: number; duplicates: number } {
    integer(result.checkedAt, "checkedAt");
    integer(result.nextCheckAt, "nextCheckAt");
    return this.transaction(() => {
      const source = this.checkSourceLease(claim);
      const before = Number(
        this.db
          .prepare(
            "SELECT COUNT(*) AS n FROM content_candidates WHERE brand_id=?",
          )
          .get(claim.brandId)!.n,
      );
      this.upsertCandidates({
        brandId: claim.brandId,
        sourceId: claim.sourceId,
        origin: result.origin,
        primary: source.primary,
        inputs: result.inputs,
      });
      const inserted =
        Number(
          this.db
            .prepare(
              "SELECT COUNT(*) AS n FROM content_candidates WHERE brand_id=?",
            )
            .get(claim.brandId)!.n,
        ) - before;
      this.db
        .prepare(
          `UPDATE source_checkpoints SET checkpoint_json=?,checked_at=?,next_check_at=?,last_failure=NULL,failure_count=0,
        lease_token=NULL,lease_owner=NULL,lease_until=NULL,updated_at=? WHERE brand_id=? AND source_id=?`,
        )
        .run(
          encode(result.checkpoint),
          result.checkedAt,
          result.nextCheckAt,
          this.now(),
          claim.brandId,
          claim.sourceId,
        );
      return { inserted, duplicates: result.inputs.length - inserted };
    });
  }
  failSourceCheck(
    claim: Pick<SourceCheckpoint, "brandId" | "sourceId" | "leaseToken">,
    result: { checkedAt: number; nextCheckAt: number; lastFailure: string },
  ): void {
    integer(result.checkedAt, "checkedAt");
    integer(result.nextCheckAt, "nextCheckAt");
    this.transaction(() => {
      this.checkSourceLease(claim);
      this.db
        .prepare(
          `UPDATE source_checkpoints SET checked_at=?,next_check_at=?,last_failure=?,failure_count=failure_count+1,
        lease_token=NULL,lease_owner=NULL,lease_until=NULL,updated_at=? WHERE brand_id=? AND source_id=?`,
        )
        .run(
          result.checkedAt,
          result.nextCheckAt,
          text(result.lastFailure, "lastFailure"),
          this.now(),
          claim.brandId,
          claim.sourceId,
        );
    });
  }

  private topicFromRow(row: Row): ContentTopic {
    const metadata: TopicSourceMetadata[] = JSON.parse(
      String(row.source_metadata_json),
    );
    return {
      id: String(row.id),
      brandId: String(row.brand_id),
      identityKey: String(row.identity_key),
      identity: JSON.parse(String(row.identity_json)) as TopicIdentity,
      title: String(row.title),
      status: row.status as ContentTopic["status"],
      reason: String(row.reason),
      jobId: nullable(row.job_id),
      hasContent: row.job_id !== null || row.merged_into_topic_id !== null,
      proposedIdentityKey: nullable(row.proposed_identity_key),
      conflictingTopicIds: JSON.parse(String(row.conflicting_topic_ids_json)),
      mergedIntoTopicId: nullable(row.merged_into_topic_id),
      sourceCandidateIds: JSON.parse(String(row.source_candidate_ids_json)),
      sourceUrls: metadata.map((item) => item.url),
      sourceMetadata: metadata,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }
  getTopic(id: string): ContentTopic | null {
    const row = this.db
      .prepare("SELECT * FROM content_topics WHERE id=?")
      .get(id);
    return row ? this.topicFromRow(row) : null;
  }
  /** Full history: restricting this to the current 20-item batch would lose event deduplication. */
  listTopics(options: {
    brandId: string;
    status?: ContentTopic["status"];
    includeMerged?: boolean;
  }): ContentTopic[] {
    const sql =
      "SELECT * FROM content_topics WHERE brand_id=?" +
      (options.includeMerged ? "" : " AND merged_into_topic_id IS NULL") +
      (options.status ? " AND status=?" : "") +
      " ORDER BY created_at,id";
    return this.db
      .prepare(sql)
      .all(options.brandId, ...(options.status ? [options.status] : []))
      .map((row) => this.topicFromRow(row));
  }
  saveSelection(options: {
    brandId: string;
    result: SelectionResult;
    actor?: string;
  }): ContentTopic[] {
    return this.transaction(() => {
      const { brandId, result } = options;
      text(brandId, "brandId");
      if (result.candidateDecisions.length > 20)
        throw new TypeError("Selection handles at most 20 candidates");
      const seen = new Set<string>();
      for (const decision of result.candidateDecisions) {
        if (seen.has(decision.candidateId))
          throw new JobConflictError(
            "A selection contains duplicate candidate decisions",
          );
        seen.add(decision.candidateId);
        const candidate = this.getCandidate(decision.candidateId);
        if (
          !candidate ||
          candidate.brandId !== brandId ||
          candidate.legacyConflict ||
          candidate.status !== "new"
        )
          throw new JobConflictError(
            "Selection candidate is stale, belongs to another brand, or requires review",
          );
      }
      const topicIds = new Map<string, string>();
      const assignedCandidates = new Map<string, string>();
      for (const selected of result.topics) {
        if (
          !selected.sourceCandidateIds.length ||
          selected.sourceCandidateIds.length > 8 ||
          new Set(selected.sourceCandidateIds).size !==
            selected.sourceCandidateIds.length
        )
          throw new TypeError("A topic needs one to eight evidence sources");
        const collision = this.db
          .prepare(
            "SELECT * FROM content_topics WHERE brand_id=? AND identity_key=? AND merged_into_topic_id IS NULL",
          )
          .get(brandId, selected.identityKey);
        const byKey =
          selected.status === "needs_review" ? undefined : collision;
        const existing =
          this.getTopic(selected.existingTopicId ?? selected.id) ??
          (byKey ? this.topicFromRow(byKey) : null);
        if (existing && existing.brandId !== brandId)
          throw new JobConflictError("Cannot update another brand's topic");
        if (existing?.mergedIntoTopicId)
          throw new JobConflictError(
            "A merged review alias cannot receive a new selection",
          );
        if (
          selected.status === "needs_review" &&
          existing &&
          existing.status !== "needs_review"
        )
          throw new JobConflictError(
            "A pending review must not reuse an existing decided topic ID",
          );
        const id = existing?.id ?? selected.id;
        const conflicts = [
          ...new Set([
            ...(existing?.conflictingTopicIds ?? []),
            ...(selected.conflictingTopicIds ?? []),
            ...(selected.status === "needs_review" &&
            collision &&
            collision.id !== id
              ? [String(collision.id)]
              : []),
          ]),
        ];
        for (const conflictId of conflicts) {
          const conflict = this.getTopic(conflictId);
          if (
            !conflict ||
            conflict.brandId !== brandId ||
            conflict.mergedIntoTopicId
          )
            throw new JobConflictError(
              "A review conflict must reference this brand's canonical topic",
            );
        }
        const storageKey =
          selected.status === "needs_review"
            ? selected.id
            : selected.identityKey;
        const proposedKey =
          selected.status === "needs_review"
            ? topicIdentityKey(brandId, selected.identity)
            : (existing?.proposedIdentityKey ?? null);
        for (const candidateId of selected.candidateIds) {
          if (!seen.has(candidateId))
            throw new JobConflictError(
              "Topic contains a candidate not assessed by this selection",
            );
          if (assignedCandidates.has(candidateId))
            throw new JobConflictError(
              "A candidate cannot be assigned to two topics",
            );
          const link = this.db
            .prepare(
              "SELECT topic_id FROM topic_candidate_links WHERE candidate_id=?",
            )
            .get(candidateId);
          if (link && link.topic_id !== id)
            throw new JobConflictError(
              "Candidate already belongs to another event",
            );
          assignedCandidates.set(candidateId, id);
        }
        if (
          selected.sourceMetadata.length !==
            selected.sourceCandidateIds.length ||
          selected.sourceMetadata.some(
            (item) => !selected.sourceCandidateIds.includes(item.candidateId),
          ) ||
          new Set(selected.sourceMetadata.map((item) => item.candidateId))
            .size !== selected.sourceCandidateIds.length
        ) {
          throw new JobConflictError(
            "Topic evidence metadata must match its selected source candidates",
          );
        }
        for (const candidateId of selected.sourceCandidateIds) {
          const candidate = this.getCandidate(candidateId);
          if (
            !candidate ||
            candidate.brandId !== brandId ||
            candidate.legacyConflict
          )
            throw new JobConflictError(
              "Topic evidence must belong to this brand and have no legacy conflict",
            );
          const link = this.db
            .prepare(
              "SELECT topic_id FROM topic_candidate_links WHERE candidate_id=?",
            )
            .get(candidateId);
          if (link && link.topic_id !== id)
            throw new JobConflictError(
              "Candidate already belongs to another event",
            );
        }
        const now = this.now();
        if (!existing) {
          this.db
            .prepare(
              `INSERT INTO content_topics (id,brand_id,identity_key,identity_json,title,status,reason,source_candidate_ids_json,source_metadata_json,proposed_identity_key,conflicting_topic_ids_json,created_at,updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            )
            .run(
              id,
              brandId,
              storageKey,
              encode(selected.identity),
              selected.title,
              selected.status,
              selected.reason,
              encode(selected.sourceCandidateIds),
              encode(selected.sourceMetadata),
              proposedKey,
              encode(conflicts),
              now,
              now,
            );
        } else {
          // Preserve job binding and the authoritative identity of an existing event.
          this.db
            .prepare(
              `UPDATE content_topics SET title=?,status=?,reason=?,source_candidate_ids_json=?,source_metadata_json=?,conflicting_topic_ids_json=?,updated_at=? WHERE id=?`,
            )
            .run(
              selected.title,
              existing.hasContent
                ? "existing"
                : ["rejected", "needs_review"].includes(existing.status)
                  ? existing.status
                  : selected.status,
              selected.reason,
              encode(selected.sourceCandidateIds),
              encode(selected.sourceMetadata),
              encode(conflicts),
              now,
              id,
            );
        }
        for (const candidateId of selected.candidateIds) {
          if (!seen.has(candidateId))
            throw new JobConflictError(
              "Topic contains a candidate not assessed by this selection",
            );
          this.db
            .prepare(
              "INSERT OR IGNORE INTO topic_candidate_links (topic_id,candidate_id) VALUES (?,?)",
            )
            .run(id, candidateId);
          this.db
            .prepare(
              "UPDATE content_candidates SET topic_id=?,updated_at=? WHERE id=?",
            )
            .run(id, now, candidateId);
        }
        topicIds.set(selected.id, id);
      }
      for (const decision of result.candidateDecisions) {
        if (decision.topicId && !topicIds.has(decision.topicId))
          throw new JobConflictError(
            "Candidate decision references an absent topic",
          );
        if (
          (decision.topicId ? topicIds.get(decision.topicId) : undefined) !==
          assignedCandidates.get(decision.candidateId)
        ) {
          throw new JobConflictError(
            "Candidate decision and topic assignment disagree",
          );
        }
        this.db
          .prepare(
            "UPDATE content_candidates SET status=?,last_error=?,updated_at=? WHERE id=?",
          )
          .run(
            decision.status,
            decision.reason,
            this.now(),
            decision.candidateId,
          );
      }
      this.recordAudit({
        brandId,
        eventType: "selection.completed",
        actor: options.actor ?? "selector",
        reason: "Persist candidate decisions and event groups",
        after: result,
      });
      return [...new Set(topicIds.values())].map((id) => this.getTopic(id)!);
    });
  }
  reviewTopic(
    id: string,
    options: {
      brandId: string;
      decision: "approve" | "reject";
      reason: string;
      actor?: string;
      mergeWith?: string;
    },
  ): ContentTopic {
    if (!["approve", "reject"].includes(options.decision))
      throw new TypeError("Invalid topic review decision");
    return this.transaction(() => {
      const before = this.getTopic(id);
      if (
        !before ||
        before.brandId !== options.brandId ||
        before.hasContent ||
        before.status !== "needs_review"
      )
        throw new JobConflictError(
          "Only an unbound topic awaiting review can be reviewed",
        );
      const members = before.sourceCandidateIds.map((candidateId) => {
        const candidate = this.getCandidate(candidateId)!;
        return {
          id: candidateId,
          url: candidate.document?.url ?? candidate.input.url,
        };
      });
      const dynamicConflicts = this.listTopics({ brandId: before.brandId })
        .filter((topic) => topic.id !== id && topic.status !== "needs_review")
        .filter(
          (topic) =>
            topicIdentityKey(before.brandId, topic.identity) ===
              before.proposedIdentityKey ||
            conflictingHistory(before.identity, members, topic),
        )
        .map((topic) => topic.id);
      const reviewed = {
        ...before,
        conflictingTopicIds: [
          ...new Set([...before.conflictingTopicIds, ...dynamicConflicts]),
        ],
      };
      if (options.mergeWith) return this.mergeReviewedTopic(reviewed, options);
      if (options.decision === "approve" && reviewed.conflictingTopicIds.length)
        throw new JobConflictError(
          `This event already exists or conflicts with recorded content; explicitly merge with a recorded topic: ${reviewed.conflictingTopicIds.join(", ")}`,
        );
      this.db
        .prepare(
          "UPDATE content_topics SET status=?,reason=?,conflicting_topic_ids_json=?,identity_key=CASE WHEN ?='approve' THEN COALESCE(proposed_identity_key,identity_key) ELSE identity_key END,updated_at=? WHERE id=?",
        )
        .run(
          options.decision === "approve" ? "ready" : "rejected",
          text(options.reason, "reason"),
          encode(reviewed.conflictingTopicIds),
          options.decision,
          this.now(),
          id,
        );
      const after = this.getTopic(id)!;
      this.recordAudit({
        eventType: "topic.reviewed",
        ...options,
        before,
        after,
      });
      return after;
    });
  }

  private mergeReviewedTopic(
    before: ContentTopic,
    options: {
      brandId: string;
      decision: "approve" | "reject";
      reason: string;
      actor?: string;
      mergeWith?: string;
    },
  ): ContentTopic {
    if (options.decision !== "approve")
      throw new JobConflictError("Merging is an explicit approval action");
    const target = this.getTopic(options.mergeWith!);
    if (
      !target ||
      target.brandId !== before.brandId ||
      target.id === before.id ||
      target.mergedIntoTopicId ||
      !target.jobId ||
      (!before.conflictingTopicIds.includes(target.id) &&
        before.proposedIdentityKey !==
          topicIdentityKey(before.brandId, target.identity))
    ) {
      throw new JobConflictError(
        "Merge target must be a recorded conflicting event with an existing content job",
      );
    }
    const job = this.get(target.jobId);
    if (!job || ["unknown", "submitting"].includes(job.state))
      throw new JobConflictError(
        "Reconcile the existing submission before merging evidence into its topic",
      );
    const metadata = [
      ...new Map(
        [...target.sourceMetadata, ...before.sourceMetadata].map((item) => [
          item.candidateId,
          item,
        ]),
      ).values(),
    ]
      .sort((left, right) => Number(right.primary) - Number(left.primary))
      .slice(0, 8);
    const now = this.now();
    this.db
      .prepare("UPDATE topic_candidate_links SET topic_id=? WHERE topic_id=?")
      .run(target.id, before.id);
    this.db
      .prepare(
        "UPDATE content_candidates SET topic_id=?,status='selected',updated_at=? WHERE topic_id=?",
      )
      .run(target.id, now, before.id);
    this.db
      .prepare(
        "UPDATE content_topics SET source_candidate_ids_json=?,source_metadata_json=?,updated_at=? WHERE id=?",
      )
      .run(
        encode(metadata.map((item) => item.candidateId)),
        encode(metadata),
        now,
        target.id,
      );
    this.db
      .prepare(
        "UPDATE content_topics SET status='existing',merged_into_topic_id=?,reason=?,conflicting_topic_ids_json=?,updated_at=? WHERE id=?",
      )
      .run(
        target.id,
        text(options.reason, "reason"),
        encode(before.conflictingTopicIds),
        now,
        before.id,
      );
    const after = this.getTopic(target.id)!;
    // No job columns are touched. The alias is retained for audit/history but
    // excluded from canonical history so it cannot create an ambiguous match.
    this.recordAudit({
      brandId: before.brandId,
      jobId: job.id,
      eventType: "topic.merged",
      actor: options.actor,
      reason: options.reason,
      before: { proposal: before, target },
      after: { proposal: this.getTopic(before.id), target: after },
    });
    return after;
  }

  enqueueForTopic(topicId: string, input: EnqueueContentJob): ContentJob {
    return this.transaction(() => {
      const topic = this.getTopic(topicId);
      if (!topic || topic.brandId !== input.brandId)
        throw new JobConflictError("Content job must use its topic's brand");
      if (topic.mergedIntoTopicId)
        return this.enqueueForTopic(topic.mergedIntoTopicId, input);
      if (topic.jobId) {
        const existing = this.get(topic.jobId);
        if (!existing)
          throw new JobConflictError("Topic refers to a missing content job");
        return existing;
      }
      if (topic.status !== "ready" || topic.conflictingTopicIds.length)
        throw new JobConflictError(
          "Only a ready, reviewed topic can become a content job",
        );
      const validated = validateJobInput(input.input);
      if (validated.brand.id !== input.brandId)
        throw new JobConflictError(
          "Job snapshot does not match its topic brand",
        );
      const allowedUrls = new Set(
        topic.sourceCandidateIds.flatMap((id) => {
          const candidate = this.getCandidate(id)!;
          return [
            sourceUrlKey(candidate.input.url),
            ...(candidate.document
              ? [sourceUrlKey(candidate.document.url)]
              : []),
          ];
        }),
      );
      if (
        validated.sources.some(
          (source) => !allowedUrls.has(sourceUrlKey(source.url)),
        )
      )
        throw new JobConflictError(
          "A topic job must use that topic's selected evidence",
        );
      const job = this.enqueue(input);
      this.db
        .prepare(
          "UPDATE content_topics SET job_id=?,status='existing',updated_at=? WHERE id=? AND job_id IS NULL",
        )
        .run(job.id, this.now(), topicId);
      this.recordAudit({
        brandId: topic.brandId,
        jobId: job.id,
        eventType: "topic.job_bound",
        actor: "pipeline",
        reason: "One durable writing job per event",
        before: topic,
        after: this.getTopic(topicId),
      });
      return job;
    });
  }
}
