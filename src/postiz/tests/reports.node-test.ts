import assert from "node:assert/strict";
import test from "node:test";
import {
  buildOperationsReport,
  classifyDelivery,
  type OperationsReportInput,
  type ReportFeedback,
  type ReportJob,
  type ReportObservation,
  type ReportWritingCall,
} from "../reports.js";

const NOW = Date.parse("2026-09-24T12:00:00Z");

function job(id: string, overrides: Partial<ReportJob> = {}): ReportJob {
  return {
    id,
    brandId: "tokenhot",
    state: "queued",
    mode: "draft",
    scheduledAt: null,
    postizId: null,
    postizState: null,
    platformPostId: null,
    platformUrl: null,
    output: null,
    lastError: null,
    failurePhase: null,
    createdAt: NOW - 10_000,
    updatedAt: NOW - 1_000,
    ...overrides,
  };
}

function snapshot(
  overrides: Partial<OperationsReportInput> = {},
): OperationsReportInput {
  return {
    brandId: "tokenhot",
    generatedAt: NOW,
    jobs: [],
    candidates: [],
    generationAttempts: [],
    selectionCalls: [],
    writingCalls: [],
    feedback: [],
    observations: [],
    ...overrides,
  };
}

function observation(
  id: string,
  overrides: Partial<ReportObservation> = {},
): ReportObservation {
  return {
    id,
    brandId: "tokenhot",
    jobId: "job",
    postizId: "postiz-job",
    postizState: "DRAFT",
    content: "Original draft",
    scheduledAt: null,
    platformPostId: null,
    platformUrl: null,
    observedAt: NOW - 500,
    ...overrides,
  };
}

function feedback(
  id: string,
  overrides: Partial<ReportFeedback> = {},
): ReportFeedback {
  return {
    id,
    brandId: "tokenhot",
    jobId: "job",
    kind: "edit",
    reason: "Use a concrete API example",
    actor: "operator",
    createdAt: NOW - 500,
    ...overrides,
  };
}

void test("delivery distinguishes accepted receipts, drafts, scheduled posts and publication", () => {
  const mapping = [
    [null, "accepted"],
    ["DRAFT", "draft"],
    ["QUEUE", "scheduled"],
    ["PUBLISHED", "published"],
    ["ERROR", "failed"],
    ["SENT", "unknown"],
    ["__proto__", "unknown"],
    ["constructor", "unknown"],
  ] as const;
  for (const [postizState, status] of mapping) {
    assert.equal(
      classifyDelivery(
        job("job", {
          state: "submitted",
          postizId: "receipt",
          postizState,
        }),
      ).status,
      status,
    );
  }
  const report = buildOperationsReport(
    snapshot({
      jobs: [
        job("queue", { mode: "schedule", scheduledAt: "2026-09-25T12:00:00Z" }),
        job("draft", {
          state: "submitted",
          postizId: "draft-id",
          postizState: "DRAFT",
          mode: "schedule",
        }),
        job("accepted", {
          state: "submitted",
          postizId: "accepted-id",
          mode: "schedule",
        }),
        job("scheduled", {
          state: "submitted",
          postizId: "scheduled-id",
          postizState: "QUEUE",
        }),
        job("published", {
          state: "submitted",
          postizId: "published-id",
          postizState: "PUBLISHED",
        }),
        job("remote-error", {
          state: "submitted",
          postizId: "error-id",
          postizState: "ERROR",
        }),
        job("generation-error", {
          state: "failed",
          failurePhase: "generation",
          lastError: "Generation failed",
        }),
        job("submission-error", {
          state: "failed",
          failurePhase: "submission",
          lastError: "Rejected request",
        }),
        job("unknown", { state: "unknown", mode: "schedule" }),
      ],
    }),
  );
  assert.deepEqual(report.jobs.deliveryStates, {
    not_submitted: 3,
    submitting: 0,
    accepted: 1,
    draft: 1,
    scheduled: 1,
    published: 1,
    failed: 1,
    unknown: 1,
  });
  assert.equal(report.jobs.localStates.submitted, 5);
  assert.equal(report.jobs.localStates.failed, 2);
  assert.equal(report.jobs.generationFailures, 1);
  assert.equal(report.jobs.submissionFailures, 1);
});

void test("unknown outcomes and inconsistent receipts never imply successful delivery", () => {
  assert.deepEqual(
    classifyDelivery(
      job("unknown", {
        state: "unknown",
        postizId: "old",
        postizState: "PUBLISHED",
      }),
    ),
    { status: "unknown", reason: "submission_outcome_unknown" },
  );
  assert.deepEqual(
    classifyDelivery(
      job("no-receipt", {
        state: "submitted",
        postizState: "PUBLISHED",
      }),
    ),
    { status: "unknown", reason: "missing_receipt" },
  );
  assert.deepEqual(
    classifyDelivery(
      job("inconsistent", {
        state: "ready",
        postizId: "unexpected",
        postizState: "QUEUE",
      }),
    ),
    { status: "unknown", reason: "inconsistent_receipt" },
  );
  assert.deepEqual(
    classifyDelivery(
      job("in-flight", {
        state: "submitting",
      }),
    ),
    { status: "submitting", reason: "awaiting_receipt" },
  );
});

void test("latest matching observation compares text without replacing output or delivery state", () => {
  const output = Object.freeze({
    post: "Original draft",
    report: "A source-backed brief",
    quality: Object.freeze({ approved: true, reasons: Object.freeze([]) }),
  });
  const original = Object.freeze(
    job("job", {
      state: "submitted",
      postizId: "postiz-job",
      postizState: "DRAFT",
      output,
    }),
  );
  const old = Object.freeze(observation("old", { observedAt: NOW - 900 }));
  const latest = Object.freeze(
    observation("latest", {
      observedAt: NOW - 300,
      content: "Edited in Postiz",
      postizState: "PUBLISHED",
    }),
  );
  const differentReceipt = Object.freeze(
    observation("different", {
      postizId: "another-post",
      observedAt: NOW - 100,
      content: "Unrelated text",
    }),
  );
  const observations = Object.freeze([old, differentReceipt, latest]);
  const report = buildOperationsReport(
    snapshot({ jobs: Object.freeze([original]), observations }),
  );
  const item = report.jobs.items[0];
  assert.strictEqual(item.output, output);
  assert.equal(item.originalPost, "Original draft");
  assert.strictEqual(item.latestObservation, latest);
  assert.equal(item.latestObservedContent, "Edited in Postiz");
  assert.equal(item.edited, true);
  assert.equal(item.delivery.status, "draft");
  assert.equal(item.postizState, "DRAFT");
  assert.equal(report.jobs.edited, 1);
  assert.equal(report.observations.total, 3);
  assert.equal(report.observations.jobsWithMatchingSnapshot, 1);
  assert.equal(report.unmatchedReferences.observationsWithDifferentReceipt, 1);
  assert.equal(original.output.post, "Original draft");
  assert.deepEqual(
    observations.map((item) => item.id),
    ["old", "different", "latest"],
  );
});

void test("same-millisecond observations use durable insertion order before UUID ordering", () => {
  const originalOutput = Object.freeze({ post: "Original draft" });
  const original = job("job", {
    state: "submitted",
    postizId: "postiz-job",
    postizState: "DRAFT",
    output: originalOutput,
  });
  const a = observation("aaa-earlier", {
    sequence: 10,
    observedAt: NOW,
    content: "First edit",
  });
  const b = observation("zzz-later", {
    sequence: 11,
    observedAt: NOW,
    content: "Second edit",
  });
  const report = buildOperationsReport(
    snapshot({ jobs: [original], observations: [b, a] }),
  );
  assert.strictEqual(report.jobs.items[0].latestObservation, b);
  assert.equal(report.jobs.items[0].latestObservedContent, "Second edit");
  assert.equal(report.jobs.items[0].edited, true);
  assert.strictEqual(report.jobs.items[0].output, originalOutput);
  assert.deepEqual(
    report.observations.items.map((item) => item.id),
    ["zzz-later", "aaa-earlier"],
  );

  // Legacy snapshots without sequence preserve append order, not UUID ordering.
  const legacy = buildOperationsReport(
    snapshot({
      jobs: [original],
      observations: [observation("aaa"), observation("zzz")],
    }),
  );
  assert.equal(legacy.jobs.items[0].latestObservation?.id, "zzz");
  for (const sequence of [0, Number.NaN, 1.5]) {
    assert.throws(
      () =>
        buildOperationsReport(snapshot({ observations: [{ ...a, sequence }] })),
      /Observation sequence/,
    );
  }
});

void test("missing comparisons are null, unchanged text is false, and whitespace edits remain observable", () => {
  const jobs = [
    job("missing-output", { state: "submitted", postizId: "postiz-job" }),
    job("unobserved", {
      state: "submitted",
      postizId: "unobserved",
      output: { post: "Draft" },
    }),
    job("unchanged", {
      state: "submitted",
      postizId: "postiz-job",
      output: { post: "Original draft" },
    }),
    job("whitespace", {
      state: "submitted",
      postizId: "postiz-job",
      output: { post: "Original draft" },
    }),
  ];
  const report = buildOperationsReport(
    snapshot({
      jobs,
      observations: [
        observation("missing", { jobId: "missing-output" }),
        observation("same", { jobId: "unchanged" }),
        observation("space", {
          jobId: "whitespace",
          content: "Original draft ",
        }),
      ],
    }),
  );
  const items = new Map(report.jobs.items.map((item) => [item.id, item]));
  assert.equal(items.get("missing-output")?.edited, null);
  assert.equal(items.get("unobserved")?.edited, null);
  assert.equal(items.get("unobserved")?.latestObservedContent, null);
  assert.equal(items.get("unchanged")?.edited, false);
  assert.equal(items.get("whitespace")?.edited, true);
  assert.equal(report.jobs.editComparisonUnavailable, 2);
});

void test("writing starts, previews and recorded model requests have separate counts", () => {
  const writing: ReportWritingCall[] = [
    "relevance",
    "report",
    "post",
    "quality",
  ].map((task, index) => ({
    id: `call-${index}`,
    brandId: "tokenhot",
    jobId: "job",
    task: task as ReportWritingCall["task"],
    startedAt: NOW - 800 + index,
  }));
  const report = buildOperationsReport(
    snapshot({
      jobs: [job("job")],
      generationAttempts: [
        {
          id: "generation",
          brandId: "tokenhot",
          jobId: "job",
          kind: "generation",
          dayKey: "2026-09-24",
          timeZone: "UTC",
          startedAt: NOW - 900,
        },
        {
          id: "preview",
          brandId: "tokenhot",
          jobId: null,
          kind: "preview",
          dayKey: "2026-09-24",
          timeZone: "UTC",
          startedAt: NOW - 800,
        },
      ],
      writingCalls: writing,
      selectionCalls: [
        {
          id: "select",
          brandId: "tokenhot",
          task: "selection",
          candidateIds: ["a", "b"],
          startedAt: NOW - 1000,
        },
        {
          id: "review",
          brandId: "tokenhot",
          task: "selection_review",
          candidateIds: ["a", "b"],
          startedAt: NOW - 950,
        },
      ],
      candidates: [
        {
          id: "a",
          brandId: "tokenhot",
          status: "selected",
          fetchState: "fetched",
          origin: "rss",
          primary: true,
          topicId: "topic",
          createdAt: NOW - 10_000,
          lastError: null,
        },
        {
          id: "b",
          brandId: "tokenhot",
          status: "new",
          fetchState: "pending",
          origin: "manual",
          primary: false,
          topicId: null,
          createdAt: NOW - 10_000,
          lastError: null,
        },
      ],
    }),
  );
  assert.deepEqual(report.generationAttempts, {
    total: 2,
    kinds: { generation: 1, preview: 1 },
  });
  assert.equal(report.modelCalls.total, 6);
  assert.deepEqual(report.modelCalls.writing, {
    total: 4,
    tasks: { post: 1, quality: 1, relevance: 1, report: 1 },
  });
  assert.equal(report.modelCalls.selection.total, 2);
  assert.equal(report.modelCalls.selection.distinctCandidateCount, 2);
  assert.deepEqual(report.candidates, {
    total: 2,
    statuses: { new: 1, selected: 1 },
    fetchStates: { fetched: 1, pending: 1 },
    origins: { manual: 1, rss: 1 },
    primary: 1,
    linkedToTopic: 1,
    failureItems: [],
    decisionItems: [],
  });
  assert.equal(report.unmatchedReferences.generationAttemptsWithoutJob, 0);
});

void test("feedback retains operator records and groups review reasons without inventing changes", () => {
  const input = Object.freeze([
    Object.freeze(
      feedback("second", {
        reason: " Use a concrete\nAPI example ",
        createdAt: NOW - 200,
      }),
    ),
    Object.freeze(feedback("first", { createdAt: NOW - 300 })),
    Object.freeze(
      feedback("reject", {
        kind: "reject",
        reason: "Use a concrete API example",
        createdAt: NOW - 100,
      }),
    ),
  ]);
  const output = Object.freeze({
    post: "Original",
    brand: Object.freeze({ name: "Tokenhot" }),
  });
  const report = buildOperationsReport(
    snapshot({ jobs: [job("job", { output })], feedback: input }),
  );
  assert.deepEqual(report.feedback.kinds, { edit: 2, reject: 1 });
  assert.deepEqual(report.feedback.reviewSignals[0], {
    kind: "edit",
    reason: "Use a concrete API example",
    count: 2,
    jobIds: ["job"],
    feedbackIds: ["first", "second"],
    latestAt: NOW - 200,
  });
  assert.equal(report.feedback.reviewSignals.length, 2);
  assert.strictEqual(report.jobs.items[0].output, output);
  assert.strictEqual(report.feedback.items[1], input[0]);
  assert.equal(
    report.feedback.items[1].reason,
    " Use a concrete\nAPI example ",
  );
  assert.deepEqual(
    input.map((item) => item.id),
    ["second", "first", "reject"],
  );
});

void test("brand isolation applies to every collection and missing references remain explicit", () => {
  const report = buildOperationsReport(
    snapshot({
      jobs: [job("job"), job("foreign", { brandId: "other" })],
      candidates: [
        {
          id: "foreign",
          brandId: "other",
          status: "new",
          fetchState: "pending",
          origin: "rss",
          primary: true,
          topicId: null,
          createdAt: NOW - 10_000,
          lastError: null,
        },
      ],
      observations: [
        observation("foreign", { brandId: "other" }),
        observation("missing", { jobId: "missing" }),
      ],
      feedback: [
        feedback("foreign", { brandId: "other" }),
        feedback("missing", { jobId: "missing" }),
      ],
      generationAttempts: [
        {
          id: "foreign",
          brandId: "other",
          jobId: null,
          kind: "preview",
          dayKey: "2026-09-24",
          timeZone: "UTC",
          startedAt: NOW,
        },
        {
          id: "missing",
          brandId: "tokenhot",
          jobId: "missing",
          kind: "generation",
          dayKey: "2026-09-24",
          timeZone: "UTC",
          startedAt: NOW,
        },
      ],
      selectionCalls: [
        {
          id: "foreign",
          brandId: "other",
          task: "selection",
          candidateIds: ["foreign"],
          startedAt: NOW,
        },
      ],
      writingCalls: [
        {
          id: "foreign",
          brandId: "other",
          jobId: "job",
          task: "post",
          startedAt: NOW,
        },
        {
          id: "missing",
          brandId: "tokenhot",
          jobId: "missing",
          task: "post",
          startedAt: NOW,
        },
      ],
      incompleteCollections: ["jobs", "observations", "jobs"],
    }),
  );
  assert.equal(report.jobs.total, 1);
  assert.equal(report.candidates.total, 0);
  assert.equal(report.feedback.total, 1);
  assert.equal(report.observations.total, 1);
  assert.equal(report.generationAttempts.total, 1);
  assert.equal(report.modelCalls.total, 1);
  assert.deepEqual(report.unmatchedReferences, {
    feedbackWithoutJob: 1,
    observationsWithoutJob: 1,
    observationsWithDifferentReceipt: 0,
    generationAttemptsWithoutJob: 1,
    writingCallsWithoutJob: 1,
  });
  assert.deepEqual(report.scope, {
    brandId: "tokenhot",
    generatedAt: NOW,
    basis: "provided_snapshot",
    incompleteCollections: ["jobs", "observations"],
  });
});

void test("duplicate snapshots cannot silently inflate totals and invalid clocks are rejected", () => {
  assert.throws(
    () => buildOperationsReport(snapshot({ jobs: [job("same"), job("same")] })),
    /unique per brand/,
  );
  assert.throws(
    () =>
      buildOperationsReport(
        snapshot({ observations: [observation("same"), observation("same")] }),
      ),
    /unique per brand/,
  );
  assert.throws(
    () => buildOperationsReport(snapshot({ generatedAt: NaN })),
    /timestamp/,
  );
  assert.throws(
    () =>
      buildOperationsReport(
        snapshot({ observations: [observation("bad", { observedAt: -1 })] }),
      ),
    /timestamp/,
  );
  assert.doesNotThrow(() =>
    buildOperationsReport(
      snapshot({
        jobs: [job("same"), job("same", { brandId: "other" })],
      }),
    ),
  );
});

void test("empty persisted data is an explicit empty snapshot with no inferred publishing or metrics", () => {
  const report = buildOperationsReport(snapshot());
  assert.equal(report.jobs.total, 0);
  assert.equal(report.jobs.deliveryStates.published, 0);
  assert.equal(report.jobs.deliveryStates.scheduled, 0);
  assert.equal(report.jobs.edited, 0);
  assert.equal(report.modelCalls.total, 0);
  assert.equal(report.generationAttempts.total, 0);
  assert.equal(Object.prototype.hasOwnProperty.call(report, "metrics"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(report, "revenue"), false);
  assert.equal(
    Object.prototype.hasOwnProperty.call(report.modelCalls, "cost"),
    false,
  );
  assert.equal(report.today, null);
});

void test("daily counters use the supplied brand-local half-open window and distinguish first observed drafts", () => {
  const startsAt = Date.parse("2026-09-23T16:00:00Z");
  const resetsAt = Date.parse("2026-09-24T16:00:00Z");
  const dayWindow = {
    dayKey: "2026-09-24",
    timeZone: "Asia/Shanghai",
    startsAt,
    resetsAt,
  };
  const candidates = [startsAt - 1, startsAt, resetsAt - 1, resetsAt].map(
    (createdAt, index) => ({
      id: `candidate-${index}`,
      brandId: "tokenhot",
      status: "new" as const,
      fetchState: "pending" as const,
      origin: "rss",
      primary: false,
      topicId: null,
      lastError: null,
      createdAt,
    }),
  );
  const attempts = [startsAt - 1, startsAt, resetsAt - 1, resetsAt].map(
    (startedAt, index) => ({
      id: `attempt-${index}`,
      brandId: "tokenhot",
      jobId: null,
      kind: (index === 1 ? "preview" : "generation") as
        "preview" | "generation",
      dayKey: "2026-09-24",
      timeZone: "Asia/Shanghai",
      startedAt,
    }),
  );
  const report = buildOperationsReport(
    snapshot({
      dayWindow,
      candidates,
      generationAttempts: attempts,
      writingCalls: [
        {
          id: "before",
          brandId: "tokenhot",
          jobId: null,
          task: "post",
          startedAt: startsAt - 1,
        },
        {
          id: "today",
          brandId: "tokenhot",
          jobId: null,
          task: "post",
          startedAt: startsAt,
        },
      ],
      selectionCalls: [
        {
          id: "today",
          brandId: "tokenhot",
          task: "selection",
          candidateIds: [],
          startedAt: startsAt,
        },
      ],
      jobs: [
        job("old-draft", {
          state: "submitted",
          postizId: "postiz-job",
          postizState: "DRAFT",
          createdAt: startsAt - 10_000,
        }),
        job("old-first-seen", {
          state: "submitted",
          postizId: "postiz-job",
          postizState: "DRAFT",
          createdAt: startsAt - 10_000,
        }),
        job("new-unsubmitted", { createdAt: startsAt }),
      ],
      observations: [
        observation("older", { jobId: "old-draft", observedAt: startsAt - 1 }),
        observation("same-old-draft", {
          jobId: "old-draft",
          observedAt: startsAt,
        }),
        observation("first-seen", {
          jobId: "old-first-seen",
          observedAt: startsAt,
        }),
      ],
    }),
  );
  assert.deepEqual(report.today, {
    ...dayWindow,
    todayCandidates: 2,
    todayGenerationStarts: 2,
    generationStartsByKind: { generation: 1, preview: 1 },
    writingCallStarts: 1,
    selectionCallStarts: 1,
    newJobs: 1,
    firstObservedDrafts: 1,
  });
  assert.equal(report.jobs.deliveryStates.draft, 2);
  assert.equal(report.jobs.deliveryStates.published, 0);
  assert.throws(
    () =>
      buildOperationsReport(
        snapshot({ dayWindow: { ...dayWindow, resetsAt: startsAt } }),
      ),
    /increasing bounds/,
  );
});

void test("candidate failure reasons remain available for operator review", () => {
  const report = buildOperationsReport(
    snapshot({
      candidates: [
        {
          id: "bad-source",
          brandId: "tokenhot",
          status: "failed",
          fetchState: "failed",
          origin: "rss",
          primary: false,
          topicId: null,
          createdAt: NOW,
          lastError: "Source returned empty content",
        },
      ],
    }),
  );
  assert.deepEqual(report.candidates.failureItems, [
    {
      id: "bad-source",
      status: "failed",
      fetchState: "failed",
      origin: "rss",
      lastError: "Source returned empty content",
    },
  ]);
});

void test("successful selection reasons never appear as failures, while review and rejection reasons remain visible", () => {
  const base = {
    brandId: "tokenhot",
    fetchState: "fetched" as const,
    origin: "rss",
    primary: false,
    topicId: null,
    createdAt: NOW,
  };
  const report = buildOperationsReport(
    snapshot({
      candidates: [
        {
          ...base,
          id: "selected",
          status: "selected",
          topicId: "ready-topic",
          lastError: "Evidence and relevance checks passed",
        },
        {
          ...base,
          id: "rejected",
          status: "rejected",
          lastError: "This announcement is outside the freshness window",
        },
        {
          ...base,
          id: "review",
          status: "needs_review",
          lastError: "Cannot establish which product version was released",
        },
        {
          ...base,
          id: "failed",
          status: "failed",
          fetchState: "failed",
          lastError: "Source returned HTTP 503",
        },
      ],
    }),
  );
  assert.deepEqual(
    report.candidates.failureItems.map((item) => item.id),
    ["failed"],
  );
  assert.deepEqual(report.candidates.decisionItems, [
    {
      id: "rejected",
      status: "rejected",
      origin: "rss",
      reason: "This announcement is outside the freshness window",
    },
    {
      id: "review",
      status: "needs_review",
      origin: "rss",
      reason: "Cannot establish which product version was released",
    },
  ]);
  assert.equal(report.candidates.statuses.selected, 1);
});
