import type {
  ContentCandidate,
  GenerationAttempt,
} from "./operations-store.js";
import type { ContentJob } from "./store.js";

/** Feedback is evidence for an operator review; it never edits brand settings. */
export interface ReportFeedback {
  id: string;
  brandId: string;
  jobId: string;
  kind: "edit" | "reject" | "note";
  reason: string;
  actor: string;
  createdAt: number;
}

/** A separate Postiz snapshot. The original generated output remains immutable. */
export interface ReportObservation {
  id: string;
  brandId: string;
  jobId: string;
  postizId: string;
  postizState: string | null;
  content: string;
  scheduledAt: string | null;
  platformPostId: string | null;
  platformUrl: string | null;
  observedAt: number;
  /** Durable append order; legacy records without it must be supplied oldest first. */
  sequence?: number;
}

export interface ReportWritingCall {
  id: string;
  brandId: string;
  jobId: string | null;
  task: "relevance" | "report" | "post" | "quality";
  startedAt: number;
}

export interface ReportSelectionCall {
  id: string;
  brandId: string;
  task: "selection" | "selection_review";
  candidateIds: readonly string[];
  startedAt: number;
}

export type ReportJob = Pick<
  ContentJob,
  | "id"
  | "brandId"
  | "state"
  | "mode"
  | "scheduledAt"
  | "postizId"
  | "postizState"
  | "platformPostId"
  | "platformUrl"
  | "output"
  | "lastError"
  | "failurePhase"
  | "createdAt"
  | "updatedAt"
>;

export type ReportCandidate = Pick<
  ContentCandidate,
  | "id"
  | "brandId"
  | "status"
  | "fetchState"
  | "origin"
  | "primary"
  | "topicId"
  | "createdAt"
  | "lastError"
>;

export interface ReportDayWindow {
  dayKey: string;
  timeZone: string;
  startsAt: number;
  resetsAt: number;
}

export interface OperationsReportInput {
  brandId: string;
  /** Supplied by the caller so the aggregate itself is deterministic. */
  generatedAt: number;
  jobs: readonly ReportJob[];
  candidates: readonly ReportCandidate[];
  generationAttempts: readonly GenerationAttempt[];
  selectionCalls: readonly ReportSelectionCall[];
  writingCalls: readonly ReportWritingCall[];
  feedback: readonly ReportFeedback[];
  observations: readonly ReportObservation[];
  /** Use the same brand-local window returned by the generation quota store. */
  dayWindow?: ReportDayWindow;
  /** A bounded or filtered store read must not be presented as lifetime totals. */
  incompleteCollections?: readonly ReportCollection[];
}

export type ReportCollection =
  | "jobs"
  | "candidates"
  | "generationAttempts"
  | "selectionCalls"
  | "writingCalls"
  | "feedback"
  | "observations";

export type DeliveryStatus =
  | "not_submitted"
  | "submitting"
  | "accepted"
  | "draft"
  | "scheduled"
  | "published"
  | "failed"
  | "unknown";

export interface DeliveryClassification {
  status: DeliveryStatus;
  reason:
    | "not_submitted"
    | "awaiting_receipt"
    | "receipt_accepted"
    | "observed_provider_state"
    | "submission_outcome_unknown"
    | "missing_receipt"
    | "unrecognized_provider_state"
    | "inconsistent_receipt"
    | "unrecognized_local_state";
}

/**
 * A local queue or scheduled intent is not evidence of a Postiz schedule.
 * Only the current durable receipt supplies delivery state. Historical body
 * observations are shown separately and never rewrite this receipt or output.
 */
export function classifyDelivery(
  job: Pick<ReportJob, "state" | "postizId" | "postizState">,
): DeliveryClassification {
  if (job.state === "unknown") {
    return { status: "unknown", reason: "submission_outcome_unknown" };
  }
  if (job.state !== "submitted") {
    if (job.postizId || job.postizState?.trim()) {
      return { status: "unknown", reason: "inconsistent_receipt" };
    }
    if (job.state === "submitting") {
      return { status: "submitting", reason: "awaiting_receipt" };
    }
    if (
      ["queued", "processing", "ready", "rejected", "failed"].includes(
        job.state,
      )
    ) {
      return { status: "not_submitted", reason: "not_submitted" };
    }
    return { status: "unknown", reason: "unrecognized_local_state" };
  }
  if (!job.postizId?.trim()) {
    return { status: "unknown", reason: "missing_receipt" };
  }
  const providerState = job.postizState?.trim().toUpperCase();
  if (!providerState) {
    return { status: "accepted", reason: "receipt_accepted" };
  }
  const known: Record<string, DeliveryStatus> = {
    DRAFT: "draft",
    QUEUE: "scheduled",
    PUBLISHED: "published",
    ERROR: "failed",
  };
  const status = Object.prototype.hasOwnProperty.call(known, providerState)
    ? known[providerState]
    : undefined;
  return status
    ? { status, reason: "observed_provider_state" }
    : { status: "unknown", reason: "unrecognized_provider_state" };
}

export interface JobReport {
  id: string;
  localState: ReportJob["state"];
  mode: ReportJob["mode"];
  scheduledAt: string | null;
  delivery: DeliveryClassification;
  postizId: string | null;
  postizState: string | null;
  platformPostId: string | null;
  platformUrl: string | null;
  lastError: string | null;
  failurePhase: ReportJob["failurePhase"];
  /** Exact original object; the report never substitutes observed Postiz text. */
  output: unknown | null;
  originalPost: string | null;
  latestObservation: ReportObservation | null;
  latestObservedContent: string | null;
  /** Null means a comparison is unavailable, not that the text was unchanged. */
  edited: boolean | null;
  feedback: readonly ReportFeedback[];
  createdAt: number;
  updatedAt: number;
}

export interface FeedbackSignal {
  kind: ReportFeedback["kind"];
  reason: string;
  count: number;
  jobIds: string[];
  feedbackIds: string[];
  latestAt: number;
}

export interface OperationsReport {
  scope: {
    brandId: string;
    generatedAt: number;
    basis: "provided_snapshot";
    incompleteCollections: ReportCollection[];
  };
  today:
    | (ReportDayWindow & {
        todayCandidates: number;
        /** Includes both preview and queued-generation reservations. */
        todayGenerationStarts: number;
        generationStartsByKind: Record<string, number>;
        writingCallStarts: number;
        selectionCallStarts: number;
        newJobs: number;
        /** First DRAFT snapshot seen today, possibly an older draft synced today. */
        firstObservedDrafts: number;
      })
    | null;
  jobs: {
    total: number;
    localStates: Record<string, number>;
    deliveryStates: Record<DeliveryStatus, number>;
    generationFailures: number;
    submissionFailures: number;
    edited: number;
    editComparisonUnavailable: number;
    items: JobReport[];
  };
  candidates: {
    total: number;
    statuses: Record<string, number>;
    fetchStates: Record<string, number>;
    origins: Record<string, number>;
    primary: number;
    linkedToTopic: number;
    failureItems: Pick<
      ReportCandidate,
      "id" | "status" | "fetchState" | "origin" | "lastError"
    >[];
    /** Selection reasons are distinct from extraction/processing failures. */
    decisionItems: {
      id: string;
      status: "rejected" | "needs_review";
      origin: string;
      reason: string | null;
    }[];
  };
  /** Reservations count writing starts, including previews, not model requests. */
  generationAttempts: { total: number; kinds: Record<string, number> };
  /** These are recorded request starts, not successful responses or token costs. */
  modelCalls: {
    total: number;
    writing: { total: number; tasks: Record<string, number> };
    selection: {
      total: number;
      tasks: Record<string, number>;
      distinctCandidateCount: number;
    };
  };
  feedback: {
    total: number;
    kinds: Record<string, number>;
    /** Grouped operator reasons for review; no configuration changes are applied. */
    reviewSignals: FeedbackSignal[];
    items: ReportFeedback[];
  };
  observations: {
    total: number;
    jobsWithMatchingSnapshot: number;
    items: ReportObservation[];
  };
  unmatchedReferences: {
    feedbackWithoutJob: number;
    observationsWithoutJob: number;
    observationsWithDifferentReceipt: number;
    generationAttemptsWithoutJob: number;
    writingCallsWithoutJob: number;
  };
}

function timestamp(value: number, label: string): void {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 8_640_000_000_000_000
  ) {
    throw new TypeError(`${label} must be a valid nonnegative timestamp`);
  }
}

function branded<T extends { id: string; brandId: string }>(
  records: readonly T[],
  brandId: string,
  collection: ReportCollection,
): T[] {
  const seen = new Set<string>();
  return records.filter((record) => {
    if (record.brandId !== brandId) return false;
    if (!record.id?.trim() || seen.has(record.id)) {
      throw new Error(
        `Report ${collection} IDs must be non-empty and unique per brand`,
      );
    }
    seen.add(record.id);
    return true;
  });
}

function tally(values: readonly string[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return Object.fromEntries([...counts].sort(([a], [b]) => a.localeCompare(b)));
}

function originalPost(output: unknown): string | null {
  if (typeof output !== "object" || output === null || !("post" in output))
    return null;
  return typeof output.post === "string" ? output.post : null;
}

function feedbackSignals(
  feedback: readonly ReportFeedback[],
): FeedbackSignal[] {
  const groups = new Map<string, FeedbackSignal>();
  for (const item of feedback) {
    // Group repeated whitespace only. Do not invent an interpretation of feedback.
    const reason = item.reason.trim().replace(/\s+/g, " ");
    const key = JSON.stringify([item.kind, reason]);
    let signal = groups.get(key);
    if (!signal) {
      signal = {
        kind: item.kind,
        reason,
        count: 0,
        jobIds: [],
        feedbackIds: [],
        latestAt: item.createdAt,
      };
      groups.set(key, signal);
    }
    signal.count++;
    if (!signal.jobIds.includes(item.jobId)) signal.jobIds.push(item.jobId);
    signal.feedbackIds.push(item.id);
    signal.latestAt = Math.max(signal.latestAt, item.createdAt);
  }
  return [...groups.values()]
    .map((signal) => ({
      ...signal,
      jobIds: signal.jobIds.sort(),
      feedbackIds: signal.feedbackIds.sort(),
    }))
    .sort(
      (a, b) =>
        b.count - a.count ||
        b.latestAt - a.latestAt ||
        a.kind.localeCompare(b.kind) ||
        a.reason.localeCompare(b.reason),
    );
}

/** Read-only aggregation: no fetching, model calls, job mutation or publishing. */
export function buildOperationsReport(
  input: OperationsReportInput,
): OperationsReport {
  if (!input.brandId?.trim()) throw new Error("Report brandId is required");
  timestamp(input.generatedAt, "Report generatedAt");
  const brand = input.brandId;
  const day = input.dayWindow;
  if (day) {
    timestamp(day.startsAt, "Day startsAt");
    timestamp(day.resetsAt, "Day resetsAt");
    if (
      !day.dayKey?.trim() ||
      !day.timeZone?.trim() ||
      day.resetsAt <= day.startsAt
    ) {
      throw new TypeError(
        "Report day window requires a day, time zone and increasing bounds",
      );
    }
  }
  const jobs = branded(input.jobs, brand, "jobs");
  const candidates = branded(input.candidates, brand, "candidates");
  const attempts = branded(
    input.generationAttempts,
    brand,
    "generationAttempts",
  );
  const selection = branded(input.selectionCalls, brand, "selectionCalls");
  const writing = branded(input.writingCalls, brand, "writingCalls");
  const feedback = branded(input.feedback, brand, "feedback");
  const observations = branded(input.observations, brand, "observations");
  for (const candidate of candidates)
    timestamp(candidate.createdAt, "Candidate createdAt");
  for (const item of feedback) timestamp(item.createdAt, "Feedback createdAt");
  for (const item of observations) {
    timestamp(item.observedAt, "Observation observedAt");
    if (
      item.sequence !== undefined &&
      (!Number.isSafeInteger(item.sequence) || item.sequence < 1)
    ) {
      throw new TypeError(
        "Observation sequence must be a positive safe integer",
      );
    }
  }
  for (const item of [...attempts, ...selection, ...writing])
    timestamp(item.startedAt, "Call/attempt startedAt");
  for (const job of jobs) {
    timestamp(job.createdAt, "Job createdAt");
    timestamp(job.updatedAt, "Job updatedAt");
  }
  // Sort copies; callers may retain or freeze their original store snapshot.
  jobs.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
  feedback.sort(
    (a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id),
  );
  const observationOrder = new Map(
    observations.map((item, index) => [item.id, index]),
  );
  observations.sort(
    (a, b) =>
      b.observedAt - a.observedAt ||
      (a.sequence !== undefined && b.sequence !== undefined
        ? b.sequence - a.sequence
        : 0) ||
      // UUIDs do not express insertion order. Preserve the legacy append order
      // when sequence metadata is not available on both records.
      observationOrder.get(b.id)! - observationOrder.get(a.id)!,
  );
  const jobsById = new Map(jobs.map((job) => [job.id, job]));
  const latestByJob = new Map<string, ReportObservation>();
  const firstDraftByJob = new Map<string, number>();
  const feedbackByJob = new Map<string, ReportFeedback[]>();
  let observationsWithoutJob = 0;
  let observationsWithDifferentReceipt = 0;
  for (const observation of observations) {
    const job = jobsById.get(observation.jobId);
    if (!job) {
      observationsWithoutJob++;
    } else if (!job.postizId || observation.postizId !== job.postizId) {
      observationsWithDifferentReceipt++;
    } else {
      if (!latestByJob.has(job.id)) latestByJob.set(job.id, observation);
      if (observation.postizState?.trim().toUpperCase() === "DRAFT") {
        firstDraftByJob.set(
          job.id,
          Math.min(
            firstDraftByJob.get(job.id) ?? Infinity,
            observation.observedAt,
          ),
        );
      }
    }
  }
  for (const item of feedback) {
    const entries = feedbackByJob.get(item.jobId) ?? [];
    entries.push(item);
    feedbackByJob.set(item.jobId, entries);
  }
  const items: JobReport[] = jobs.map((job) => {
    const observation = latestByJob.get(job.id) ?? null;
    const post = originalPost(job.output);
    return {
      id: job.id,
      localState: job.state,
      mode: job.mode,
      scheduledAt: job.scheduledAt,
      delivery: classifyDelivery(job),
      postizId: job.postizId,
      postizState: job.postizState,
      platformPostId: job.platformPostId,
      platformUrl: job.platformUrl,
      lastError: job.lastError,
      failurePhase: job.failurePhase,
      output: job.output,
      originalPost: post,
      latestObservation: observation,
      latestObservedContent: observation?.content ?? null,
      edited:
        observation && post !== null ? observation.content !== post : null,
      feedback: feedbackByJob.get(job.id) ?? [],
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    };
  });
  const deliveryStates: Record<DeliveryStatus, number> = {
    not_submitted: 0,
    submitting: 0,
    accepted: 0,
    draft: 0,
    scheduled: 0,
    published: 0,
    failed: 0,
    unknown: 0,
  };
  for (const job of items) deliveryStates[job.delivery.status]++;
  const inDay = (value: number) =>
    day !== undefined && value >= day.startsAt && value < day.resetsAt;
  const todayAttempts = attempts.filter((attempt) => inDay(attempt.startedAt));
  return {
    scope: {
      brandId: brand,
      generatedAt: input.generatedAt,
      basis: "provided_snapshot",
      incompleteCollections: [
        ...new Set(input.incompleteCollections ?? []),
      ].sort(),
    },
    today: day
      ? {
          ...day,
          todayCandidates: candidates.filter((candidate) =>
            inDay(candidate.createdAt),
          ).length,
          todayGenerationStarts: todayAttempts.length,
          generationStartsByKind: tally(
            todayAttempts.map((attempt) => attempt.kind),
          ),
          writingCallStarts: writing.filter((call) => inDay(call.startedAt))
            .length,
          selectionCallStarts: selection.filter((call) => inDay(call.startedAt))
            .length,
          newJobs: jobs.filter((job) => inDay(job.createdAt)).length,
          firstObservedDrafts: [...firstDraftByJob.values()].filter(inDay)
            .length,
        }
      : null,
    jobs: {
      total: items.length,
      localStates: tally(jobs.map((job) => job.state)),
      deliveryStates,
      generationFailures: jobs.filter(
        (job) => job.state === "failed" && job.failurePhase === "generation",
      ).length,
      submissionFailures: jobs.filter(
        (job) => job.state === "failed" && job.failurePhase === "submission",
      ).length,
      edited: items.filter((job) => job.edited === true).length,
      editComparisonUnavailable: items.filter((job) => job.edited === null)
        .length,
      items,
    },
    candidates: {
      total: candidates.length,
      statuses: tally(candidates.map((candidate) => candidate.status)),
      fetchStates: tally(candidates.map((candidate) => candidate.fetchState)),
      origins: tally(candidates.map((candidate) => candidate.origin)),
      primary: candidates.filter((candidate) => candidate.primary).length,
      linkedToTopic: candidates.filter(
        (candidate) => candidate.topicId !== null,
      ).length,
      failureItems: candidates
        .filter(
          (candidate) =>
            candidate.status === "failed" || candidate.fetchState === "failed",
        )
        .map(({ id, status, fetchState, origin, lastError }) => ({
          id,
          status,
          fetchState,
          origin,
          lastError,
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      decisionItems: candidates
        .filter(
          (
            candidate,
          ): candidate is ReportCandidate & {
            status: "rejected" | "needs_review";
          } =>
            candidate.status === "rejected" ||
            candidate.status === "needs_review",
        )
        .map(({ id, status, origin, lastError }) => ({
          id,
          status,
          origin,
          reason: lastError,
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    },
    generationAttempts: {
      total: attempts.length,
      kinds: tally(attempts.map((attempt) => attempt.kind)),
    },
    modelCalls: {
      total: selection.length + writing.length,
      writing: {
        total: writing.length,
        tasks: tally(writing.map((call) => call.task)),
      },
      selection: {
        total: selection.length,
        tasks: tally(selection.map((call) => call.task)),
        distinctCandidateCount: new Set(
          selection.flatMap((call) => call.candidateIds),
        ).size,
      },
    },
    feedback: {
      total: feedback.length,
      kinds: tally(feedback.map((item) => item.kind)),
      reviewSignals: feedbackSignals(feedback),
      items: feedback,
    },
    observations: {
      total: observations.length,
      jobsWithMatchingSnapshot: latestByJob.size,
      items: observations,
    },
    unmatchedReferences: {
      feedbackWithoutJob: feedback.filter((item) => !jobsById.has(item.jobId))
        .length,
      observationsWithoutJob,
      observationsWithDifferentReceipt,
      generationAttemptsWithoutJob: attempts.filter(
        (attempt) => attempt.jobId !== null && !jobsById.has(attempt.jobId),
      ).length,
      writingCallsWithoutJob: writing.filter(
        (call) => call.jobId !== null && !jobsById.has(call.jobId),
      ).length,
    },
  };
}
