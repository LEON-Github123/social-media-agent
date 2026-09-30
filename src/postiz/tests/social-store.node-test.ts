import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { ContentJobStore, JobConflictError } from "../store.js";
import type { SocialSelectionResult, XPostSnapshot } from "../social-types.js";

const brandId = "tokenhot";
const now = Date.parse("2026-09-30T12:00:00Z");
const DAY = 86_400_000;

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "postiz-social-store-"));
  const path = join(directory, "content.sqlite");
  const stores = new Set<ContentJobStore>();
  let clock = now;
  const open = () => {
    const store = new ContentJobStore(path, { now: () => clock });
    stores.add(store);
    return store;
  };
  const close = (store: ContentJobStore) => {
    store.close();
    stores.delete(store);
  };
  t.after(() => {
    for (const store of stores) store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    open,
    close,
    now: () => clock,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

function socialCandidate(store: ContentJobStore, tweetId: string) {
  return store.upsertCandidates({
    brandId,
    origin: "twitterapi-user",
    sourceId: "competitor-a",
    inputs: [
      {
        url: `https://x.com/small/status/${tweetId}`,
        text: `Developer discusses API choice ${tweetId}.`,
        publishedAt: new Date(now - 12 * 3_600_000).toISOString(),
      },
    ],
  })[0];
}

function snapshot(
  tweetId: string,
  observedAt = now,
  patch: Partial<XPostSnapshot> = {},
): XPostSnapshot {
  return {
    tweetId,
    authorId: "small",
    authorHandle: "small",
    authorName: "Small",
    postType: "original",
    quotedTweetId: null,
    publishedAt: new Date(now - 12 * 3_600_000).toISOString(),
    observedAt,
    views: 100,
    likes: 10,
    replies: 1,
    reposts: 1,
    quotes: 0,
    bookmarks: 0,
    ...patch,
  };
}

void test("provider and model call quotas survive reopening and reset on Shanghai day", (t) => {
  const f = fixture(t);
  const first = f.open();
  for (let index = 0; index < 4; index++)
    first.reserveSocialProviderCall(brandId, "timeline", `account-${index}`);
  for (let index = 0; index < 17; index++)
    first.reserveSocialSelectionCall({
      brandId,
      task: "selection",
      candidateIds: [`candidate-${index}`],
    });
  f.close(first);
  const reopened = f.open();
  assert.equal(reopened.socialQuotas(brandId).provider.used, 4);
  assert.equal(reopened.socialQuotas(brandId).selection.used, 17);
  for (let index = 4; index < 10; index++)
    reopened.reserveSocialProviderCall(brandId, "timeline", `account-${index}`);
  assert.throws(
    () => reopened.reserveSocialProviderCall(brandId, "timeline", "extra"),
    JobConflictError,
  );
  for (let index = 17; index < 40; index++)
    reopened.reserveSocialSelectionCall({
      brandId,
      task: "selection",
      candidateIds: [`candidate-${index}`],
    });
  assert.throws(
    () =>
      reopened.reserveSocialSelectionCall({
        brandId,
        task: "selection_review",
        candidateIds: ["extra"],
      }),
    JobConflictError,
  );
  f.advance(4 * 3_600_000);
  assert.equal(reopened.socialQuotas(brandId).provider.used, 0);
  assert.equal(reopened.socialQuotas(brandId).selection.used, 0);
  reopened.reserveSocialProviderCall(brandId, "timeline", "account-0");
});

void test("refresh reservations enforce 20 IDs per call, 100 per day and no duplicate tweet", (t) => {
  const store = fixture(t).open();
  for (let batch = 0; batch < 5; batch++)
    store.reserveSocialProviderCall(
      brandId,
      "refresh",
      `batch-${batch}`,
      Array.from({ length: 20 }, (_, index) => String(batch * 20 + index)),
    );
  assert.equal(store.socialQuotas(brandId).provider.used, 5);
  assert.throws(
    () => store.reserveSocialProviderCall(brandId, "refresh", "sixth", ["100"]),
    JobConflictError,
  );
  assert.throws(
    () =>
      store.reserveSocialProviderCall(brandId, "refresh", "duplicate", ["1"]),
    JobConflictError,
  );
  assert.throws(
    () =>
      store.reserveSocialProviderCall(
        brandId,
        "refresh",
        "oversized",
        Array.from({ length: 21 }, (_, index) => String(index + 100)),
      ),
    JobConflictError,
  );
  assert.equal(store.socialQuotas(brandId).provider.used, 5);
});

void test("provider snapshots persist across restarts while missing metrics remain null", (t) => {
  const f = fixture(t);
  const store = f.open();
  const target = socialCandidate(store, "123");
  store.recordSocialObservation(
    target.id,
    snapshot("123", now, { quotes: null }),
  );
  store.recordSocialObservation(
    target.id,
    snapshot("123", now + 1000, { quotes: null, views: 120 }),
  );
  assert.equal(store.socialHistory(brandId).length, 2);
  f.close(store);
  f.advance(1000);
  const reopened = f.open();
  assert.equal(reopened.latestSocialSnapshot(target.id)?.views, 120);
  const state = reopened
    .listSocialStates(brandId)
    .find((item) => item.candidateId === target.id);
  assert.ok(state);
  assert.equal(state.performance?.interactions, null);
  assert.equal(state.performance?.interactionRate, null);
  assert.equal(state.performance?.score, null);
  assert.equal(state.tier, "pending");
});

void test("social state listing excludes RSS candidates and observations reject manual sources", (t) => {
  const store = fixture(t).open();
  store.upsertCandidates({
    brandId,
    origin: "rss",
    sourceId: "feed",
    inputs: [{ url: "https://example.com/rss", text: "RSS article" }],
  });
  const provider = socialCandidate(store, "123");
  const manual = store.upsertCandidates({
    brandId,
    origin: "manual",
    inputs: [{ url: "https://x.com/other/status/456", text: "Manual X link" }],
  })[0];
  assert.throws(
    () => store.recordSocialObservation(manual.id, snapshot("456")),
    TypeError,
  );
  store.recordSocialObservation(provider.id, snapshot("123"));
  assert.deepEqual(
    store.listSocialStates(brandId).map((item) => item.candidateId),
    [provider.id],
  );
});

void test("evaluation attempts stop at two and manual hold survives restart", (t) => {
  const f = fixture(t);
  const store = f.open();
  const candidate = socialCandidate(store, "123");
  store.recordSocialObservation(candidate.id, snapshot("123"));
  store.holdSocialCandidate(brandId, candidate.id, true, "Review later");
  f.close(store);
  const reopened = f.open();
  assert.equal(reopened.listSocialStates(brandId)[0].held, true);
  assert.throws(
    () => reopened.beginSocialEvaluation([candidate.id]),
    JobConflictError,
  );
  reopened.holdSocialCandidate(brandId, candidate.id, false, "Resume review");
  reopened.beginSocialEvaluation([candidate.id]);
  assert.throws(
    () => reopened.beginSocialEvaluation([candidate.id]),
    JobConflictError,
  );
  f.advance(60_000);
  reopened.beginSocialEvaluation([candidate.id]);
  assert.throws(
    () => reopened.beginSocialEvaluation([candidate.id]),
    JobConflictError,
  );
  assert.equal(reopened.listSocialStates(brandId)[0].attempts, 2);
  assert.throws(
    () => reopened.retrySocialCandidate(brandId, candidate.id, "Try again"),
    JobConflictError,
  );
  f.advance(DAY);
  assert.equal(reopened.listSocialStates(brandId)[0].attempts, 2);
});

void test("a human-approved social topic stays decided when stale automation tries to resave", (t) => {
  const f = fixture(t);
  const store = f.open();
  const candidate = socialCandidate(store, "123");
  store.recordSocialObservation(candidate.id, snapshot("123"));
  const identity = {
    entity: "small",
    product: "social:123",
    version: null,
    eventType: "other" as const,
    eventDate: null,
    primaryUrl: candidate.input.url,
  };
  const result: SocialSelectionResult = {
    selection: {
      modelCalls: 1,
      warnings: [],
      candidateDecisions: [
        {
          candidateId: candidate.id,
          status: "selected",
          identity,
          topicId: "social-123",
          scores: {
            relevance: 80,
            evidence: 80,
            developerValue: 80,
            freshness: null,
          },
          totalScore: 80,
          reason: "可用于开发者集成经验。",
        },
      ],
      topics: [
        {
          id: "social-123",
          identityKey: "social-123",
          identity,
          title: "开发者集成经验",
          candidateIds: [candidate.id],
          sourceCandidateIds: [candidate.id],
          sourceMetadata: [
            {
              candidateId: candidate.id,
              url: candidate.input.url,
              primary: false,
            },
          ],
          status: "ready",
          reason: "素材可用于原创分析。",
        },
      ],
    },
    assessments: [
      {
        candidateId: candidate.id,
        title: "开发者集成经验",
        summary: "接口使用经验。",
        reason: "可用于开发者集成经验。",
        angle: "解释接入取舍。",
        factGaps: [],
        relevance: 80,
        reusability: 80,
        kind: "creative",
        requiresBrandFacts: false,
        excludedReason: null,
      },
    ],
    failures: [],
  };
  store.saveSocialSelection(brandId, result);
  assert.equal(store.getTopic("social-123")?.status, "awaiting_approval");
  assert.equal(store.listSocialStates(brandId)[0].tier, "watch");
  assert.deepEqual(
    store.socialEvaluationCandidates(brandId, ["competitor-a"]),
    [],
  );
  store.reviewSocialTopic("social-123", {
    brand: {
      id: brandId,
      name: "Tokenhot",
      audience: "Developers",
      businessContext: "AI API integration",
      contentRules: [],
      examples: [],
      language: "English",
    },
    decision: "approve",
    reason: "Human approved",
    writingAngle: "解释接口接入的取舍。",
  });
  assert.equal(store.getTopic("social-123")?.status, "ready");
  assert.equal(store.getTopicIntent("social-123")?.purpose, "brand_original");
  assert.throws(
    () => store.saveSocialSelection(brandId, result),
    JobConflictError,
  );
  f.close(store);
  const reopened = f.open();
  assert.equal(reopened.getTopic("social-123")?.status, "ready");
  assert.equal(
    reopened.getTopicIntent("social-123")?.writingAngle,
    "解释接口接入的取舍。",
  );
  assert.equal(reopened.listSocialStates(brandId)[0].tier, "history");
});

void test("old unlinked review and fresh social decisions commit together without resetting attempts", (t) => {
  const store = fixture(t).open();
  const old = socialCandidate(store, "123");
  const fresh = socialCandidate(store, "456");
  store.recordSocialObservation(old.id, snapshot("123"));
  store.recordSocialObservation(fresh.id, snapshot("456"));
  store.saveSelection({
    brandId,
    result: {
      modelCalls: 1,
      warnings: [],
      topics: [],
      candidateDecisions: [
        {
          candidateId: old.id,
          status: "needs_review",
          identity: null,
          scores: {
            relevance: 0,
            evidence: 0,
            developerValue: 0,
            freshness: null,
          },
          totalScore: 0,
          reason: "旧筛选输出无效，需要重新评估。",
        },
      ],
    },
  });
  assert.equal(store.getCandidate(old.id)?.status, "needs_review");
  store.beginSocialEvaluation([old.id, fresh.id]);
  const result: SocialSelectionResult = {
    selection: {
      modelCalls: 1,
      warnings: [],
      topics: [],
      candidateDecisions: [old, fresh].map((candidate) => ({
        candidateId: candidate.id,
        status: "rejected" as const,
        identity: null,
        scores: {
          relevance: 20,
          evidence: 20,
          developerValue: 20,
          freshness: null,
        },
        totalScore: 20,
        reason: "与目标受众无关。",
      })),
    },
    assessments: [old, fresh].map((candidate) => ({
      candidateId: candidate.id,
      title: "低相关性素材",
      summary: "与受众无关。",
      reason: "与目标受众无关。",
      angle: "不建议采用。",
      factGaps: [],
      relevance: 20,
      reusability: 20,
      kind: "creative" as const,
      requiresBrandFacts: false,
      excludedReason: "与受众无关。",
    })),
    failures: [],
  };
  store.saveSocialSelection(brandId, result);
  assert.equal(store.getCandidate(old.id)?.status, "rejected");
  assert.equal(store.getCandidate(fresh.id)?.status, "rejected");
  assert.equal(
    store.listSocialStates(brandId).filter((state) => state.assessment).length,
    2,
  );
  assert.deepEqual(
    store
      .listSocialStates(brandId)
      .map((state) => state.attempts)
      .sort(),
    [1, 1],
  );
});

void test("linked review and prior skipped material are not silently reevaluated", (t) => {
  const store = fixture(t).open();
  const linked = socialCandidate(store, "123");
  const skipped = socialCandidate(store, "456");
  for (const candidate of [linked, skipped])
    store.recordSocialObservation(
      candidate.id,
      snapshot(candidate.id === linked.id ? "123" : "456"),
    );
  const identity = {
    entity: "small",
    product: "social:123",
    version: null,
    eventType: "other" as const,
    eventDate: null,
    primaryUrl: linked.input.url,
  };
  store.saveSelection({
    brandId,
    result: {
      modelCalls: 1,
      warnings: [],
      candidateDecisions: [
        {
          candidateId: linked.id,
          status: "needs_review",
          identity,
          topicId: "pending-social-123",
          scores: {
            relevance: 50,
            evidence: 50,
            developerValue: 50,
            freshness: null,
          },
          totalScore: 50,
          reason: "待人工核对。",
        },
        {
          candidateId: skipped.id,
          status: "rejected",
          identity: null,
          scores: {
            relevance: 0,
            evidence: 0,
            developerValue: 0,
            freshness: null,
          },
          totalScore: 0,
          reason: "人工已跳过。",
        },
      ],
      topics: [
        {
          id: "pending-social-123",
          identityKey: "pending-social-123",
          identity,
          title: "待核对的素材",
          candidateIds: [linked.id],
          sourceCandidateIds: [linked.id],
          sourceMetadata: [
            { candidateId: linked.id, url: linked.input.url, primary: false },
          ],
          status: "needs_review",
          reason: "待人工核对。",
        },
      ],
    },
  });
  assert.deepEqual(
    store.socialEvaluationCandidates(brandId, ["competitor-a"]),
    [],
  );
  assert.throws(
    () => store.beginSocialEvaluation([linked.id]),
    JobConflictError,
  );
  assert.throws(
    () => store.beginSocialEvaluation([skipped.id]),
    JobConflictError,
  );
  assert.equal(store.getCandidate(linked.id)?.topicId, "pending-social-123");
  assert.equal(store.getCandidate(skipped.id)?.status, "rejected");
});

void test("an in-flight model result cannot override a newly held candidate", (t) => {
  const store = fixture(t).open();
  const candidate = socialCandidate(store, "123");
  store.recordSocialObservation(candidate.id, snapshot("123"));
  store.beginSocialEvaluation([candidate.id]);
  store.holdSocialCandidate(
    brandId,
    candidate.id,
    true,
    "Human will review later",
  );
  const identity = {
    entity: "small",
    product: "social:123",
    version: null,
    eventType: "other" as const,
    eventDate: null,
    primaryUrl: candidate.input.url,
  };
  const result: SocialSelectionResult = {
    selection: {
      modelCalls: 1,
      warnings: [],
      candidateDecisions: [
        {
          candidateId: candidate.id,
          status: "selected",
          identity,
          topicId: "social-held-123",
          scores: {
            relevance: 80,
            evidence: 80,
            developerValue: 80,
            freshness: null,
          },
          totalScore: 80,
          reason: "可用于开发者分析。",
        },
      ],
      topics: [
        {
          id: "social-held-123",
          identityKey: "social-held-123",
          identity,
          title: "开发者分析",
          candidateIds: [candidate.id],
          sourceCandidateIds: [candidate.id],
          sourceMetadata: [
            {
              candidateId: candidate.id,
              url: candidate.input.url,
              primary: false,
            },
          ],
          status: "ready",
          reason: "需人工审批。",
        },
      ],
    },
    assessments: [
      {
        candidateId: candidate.id,
        title: "开发者分析",
        summary: "接口取舍。",
        reason: "可用于开发者分析。",
        angle: "比较集成取舍。",
        factGaps: [],
        relevance: 80,
        reusability: 80,
        kind: "creative",
        requiresBrandFacts: false,
        excludedReason: null,
      },
    ],
    failures: [],
  };
  assert.throws(
    () => store.saveSocialSelection(brandId, result),
    JobConflictError,
  );
  assert.equal(store.getTopic("social-held-123"), null);
  assert.equal(store.listSocialStates(brandId)[0].held, true);
  assert.equal(store.listSocialStates(brandId)[0].tier, "watch");
  assert.equal(store.listSocialStates(brandId)[0].errorCode, "provider");
  assert.equal(store.listSocialStates(brandId)[0].assessment, null);
  assert.equal(store.listSocialStates(brandId)[0].attempts, 1);
});

void test("an invalid mixed batch rolls back the temporary legacy status reset", (t) => {
  const store = fixture(t).open();
  const old = socialCandidate(store, "123");
  const fresh = socialCandidate(store, "456");
  for (const [candidate, tweetId] of [
    [old, "123"],
    [fresh, "456"],
  ] as const)
    store.recordSocialObservation(candidate.id, snapshot(tweetId));
  store.saveSelection({
    brandId,
    result: {
      modelCalls: 1,
      warnings: [],
      topics: [],
      candidateDecisions: [
        {
          candidateId: old.id,
          status: "needs_review",
          identity: null,
          scores: {
            relevance: 0,
            evidence: 0,
            developerValue: 0,
            freshness: null,
          },
          totalScore: 0,
          reason: "旧模型未能判断。",
        },
      ],
    },
  });
  const result: SocialSelectionResult = {
    assessments: [],
    failures: [],
    selection: {
      modelCalls: 1,
      warnings: [],
      topics: [],
      candidateDecisions: [
        {
          candidateId: old.id,
          status: "rejected",
          identity: null,
          scores: {
            relevance: 0,
            evidence: 0,
            developerValue: 0,
            freshness: null,
          },
          totalScore: 0,
          reason: "不适用。",
        },
        {
          candidateId: fresh.id,
          status: "selected",
          identity: null,
          topicId: "missing-topic",
          scores: {
            relevance: 80,
            evidence: 80,
            developerValue: 80,
            freshness: null,
          },
          totalScore: 80,
          reason: "待保存。",
        },
      ],
    },
  };
  assert.throws(
    () => store.saveSocialSelection(brandId, result),
    JobConflictError,
  );
  assert.equal(store.getCandidate(old.id)?.status, "needs_review");
  assert.equal(store.getCandidate(fresh.id)?.status, "new");
});
