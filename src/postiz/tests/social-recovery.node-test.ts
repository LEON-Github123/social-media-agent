import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { ContentModel } from "../models.js";
import { selectSocialCandidates } from "../social-selector.js";
import { ContentJobStore, JobConflictError } from "../store.js";
import type { TopicIdentity } from "../operations-types.js";

const now = Date.parse("2026-10-06T06:00:00Z");
const brand = {
  id: "tokenhot",
  name: "Tokenhot",
  audience: "Developers",
  businessContext: "AI API integration",
  contentRules: [],
  examples: [],
  language: "English",
};
const event: TopicIdentity = {
  entity: "Acme",
  product: "Model",
  version: "1.10",
  eventType: "release",
  eventDate: "2026-10-05",
  primaryUrl: null,
};
const evidence = "Acme released Model 1.10 on October 5, 2026.";

function fixture(t: TestContext) {
  let clock = now;
  const store = new ContentJobStore(":memory:", { now: () => clock });
  t.after(() => store.close());
  const add = (id: string) => {
    const candidate = store.upsertCandidates({
      brandId: brand.id,
      origin: "twitterapi-user",
      sourceId: "source",
      inputs: [
        {
          url: `https://x.com/acme/status/${id}`,
          text: evidence,
          publishedAt: "2026-10-05T06:00:00Z",
        },
      ],
    })[0];
    store.recordCandidateDocument(candidate.id, {
      ...candidate.input,
      text: evidence,
    });
    store.recordSocialObservation(candidate.id, {
      tweetId: id,
      authorId: "acme",
      authorHandle: "acme",
      authorName: "Acme",
      postType: "original",
      quotedTweetId: null,
      publishedAt: "2026-10-05T06:00:00Z",
      observedAt: now,
      views: 100,
      likes: 10,
      replies: 1,
      reposts: 1,
      quotes: 0,
      bookmarks: 0,
    });
    return store.getCandidate(candidate.id)!;
  };
  return {
    store,
    add,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

function model(
  identity: TopicIdentity | null = event,
  failReview = false,
): ContentModel {
  return {
    async invoke(request) {
      if (request.task === "selection_review") {
        if (failReview) throw new Error("temporary provider outage");
        return JSON.stringify({
          groups: JSON.parse(request.user).groups.map(
            (group: { topicId: string }) => ({
              topicId: group.topicId,
              confirmed: true,
              reason: "同一版本公告。",
            }),
          ),
        });
      }
      return JSON.stringify({
        decisions: JSON.parse(request.user).candidates.map(
          (item: { candidateId: string }) => ({
            candidateId: item.candidateId,
            title: "模型发布与集成",
            summary: "新模型的接口选择。",
            reason: "为开发者提供集成参考。",
            angle: "解释接口接入取舍。",
            factGaps: [],
            relevance: 85,
            reusability: 80,
            kind: "announcement",
            requiresBrandFacts: false,
            excludedReason: null,
            identity,
            identityEvidence: evidence,
            certainty: "confirmed",
          }),
        ),
      });
    },
  };
}

async function evaluate(
  store: ContentJobStore,
  ids: string[],
  contentModel: ContentModel,
) {
  store.beginSocialEvaluation(ids);
  const result = await selectSocialCandidates(
    {
      brand,
      now,
      history: store.socialHistory(brand.id),
      existingTopics: store.listTopics({ brandId: brand.id }),
      candidates: ids.map((id) => {
        const item = store.getCandidate(id)!;
        return {
          id,
          ...item.document!,
          primary: item.primary,
          firstSeenAt: item.createdAt,
          social: store.latestSocialSnapshot(id)!,
        };
      }),
    },
    { model: contentModel },
  );
  store.saveSocialSelection(brand.id, result);
  return result;
}

void test("identity-less announcement offers explicit creative repair without automatic regrouping", async (t) => {
  const { store, add } = fixture(t);
  const item = add("101");
  await evaluate(store, [item.id], model(null));
  assert.equal(store.getCandidate(item.id)?.topicId, null);
  assert.equal(
    store.socialEvaluationCandidates(brand.id, ["source"]).length,
    0,
  );
  await store.repairSocialCandidate({
    brand,
    candidateId: item.id,
    kind: "creative",
    reason: "人工确认这是创意素材。",
  });
  const topic = store.getTopic(store.getCandidate(item.id)!.topicId!)!;
  assert.equal(topic.status, "awaiting_approval");
  assert.equal(topic.identity.product, "social:101");
  assert.equal(store.listSocialStates(brand.id)[0].attempts, 1);
  assert.equal(store.socialQuotas(brand.id).selection.used, 0);
  assert.ok(
    store
      .listAuditEvents({ brandId: brand.id })
      .some((entry) => entry.eventType === "social.recovery_completed"),
  );
});

void test("group-review provider failure retains assessment and explicit retry actually evaluates the group", async (t) => {
  const { store, add } = fixture(t);
  const ids = [add("102").id, add("103").id];
  await evaluate(store, ids, model(event, true));
  assert.ok(
    store
      .listSocialStates(brand.id)
      .every((state) => state.assessment && state.errorCode),
  );
  assert.deepEqual(store.socialEvaluationCandidates(brand.id, ["source"]), []);
  const oldTopic = store.getCandidate(ids[0])!.topicId!;
  await store.retrySocialEvaluation(
    { brand, candidateId: ids[0], reason: "人工重试归组。" },
    { model: model() },
  );
  assert.ok(
    store
      .listSocialStates(brand.id)
      .every((state) => state.attempts === 2 && !state.errorCode),
  );
  assert.equal(store.socialQuotas(brand.id).selection.used, 2);
  assert.equal(store.listTopics({ brandId: brand.id }).length, 1);
  assert.equal(
    store.getTopic(store.getCandidate(ids[0])!.topicId!)?.status,
    "awaiting_approval",
  );
  assert.ok(
    store
      .listAuditEvents({ brandId: brand.id })
      .some((entry) => JSON.stringify(entry.before).includes(oldTopic)),
  );
});

void test("two exhausted automatic attempts allow only two additional manual attempts and preserve lifetime counts", async (t) => {
  const { store, add } = fixture(t);
  const item = add("104");
  const failing: ContentModel = {
    async invoke() {
      throw new Error("temporary failure");
    },
  };
  await evaluate(store, [item.id], failing);
  store.retrySocialCandidate(brand.id, item.id, "重试第二次自动评估。");
  await evaluate(store, [item.id], failing);
  for (let index = 0; index < 2; index++)
    await store.retrySocialEvaluation(
      { brand, candidateId: item.id, reason: "人工接管异常。" },
      { model: failing },
    );
  assert.equal(store.listSocialStates(brand.id)[0].attempts, 4);
  assert.equal(store.socialQuotas(brand.id).selection.used, 2);
  await assert.rejects(
    store.retrySocialEvaluation(
      { brand, candidateId: item.id, reason: "重复点击。" },
      { model: failing },
    ),
    JobConflictError,
  );
  assert.equal(store.listSocialStates(brand.id)[0].attempts, 4);
});

void test("manual retry is rejected before consuming an attempt when daily model budget is full", async (t) => {
  const { store, add } = fixture(t);
  const item = add("105");
  await evaluate(store, [item.id], model(null));
  for (let index = 0; index < 40; index++)
    store.reserveSocialSelectionCall({
      brandId: brand.id,
      task: "selection",
      candidateIds: [item.id],
    });
  await assert.rejects(
    store.retrySocialEvaluation(
      { brand, candidateId: item.id, reason: "超出预算。" },
      { model: model() },
    ),
    JobConflictError,
  );
  assert.equal(store.listSocialStates(brand.id)[0].attempts, 1);
});

void test("event repair uses source evidence and retains permanent same-event approval protection", async (t) => {
  const { store, add } = fixture(t);
  const first = add("106");
  await evaluate(store, [first.id], model());
  const approved = store.reviewTopic(store.getCandidate(first.id)!.topicId!, {
    brandId: brand.id,
    decision: "approve",
    reason: "人工批准。",
  });
  const second = add("107");
  await evaluate(store, [second.id], model(null));
  await store.repairSocialCandidate({
    brand,
    candidateId: second.id,
    kind: "announcement",
    identity: event,
    identityEvidence: evidence,
    reason: "人工确认同一事件。",
  });
  assert.deepEqual(store.getTopic(approved.id), approved);
  const proposal = store.getTopic(store.getCandidate(second.id)!.topicId!)!;
  assert.equal(proposal.status, "needs_review");
  assert.ok(proposal.conflictingTopicIds.includes(approved.id));
  assert.throws(
    () =>
      store.reviewTopic(proposal.id, {
        brandId: brand.id,
        decision: "approve",
        reason: "不能重复批准。",
      }),
    JobConflictError,
  );
  await assert.rejects(
    store.repairSocialCandidate({
      brand,
      candidateId: first.id,
      kind: "creative",
      reason: "不能覆盖批准。",
    }),
    JobConflictError,
  );
  const job = store.enqueueForTopic(approved.id, {
    id: "protected-recovery-job",
    brandId: brand.id,
    contentFingerprint: "protected-recovery-job",
    mode: "draft",
    input: {
      brand,
      sources: approved.approvedSources!,
      integrationId: "account",
      mediaPaths: [],
    },
  });
  const writing = store.claimGeneration({
    workerId: "writer",
    leaseMs: 60_000,
    jobId: job.id,
  })!;
  const bound = store.getTopic(approved.id)!;
  const third = add("114");
  await evaluate(store, [third.id], model(null));
  await store.repairSocialCandidate({
    brand,
    candidateId: third.id,
    kind: "announcement",
    identity: event,
    identityEvidence: evidence,
    reason: "不能重复已有写作任务。",
  });
  assert.deepEqual(store.getTopic(approved.id), bound);
  assert.deepEqual(store.get(job.id), writing);
  assert.equal(store.list({ brandId: brand.id }).length, 1);
});

void test("manual retry holds the batch and rejects stale completion after another human decision", async (t) => {
  const { store, add } = fixture(t);
  const item = add("108");
  await evaluate(store, [item.id], model(null));
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const waiting: ContentModel = {
    async invoke(request) {
      await gate;
      return model().invoke(request);
    },
  };
  const retry = store.retrySocialEvaluation(
    { brand, candidateId: item.id, reason: "人工重试。" },
    { model: waiting },
  );
  assert.equal(store.listSocialStates(brand.id)[0].held, true);
  assert.deepEqual(store.socialEvaluationCandidates(brand.id, ["source"]), []);
  await assert.rejects(
    store.retrySocialEvaluation(
      { brand, candidateId: item.id, reason: "并发重复。" },
      { model: model() },
    ),
    JobConflictError,
  );
  store.holdSocialCandidate(brand.id, item.id, false, "取消本次恢复锁。");
  resume();
  await assert.rejects(retry, JobConflictError);
  assert.equal(store.getCandidate(item.id)?.topicId, null);
});

void test("expired recovery can be explicitly reclaimed and its late result is discarded", async (t) => {
  const { store, add, advance } = fixture(t);
  const item = add("109");
  await evaluate(store, [item.id], model(null));
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const retry = store.retrySocialEvaluation(
    { brand, candidateId: item.id, reason: "模拟中断。" },
    {
      model: {
        async invoke(request) {
          await gate;
          return model().invoke(request);
        },
      },
    },
  );
  advance(5 * 60_000);
  assert.equal(store.socialRecoveryStatus(brand.id, item.id).inFlight, false);
  assert.deepEqual(store.socialEvaluationCandidates(brand.id, ["source"]), []);
  await store.retrySocialEvaluation(
    { brand, candidateId: item.id, reason: "租约到期，人工接管。" },
    { model: model() },
  );
  const recovered = store.getCandidate(item.id)!;
  resume();
  await assert.rejects(retry, JobConflictError);
  assert.deepEqual(store.getCandidate(item.id), recovered);
  assert.equal(store.socialRecoveryStatus(brand.id, item.id).manualAttempts, 2);
  assert.equal(store.listSocialStates(brand.id)[0].attempts, 3);
});

void test("a human pause survives expiry and cannot be mistaken for an abandoned recovery lock", async (t) => {
  const { store, add, advance } = fixture(t);
  const item = add("110");
  await evaluate(store, [item.id], model(null));
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const retry = store.retrySocialEvaluation(
    { brand, candidateId: item.id, reason: "开始人工重试。" },
    {
      model: {
        async invoke(request) {
          await gate;
          return model().invoke(request);
        },
      },
    },
  );
  store.holdSocialCandidate(brand.id, item.id, true, "人工暂停，稍后处理。");
  advance(5 * 60_000);
  await assert.rejects(
    store.retrySocialEvaluation(
      { brand, candidateId: item.id, reason: "不能覆盖人工暂停。" },
      { model: model() },
    ),
    JobConflictError,
  );
  resume();
  await assert.rejects(retry, JobConflictError);
  assert.equal(store.listSocialStates(brand.id)[0].held, true);
  store.holdSocialCandidate(brand.id, item.id, false, "人工解除暂停。");
  await store.retrySocialEvaluation(
    { brand, candidateId: item.id, reason: "人工重新接管。" },
    { model: model() },
  );
  assert.equal(store.listSocialStates(brand.id)[0].held, false);
});

void test("the last daily model slot never permits an unbudgeted group review", async (t) => {
  const { store, add } = fixture(t);
  const ids = [add("111").id, add("112").id];
  await evaluate(store, ids, model(event, true));
  const oldTopic = store.getTopic(store.getCandidate(ids[0])!.topicId!)!;
  for (let index = 0; index < 39; index++)
    store.reserveSocialSelectionCall({
      brandId: brand.id,
      task: "selection",
      candidateIds: ids,
    });
  let calls = 0;
  const result = await store.retrySocialEvaluation(
    { brand, candidateId: ids[0], reason: "剩一次预算。" },
    {
      model: {
        async invoke(request) {
          calls++;
          return model().invoke(request);
        },
      },
    },
  );
  assert.equal(calls, 1);
  assert.equal(store.socialQuotas(brand.id).selection.used, 40);
  assert.equal(result.failures.length, 2);
  assert.deepEqual(store.getTopic(oldTopic.id), oldTopic);
  assert.ok(
    store
      .listSocialStates(brand.id)
      .every((state) => state.assessment && state.attempts === 2),
  );
});

void test("manual repair cannot manufacture an assessment after a pure model failure", async (t) => {
  const { store, add } = fixture(t);
  const item = add("113");
  await evaluate(store, [item.id], {
    async invoke() {
      throw new Error("failure");
    },
  });
  await assert.rejects(
    store.repairSocialCandidate({
      brand,
      candidateId: item.id,
      kind: "creative",
      reason: "缺少评估不能批准。",
    }),
    JobConflictError,
  );
  assert.equal(store.getCandidate(item.id)?.topicId, null);
  assert.equal(store.listSocialStates(brand.id)[0].attempts, 1);
});

void test("an approval during recovery remains authoritative over the late model result", async (t) => {
  const { store, add } = fixture(t);
  const ids = [add("115").id, add("116").id];
  await evaluate(store, ids, model(event, true));
  const topicId = store.getCandidate(ids[0])!.topicId!;
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const retry = store.retrySocialEvaluation(
    { brand, candidateId: ids[0], reason: "等待重试。" },
    {
      model: {
        async invoke(request) {
          await gate;
          return model().invoke(request);
        },
      },
    },
  );
  const approved = store.reviewTopic(topicId, {
    brandId: brand.id,
    decision: "approve",
    reason: "人工决定批准旧提案。",
  });
  resume();
  await assert.rejects(retry, JobConflictError);
  assert.deepEqual(store.getTopic(topicId), approved);
});

void test("recovering against a full eight-source history still creates a bounded conflict proposal", async (t) => {
  const { store, add } = fixture(t);
  const old = Array.from({ length: 8 }, (_, index) => add(String(200 + index)));
  store.saveSelection({
    brandId: brand.id,
    result: {
      modelCalls: 0,
      warnings: [],
      candidateDecisions: old.map((item) => ({
        candidateId: item.id,
        status: "selected",
        reason: "旧事件证据。",
        identity: event,
        topicId: "full-history",
        totalScore: 100,
        scores: {
          relevance: 100,
          evidence: 100,
          developerValue: 100,
          freshness: 100,
        },
      })),
      topics: [
        {
          id: "full-history",
          identityKey: "full-history",
          identity: event,
          title: "旧事件",
          status: "ready",
          reason: "旧事件证据。",
          candidateIds: old.map((item) => item.id),
          sourceCandidateIds: old.map((item) => item.id),
          sourceMetadata: old.map((item) => ({
            candidateId: item.id,
            url: item.input.url,
            primary: true,
            totalScore: 100,
          })),
        },
      ],
    },
  });
  const approved = store.reviewTopic("full-history", {
    brandId: brand.id,
    decision: "approve",
    reason: "已确认旧事件。",
  });
  const item = add("208");
  await evaluate(store, [item.id], model(null));
  await store.repairSocialCandidate({
    brand,
    candidateId: item.id,
    kind: "announcement",
    identity: event,
    identityEvidence: evidence,
    reason: "人工确认补充来源。",
  });
  const proposal = store.getTopic(store.getCandidate(item.id)!.topicId!)!;
  assert.equal(proposal.status, "needs_review");
  assert.deepEqual(proposal.sourceCandidateIds, [item.id]);
  assert.deepEqual(store.getTopic("full-history"), approved);
});
