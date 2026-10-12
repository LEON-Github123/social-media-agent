import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { ContentJobStore, JobConflictError } from "../store.js";
import type { SocialAssessment, XPostSnapshot } from "../social-types.js";

const DAY = 86_400_000;
const brandId = "tokenhot";
const initial = Date.parse("2026-10-05T15:59:00Z");

class TestStore extends ContentJobStore {
  assess(id: string, relevance = 100, reusability = 100, error = false) {
    const item: SocialAssessment = {
      candidateId: id,
      title: "具体问题",
      summary: "集成实践",
      reason: "适合受众",
      angle: "展示步骤",
      factGaps: [],
      relevance,
      reusability,
      kind: "creative",
      requiresBrandFacts: false,
      excludedReason: null,
    };
    this.db
      .prepare(
        "UPDATE social_candidates SET assessment_json=?, error_code=? WHERE candidate_id=?",
      )
      .run(JSON.stringify(item), error ? "provider" : null, id);
  }
  protect(id: string) {
    this.db
      .prepare("UPDATE content_candidates SET legacy_conflict=1 WHERE id=?")
      .run(id);
  }
  reject(id: string) {
    this.db
      .prepare("UPDATE content_candidates SET status='rejected' WHERE id=?")
      .run(id);
  }
}

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "postiz-editorial-"));
  const path = join(directory, "content.sqlite");
  let clock = initial;
  const stores = new Set<TestStore>();
  const open = () => {
    const store = new TestStore(path, { now: () => clock });
    stores.add(store);
    return store;
  };
  t.after(() => {
    for (const store of stores) store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    open,
    now: () => clock,
    advance: (ms: number) => {
      clock += ms;
    },
    close: (store: TestStore) => {
      store.close();
      stores.delete(store);
    },
  };
}

function candidate(
  store: TestStore,
  tweetId: string,
  time: number,
  brand = brandId,
  handle = "small",
) {
  const item = store.upsertCandidates({
    brandId: brand,
    origin: "twitterapi-user",
    sourceId: "competitor-a",
    inputs: [
      {
        url: `https://x.com/${handle}/status/${tweetId}`,
        text: `API integration ${tweetId}`,
        publishedAt: new Date(time - 3600_000).toISOString(),
      },
    ],
  })[0];
  store.recordSocialObservation(
    item.id,
    snapshot(tweetId, time, { authorHandle: handle, authorId: handle }),
  );
  return item;
}

function snapshot(
  tweetId: string,
  observedAt: number,
  patch: Partial<XPostSnapshot> = {},
): XPostSnapshot {
  return {
    tweetId,
    authorId: "small",
    authorHandle: "small",
    authorName: "Small",
    postType: "original",
    quotedTweetId: null,
    publishedAt: new Date(observedAt - 3600_000).toISOString(),
    observedAt,
    views: 100,
    likes: 10,
    replies: 0,
    reposts: 0,
    quotes: 0,
    bookmarks: null,
    ...patch,
  };
}

void test("Shanghai midnight changes new bucket; explicit seen is idempotent and durable", (t) => {
  const f = fixture(t);
  const store = f.open();
  const old = candidate(store, "101", f.now());
  assert.equal(store.listSocialStates(brandId)[0].editorial?.bucket, "new");
  assert.equal(store.listAuditEvents().length, 0);
  f.advance(60_000);
  assert.equal(store.listSocialStates(brandId)[0].editorial?.bucket, "backlog");
  assert.equal(store.listSocialStates(brandId)[0].editorial?.waitingDays, 1);
  const fresh = candidate(store, "102", f.now());
  const seen = store.markEditorialSeen(brandId, fresh.id);
  f.advance(1000);
  assert.deepEqual(store.markEditorialSeen(brandId, fresh.id), seen);
  assert.equal(
    store
      .listAuditEvents()
      .filter((item) => item.eventType === "editorial.seen").length,
    1,
  );
  f.close(store);
  const reopened = f.open();
  assert.equal(
    reopened
      .listSocialStates(brandId)
      .find((item) => item.candidateId === fresh.id)?.editorial?.seenAt,
    seen.seenAt,
  );
  assert.equal(
    reopened
      .listSocialStates(brandId)
      .find((item) => item.candidateId === old.id)?.editorial?.bucket,
    "backlog",
  );
});

void test("rising requires yesterday baseline, valid metrics, ratio and absolute growth", (t) => {
  const f = fixture(t);
  const store = f.open();
  const targets = ["201", "202", "203", "204", "205", "206", "207"].map((id) =>
    candidate(store, id, f.now()),
  );
  // Most recent yesterday baseline must win over earlier observations.
  store.recordSocialObservation(
    targets[1].id,
    snapshot("202", f.now() + 1000, { views: 200 }),
  );
  store.recordSocialObservation(
    targets[2].id,
    snapshot("203", f.now() + 1000, { views: null, likes: null }),
  );
  f.advance(60_000);
  const patches: Partial<XPostSnapshot>[] = [
    { views: 200 },
    { views: 250 },
    { views: 500, likes: 50 },
    { views: 150 },
    { views: null, likes: 20 },
    { views: null, likes: 19 },
    { views: 199 },
  ];
  targets.forEach((item, index) =>
    store.recordSocialObservation(
      item.id,
      snapshot(String(201 + index), f.now(), patches[index]),
    ),
  );
  const buckets = new Map(
    store
      .listSocialStates(brandId)
      .map((item) => [item.candidateId, item.editorial?.bucket]),
  );
  assert.deepEqual(
    targets.map((item) => buckets.get(item.id)),
    ["rising", "backlog", "backlog", "backlog", "rising", "backlog", "backlog"],
  );
  const todayOnly = candidate(store, "208", f.now());
  store.markEditorialSeen(brandId, todayOnly.id);
  f.advance(1000);
  store.recordSocialObservation(
    todayOnly.id,
    snapshot("208", f.now(), { views: 1000, likes: 100 }),
  );
  const state = store
    .listSocialStates(brandId)
    .find((item) => item.candidateId === todayOnly.id)!;
  assert.equal(state.editorial?.bucket, "backlog");
  assert.match(
    store
      .listSocialStates(brandId)
      .find((item) => item.candidateId === targets[0].id)!.editorial!.reason,
    /不代表转化/,
  );
});

void test("new ranks before high-score backlog within unchanged quality and 10/3 caps", (t) => {
  const f = fixture(t);
  const store = f.open();
  // Reference observations supply adequate performance samples without entering recommendations.
  for (let index = 0; index < 12; index++)
    candidate(store, String(300 + index), f.now(), brandId, "reference");
  const backlog = candidate(store, "320", f.now(), brandId, "account-a");
  store.recordSocialObservation(
    backlog.id,
    snapshot("320", f.now() + 1, {
      views: 10000,
      likes: 2000,
      authorHandle: "account-a",
    }),
  );
  store.assess(backlog.id);
  f.advance(60_000);
  const fresh: ReturnType<typeof candidate>[] = [];
  for (let index = 0; index < 12; index++) {
    const handle = index < 4 ? "account-a" : `account-${index}`;
    const item = candidate(
      store,
      String(330 + index),
      f.now(),
      brandId,
      handle,
    );
    store.recordSocialObservation(
      item.id,
      snapshot(String(330 + index), f.now() + 1, {
        views: 2000,
        likes: 400,
        authorHandle: handle,
      }),
    );
    store.assess(item.id, 90, 90);
    fresh.push(item);
  }
  const poor = candidate(store, "350", f.now());
  store.assess(poor.id, 20, 20);
  const error = candidate(store, "351", f.now());
  store.assess(error.id, 100, 100, true);
  const protectedItem = candidate(store, "352", f.now());
  store.assess(protectedItem.id);
  store.protect(protectedItem.id);
  const stale = candidate(store, "353", f.now());
  store.assess(stale.id);
  store.recordSocialObservation(
    stale.id,
    snapshot("353", f.now() + 1, {
      publishedAt: new Date(f.now() - 8 * DAY).toISOString(),
    }),
  );
  f.advance(2);
  const states = store.listSocialStates(brandId);
  const recommended = states.filter((item) => item.tier === "recommended");
  assert.equal(recommended.length, 10);
  assert.equal(
    recommended.filter((item) => item.social?.authorHandle === "account-a")
      .length,
    3,
  );
  assert.ok(
    recommended.every((item) =>
      fresh.some((freshItem) => freshItem.id === item.candidateId),
    ),
  );
  assert.equal(
    states.find((item) => item.candidateId === poor.id)?.tier,
    "not_recommended",
  );
  assert.equal(
    states.find((item) => item.candidateId === error.id)?.tier,
    "error",
  );
  assert.equal(
    states.find((item) => item.candidateId === protectedItem.id)?.tier,
    "history",
  );
  assert.equal(
    states.find((item) => item.candidateId === stale.id)?.tier,
    "history",
  );
  assert.ok(states.filter((item) => item.limitReason).length >= 3);
  assert.match(
    states.find((item) => item.candidateId === backlog.id)!.limitReason!,
    /3 条/,
  );
});

void test("snooze survives reopening; tick preserves attempts and later manual holds", (t) => {
  const f = fixture(t);
  const store = f.open();
  const due = candidate(store, "401", f.now());
  const held = candidate(store, "402", f.now());
  const continued = candidate(store, "403", f.now());
  const protectedItem = candidate(store, "404", f.now());
  const rejected = candidate(store, "405", f.now());
  const long = candidate(store, "406", f.now());
  const indefinite = candidate(store, "407", f.now());
  store.beginSocialEvaluation([due.id]);
  const until = store.snoozeEditorialCandidate({
    brandId,
    candidateId: due.id,
    days: 1,
    reason: "明早处理",
  }).snoozedUntil;
  assert.equal(until, Date.parse("2026-10-06T01:00:00Z"));
  for (const item of [held, continued, protectedItem, rejected])
    store.snoozeEditorialCandidate({
      brandId,
      candidateId: item.id,
      days: 1,
      reason: "明早处理",
    });
  store.holdSocialCandidate(brandId, held.id, true, "长期观察");
  store.holdSocialCandidate(brandId, continued.id, false, "手动继续");
  store.holdSocialCandidate(brandId, continued.id, true, "再次人工观察");
  store.protect(protectedItem.id);
  store.reject(rejected.id);
  const later = store.snoozeEditorialCandidate({
    brandId,
    candidateId: long.id,
    days: 3,
    reason: "三天后",
  });
  assert.equal(later.snoozedUntil, Date.parse("2026-10-08T01:00:00Z"));
  store.holdSocialCandidate(brandId, indefinite.id, true, "长期观察");
  f.close(store);
  f.advance(until - f.now());
  const reopened = f.open();
  assert.equal(
    reopened
      .listSocialStates(brandId)
      .find((item) => item.candidateId === due.id)?.held,
    true,
  );
  assert.deepEqual(reopened.resumeDueEditorialSnoozes(brandId), [due.id]);
  assert.deepEqual(reopened.resumeDueEditorialSnoozes(brandId), []);
  const states = reopened.listSocialStates(brandId);
  assert.equal(states.find((item) => item.candidateId === due.id)?.attempts, 1);
  for (const item of [
    held,
    continued,
    protectedItem,
    rejected,
    long,
    indefinite,
  ])
    assert.equal(
      states.find((state) => state.candidateId === item.id)?.held,
      true,
    );
  assert.equal(
    states.find((item) => item.candidateId === held.id)?.editorial
      ?.snoozedUntil,
    null,
  );
  f.advance(2 * DAY);
  assert.deepEqual(reopened.resumeDueEditorialSnoozes(brandId), [long.id]);
  assert.equal(reopened.list({ brandId }).length, 0);
  assert.equal(reopened.socialQuotas(brandId).selection.used, 0);
});

void test("feedback is latest per candidate, isolated by brand; preferences require confirmation and optimistic version", (t) => {
  const f = fixture(t);
  const store = f.open();
  const own = candidate(store, "501", f.now());
  const other = candidate(store, "502", f.now(), "other");
  const manual = store.upsertCandidates({
    brandId,
    origin: "manual",
    inputs: [{ url: "https://example.com/manual", text: "manual content" }],
  })[0];
  assert.throws(
    () =>
      store.recordEditorialFeedback({
        brandId,
        candidateId: other.id,
        tag: "useful_topic",
      }),
    JobConflictError,
  );
  assert.throws(
    () => store.markEditorialSeen("other", own.id),
    JobConflictError,
  );
  assert.throws(
    () =>
      store.snoozeEditorialCandidate({
        brandId: "other",
        candidateId: own.id,
        days: 1,
        reason: "hold",
      }),
    JobConflictError,
  );
  assert.throws(
    () =>
      store.recordEditorialFeedback({
        brandId,
        candidateId: manual.id,
        tag: "useful_topic",
      }),
    JobConflictError,
  );
  store.recordEditorialFeedback({
    brandId,
    candidateId: own.id,
    tag: "useful_topic",
    note: "first",
  });
  store.recordEditorialFeedback({
    brandId,
    candidateId: own.id,
    tag: "too_broad",
    note: "latest",
  });
  store.recordEditorialFeedback({
    brandId: "other",
    candidateId: other.id,
    tag: "product_demo",
  });
  const summary = store.getEditorialDashboard(brandId).feedbackSummary;
  assert.match(summary.suggestions[0], /样本 1\/20/);
  assert.equal(summary.uniqueCandidates, 1);
  assert.equal(summary.tagCounts.useful_topic, 0);
  assert.equal(summary.tagCounts.too_broad, 1);
  assert.equal(summary.tagCounts.product_demo, 0);
  assert.equal(
    store
      .listAuditEvents({ brandId })
      .filter((item) => item.eventType === "editorial.feedback").length,
    2,
  );
  assert.equal(store.getEditorialPreferences(brandId).version, 0);
  const input = {
    brandId,
    expectedVersion: 0,
    selectionGuidance: "具体场景",
    writingGuidance: "展示步骤",
    examples: ["简洁示例"],
    confirmed: true as const,
  };
  assert.throws(() =>
    Reflect.apply(store.saveEditorialPreferences, store, [
      { ...input, confirmed: false },
    ]),
  );
  assert.throws(() =>
    store.saveEditorialPreferences({
      ...input,
      selectionGuidance: "x".repeat(1201),
    }),
  );
  assert.throws(() =>
    store.saveEditorialPreferences({
      ...input,
      examples: ["a", "b", "c", "d"],
    }),
  );
  assert.throws(() =>
    store.saveEditorialPreferences({ ...input, examples: ["x".repeat(601)] }),
  );
  const saved = store.saveEditorialPreferences(input);
  assert.equal(saved.version, 1);
  assert.throws(() => store.saveEditorialPreferences(input), JobConflictError);
  assert.equal(store.getEditorialPreferences("other").version, 0);
  assert.equal(store.list({ brandId }).length, 0);
  assert.equal(store.getGenerationQuota({ brandId }).used, 0);
  assert.equal(store.socialQuotas(brandId).selection.used, 0);
  assert.equal(store.socialQuotas(brandId).provider.used, 0);
  f.close(store);
  const reopened = f.open();
  assert.deepEqual(reopened.getEditorialPreferences(brandId), saved);
});

void test("approval after snooze protects frozen evidence while marking seen stays harmless", (t) => {
  const f = fixture(t);
  const store = f.open();
  const item = candidate(store, "601", f.now());
  store.recordCandidateDocument(item.id, {
    ...item.input,
    text: "API integration evidence",
  });
  store.saveSelection({
    brandId,
    result: {
      modelCalls: 0,
      warnings: [],
      candidateDecisions: [
        {
          candidateId: item.id,
          status: "selected",
          identity: null,
          topicId: "editorial-approval",
          reason: "human review",
          totalScore: 100,
          scores: {
            relevance: 100,
            evidence: 100,
            developerValue: 100,
            freshness: null,
          },
        },
      ],
      topics: [
        {
          id: "editorial-approval",
          identityKey: "editorial-approval",
          identity: {
            entity: "small",
            product: "API",
            version: null,
            eventType: "other",
            eventDate: null,
            primaryUrl: item.input.url,
          },
          title: "API practice",
          candidateIds: [item.id],
          sourceCandidateIds: [item.id],
          sourceMetadata: [
            { candidateId: item.id, url: item.input.url, primary: false },
          ],
          status: "ready",
          reason: "human review",
        },
      ],
    },
  });
  const until = store.snoozeEditorialCandidate({
    brandId,
    candidateId: item.id,
    days: 1,
    reason: "later",
  }).snoozedUntil;
  const approved = store.reviewTopic("editorial-approval", {
    brandId,
    decision: "approve",
    reason: "approved evidence",
  });
  store.markEditorialSeen(brandId, item.id);
  assert.deepEqual(store.getTopic("editorial-approval"), approved);
  f.advance(until - f.now());
  assert.deepEqual(store.resumeDueEditorialSnoozes(brandId), []);
  assert.deepEqual(store.getTopic("editorial-approval"), approved);
  assert.equal(store.listSocialStates(brandId)[0].held, true);
  assert.throws(
    () =>
      store.snoozeEditorialCandidate({
        brandId,
        candidateId: item.id,
        days: 1,
        reason: "repeat",
      }),
    JobConflictError,
  );
});

void test("snooze invalidates an in-flight recovery even after automatic resume", async (t) => {
  const f = fixture(t);
  const store = f.open();
  const item = candidate(store, "701", f.now());
  store.recordCandidateDocument(item.id, {
    ...item.input,
    text: "API integration evidence",
  });
  store.beginSocialEvaluation([item.id]);
  store.saveSocialSelection(brandId, {
    selection: {
      modelCalls: 0,
      candidateDecisions: [],
      topics: [],
      warnings: [],
    },
    assessments: [],
    failures: [
      {
        candidateId: item.id,
        code: "provider",
        message: "offline failure fixture",
      },
    ],
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const retry = store.retrySocialEvaluation(
    {
      brand: {
        id: brandId,
        name: "Tokenhot",
        audience: "Developers",
        businessContext: "API integration",
        contentRules: [],
        examples: [],
        language: "English",
      },
      candidateId: item.id,
      reason: "manual retry",
    },
    {
      model: {
        async invoke() {
          await gate;
          return "{}";
        },
      },
    },
  );
  const rejected = assert.rejects(retry, JobConflictError);
  const until = store.snoozeEditorialCandidate({
    brandId,
    candidateId: item.id,
    days: 1,
    reason: "pause in-flight",
  }).snoozedUntil;
  f.advance(until - f.now());
  assert.deepEqual(store.resumeDueEditorialSnoozes(brandId), [item.id]);
  release();
  await rejected;
  assert.equal(store.getCandidate(item.id)?.topicId, null);
  assert.equal(store.listTopics({ brandId }).length, 0);
  assert.equal(store.listSocialStates(brandId)[0].attempts, 2);
});
