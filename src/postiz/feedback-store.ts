import { randomUUID } from "node:crypto";
import { ContentOperationsStore } from "./operations-store.js";
import { JobConflictError } from "./store-errors.js";
import { stableHash } from "./identity.js";
import { sourceUrlSchema } from "./validation.js";

type Row = Record<string, unknown>;
type Bind = string | number;
export interface ContentFeedback {
  id: string;
  brandId: string;
  jobId: string;
  kind: "edit" | "reject" | "note";
  reason: string;
  actor: string;
  createdAt: number;
}
export interface PostizObservationInput {
  brandId: string;
  jobId: string;
  postizId: string;
  postizState: string | null;
  content: string;
  scheduledAt: string | null;
  platformPostId: string | null;
  platformUrl: string | null;
}
export interface PostizObservation extends PostizObservationInput {
  id: string;
  /** Database insertion order breaks ties when snapshots share a millisecond. */
  sequence: number;
  observedAt: number;
}
export interface WritingModelCall {
  id: string;
  brandId: string;
  jobId: string | null;
  task: "relevance" | "report" | "post" | "quality";
  startedAt: number;
}
export interface HistoryFilter {
  brandId: string;
  jobId?: string;
  since?: number;
  until?: number;
}

function text(value: string, name: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new TypeError(`${name} must be non-empty`);
  return value;
}
function nullable(value: unknown): string | null {
  return value == null ? null : String(value);
}

/** Append-only feedback, observed remote snapshots, and model-call accounting. */
export abstract class ContentFeedbackStore extends ContentOperationsStore {
  private historyRows(
    table: "content_feedback" | "postiz_observations" | "writing_model_calls",
    timeColumn: "created_at" | "observed_at" | "started_at",
    options: HistoryFilter,
  ): Row[] {
    text(options.brandId, "brandId");
    const filters = ["brand_id=?", `${timeColumn}>=?`, `${timeColumn}<?`];
    const values: Bind[] = [
      options.brandId,
      options.since ?? 0,
      options.until ?? Number.MAX_SAFE_INTEGER,
    ];
    if (options.jobId !== undefined) {
      filters.push("job_id=?");
      values.push(options.jobId);
    }
    return this.db
      .prepare(
        `SELECT rowid AS sequence,* FROM ${table} WHERE ${filters.join(" AND ")} ORDER BY ${timeColumn},rowid`,
      )
      .all(...values);
  }
  private feedbackFromRow(row: Row): ContentFeedback {
    return {
      id: String(row.id),
      brandId: String(row.brand_id),
      jobId: String(row.job_id),
      kind: row.kind as ContentFeedback["kind"],
      reason: String(row.reason),
      actor: String(row.actor),
      createdAt: Number(row.created_at),
    };
  }
  listFeedback(options: HistoryFilter): ContentFeedback[] {
    return this.historyRows("content_feedback", "created_at", options).map(
      (row) => this.feedbackFromRow(row),
    );
  }
  recordFeedback(input: {
    brandId: string;
    jobId: string;
    kind: ContentFeedback["kind"];
    reason: string;
    actor?: string;
  }): ContentFeedback {
    if (!["edit", "reject", "note"].includes(input.kind))
      throw new TypeError("Invalid feedback kind");
    text(input.reason, "reason");
    text(input.actor ?? "operator", "actor");
    return this.transaction(() => {
      const job = this.get(input.jobId);
      if (!job || job.brandId !== input.brandId)
        throw new JobConflictError(
          "Feedback must reference an existing job for this brand",
        );
      const feedback: ContentFeedback = {
        id: randomUUID(),
        brandId: input.brandId,
        jobId: input.jobId,
        kind: input.kind,
        reason: input.reason,
        actor: input.actor ?? "operator",
        createdAt: this.now(),
      };
      this.db
        .prepare(
          "INSERT INTO content_feedback (id,brand_id,job_id,kind,reason,actor,created_at) VALUES (?,?,?,?,?,?,?)",
        )
        .run(
          feedback.id,
          feedback.brandId,
          feedback.jobId,
          feedback.kind,
          feedback.reason,
          feedback.actor,
          feedback.createdAt,
        );
      this.recordAudit({
        brandId: feedback.brandId,
        jobId: feedback.jobId,
        eventType: "feedback.recorded",
        reason: feedback.reason,
        actor: feedback.actor,
        before: job,
        after: feedback,
      });
      return feedback;
    });
  }
  private observationFromRow(row: Row): PostizObservation {
    return {
      id: String(row.id),
      sequence: Number(row.sequence),
      brandId: String(row.brand_id),
      jobId: String(row.job_id),
      postizId: String(row.postiz_id),
      postizState: nullable(row.postiz_state),
      content: String(row.content),
      scheduledAt: nullable(row.scheduled_at),
      platformPostId: nullable(row.platform_post_id),
      platformUrl: nullable(row.platform_url),
      observedAt: Number(row.observed_at),
    };
  }
  listObservations(options: HistoryFilter): PostizObservation[] {
    return this.historyRows("postiz_observations", "observed_at", options).map(
      (row) => this.observationFromRow(row),
    );
  }
  /**
   * Append only a changed, matching remote snapshot. A repeated read returns the
   * prior observation; A -> B -> A still records all three transitions. These
   * observations never replace the original generated output or provider IDs.
   */
  observePostiz(input: PostizObservationInput): PostizObservation {
    text(input.brandId, "brandId");
    text(input.jobId, "jobId");
    text(input.postizId, "postizId");
    if (typeof input.content !== "string" || input.content.length > 100_000)
      throw new TypeError(
        "Observed content must be a string of at most 100000 characters",
      );
    if (input.postizState !== null) text(input.postizState, "postizState");
    if (input.platformPostId !== null)
      text(input.platformPostId, "platformPostId");
    if (
      input.scheduledAt !== null &&
      (!Number.isFinite(Date.parse(input.scheduledAt)) ||
        !/[Tt].*(?:[Zz]|[+-]\d{2}:\d{2})$/.test(input.scheduledAt))
    )
      throw new TypeError("Observed schedule must include a valid timezone");
    const snapshot: PostizObservationInput = {
      brandId: input.brandId,
      jobId: input.jobId,
      postizId: input.postizId,
      postizState: input.postizState,
      content: input.content,
      scheduledAt:
        input.scheduledAt === null
          ? null
          : new Date(input.scheduledAt).toISOString(),
      platformPostId: input.platformPostId,
      platformUrl:
        input.platformUrl === null
          ? null
          : sourceUrlSchema.parse(input.platformUrl),
    };
    return this.transaction(() => {
      const job = this.get(input.jobId);
      if (
        !job ||
        job.brandId !== input.brandId ||
        job.state !== "submitted" ||
        job.postizId !== input.postizId
      )
        throw new JobConflictError(
          "Observed Postiz state must match this brand's recorded submitted receipt",
        );
      if (
        job.platformPostId &&
        snapshot.platformPostId &&
        job.platformPostId !== snapshot.platformPostId
      )
        throw new JobConflictError(
          "Observed platform identity conflicts with the recorded receipt",
        );
      const hash = stableHash(snapshot);
      const latest = this.db
        .prepare(
          "SELECT rowid AS sequence,* FROM postiz_observations WHERE job_id=? ORDER BY rowid DESC LIMIT 1",
        )
        .get(input.jobId);
      if (latest?.snapshot_hash === hash)
        return this.observationFromRow(latest);
      const observation: PostizObservation = {
        id: randomUUID(),
        sequence: 0,
        ...snapshot,
        observedAt: this.now(),
      };
      const inserted = this.db
        .prepare(
          `INSERT INTO postiz_observations (
        id,brand_id,job_id,postiz_id,postiz_state,content,scheduled_at,platform_post_id,platform_url,snapshot_hash,observed_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          observation.id,
          observation.brandId,
          observation.jobId,
          observation.postizId,
          observation.postizState,
          observation.content,
          observation.scheduledAt,
          observation.platformPostId,
          observation.platformUrl,
          hash,
          observation.observedAt,
        );
      observation.sequence = Number(inserted.lastInsertRowid);
      this.recordAudit({
        brandId: observation.brandId,
        jobId: observation.jobId,
        eventType: "postiz.observed",
        actor: "postiz-sync",
        reason: "Observed remote content or delivery state changed",
        before: latest ? this.observationFromRow(latest) : null,
        after: observation,
      });
      return observation;
    });
  }
  recordWritingModelCall(input: {
    brandId: string;
    jobId?: string;
    task: WritingModelCall["task"];
  }): string {
    text(input.brandId, "brandId");
    if (!["relevance", "report", "post", "quality"].includes(input.task))
      throw new TypeError("Invalid writing model task");
    if (input.jobId !== undefined) {
      const job = this.get(input.jobId);
      if (!job || job.brandId !== input.brandId)
        throw new JobConflictError(
          "Writing call must reference this brand's job",
        );
    }
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO writing_model_calls (id,brand_id,job_id,task,started_at) VALUES (?,?,?,?,?)",
      )
      .run(id, input.brandId, input.jobId ?? null, input.task, this.now());
    return id;
  }
  listWritingModelCalls(options: HistoryFilter): WritingModelCall[] {
    return this.historyRows("writing_model_calls", "started_at", options).map(
      (row) => ({
        id: String(row.id),
        brandId: String(row.brand_id),
        jobId: nullable(row.job_id),
        task: row.task as WritingModelCall["task"],
        startedAt: Number(row.started_at),
      }),
    );
  }
}
