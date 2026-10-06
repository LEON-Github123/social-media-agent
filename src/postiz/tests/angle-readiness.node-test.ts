import assert from "node:assert/strict";
import test from "node:test";
import { ContentJobStore } from "../store.js";
import { selectSocialCandidates } from "../social-selector.js";
import { Workbench } from "../workbench.js";
import { readConfig } from "../config.js";
import { validateBrand } from "../validation.js";

const now = Date.parse("2026-10-06T01:00:00Z");
const brand = validateBrand({
  id: "tokenhot",
  name: "Tokenhot",
  audience: "developers",
  businessContext: "AI APIs",
});

async function fixture(kind: "creative" | "announcement" = "creative") {
  const store = new ContentJobStore(":memory:", { now: () => now });
  const [candidate] = store.upsertCandidates({
    brandId: brand.id,
    origin: "twitterapi-user",
    sourceId: "competitor",
    inputs: [
      {
        url: "https://x.com/example/status/123",
        text: "Compare input formats before choosing an API.",
        publishedAt: new Date(now - 3_600_000).toISOString(),
      },
    ],
  });
  const social = {
    tweetId: "123",
    authorId: "example",
    authorHandle: "example",
    authorName: "Example",
    postType: "original" as const,
    quotedTweetId: null,
    publishedAt: candidate.input.publishedAt!,
    observedAt: now,
    views: 1000,
    likes: 20,
    replies: 1,
    reposts: 2,
    quotes: 0,
    bookmarks: null,
  };
  store.recordSocialObservation(candidate.id, social);
  store.recordCandidateDocument(candidate.id, candidate.input);
  store.beginSocialEvaluation([candidate.id]);
  const result = await selectSocialCandidates(
    {
      brand,
      candidates: [
        {
          ...candidate.input,
          id: candidate.id,
          primary: false,
          firstSeenAt: now,
          social,
        },
      ],
      history: [],
      now,
    },
    {
      model: {
        invoke: async () =>
          JSON.stringify({
            decisions: [
              {
                candidateId: candidate.id,
                title: "输入格式选择",
                summary: "比较输入格式",
                reason: "有开发者价值",
                angle: "介绍 Tokenhot 支持的输入格式",
                factGaps: ["输入格式依据"],
                relevance: 85,
                reusability: 80,
                kind,
                requiresBrandFacts: true,
                excludedReason: null,
                identity: null,
                identityEvidence: null,
                certainty: "uncertain",
              },
            ],
          }),
      },
    },
  );
  store.saveSocialSelection(brand.id, result);
  const topic = store.getTopic(store.getCandidate(candidate.id)!.topicId!)!;
  const workbench = new Workbench({
    store,
    brand,
    config: {
      ...readConfig({
        CONTENT_MODEL: "fixture",
        CONTENT_MODEL_API_KEY: "fixture",
        POSTIZ_API_KEY: "fixture",
        POSTIZ_INTEGRATION_ID: "test",
      }),
      competitorMode: true,
    },
    model: () => {
      throw new Error("Readiness must not call a model");
    },
    client: () => {
      throw new Error("Readiness must not call Postiz");
    },
  });
  return { store, topic, workbench, candidate };
}

void test("blocked brand angle can be checked and explicitly changed to general insight before approval", async (t) => {
  const { store, topic, workbench } = await fixture();
  t.after(() => store.close());
  assert.equal(store.socialTopicReadiness(brand, topic.id).ready, false);
  const angle = "解释在上传前检查图片输入格式的通用步骤";
  const checked = (await workbench.mutate(`/api/topics/${topic.id}/readiness`, {
    writingAngle: angle,
    writingScope: "general",
  })) as { ready: boolean };
  assert.equal(checked.ready, true);
  assert.equal(store.getTopic(topic.id)?.status, "awaiting_approval");
  assert.equal(store.getTopicIntent(topic.id), null);
  assert.equal(store.listGenerationAttempts({ brandId: brand.id }).length, 0);
  await workbench.mutate(`/api/topics/${topic.id}/review`, {
    decision: "approve",
    reason: "确认通用教程角度",
    writingAngle: angle,
    writingScope: "general",
    purpose: "brand_original",
  });
  assert.equal(store.getTopicIntent(topic.id)?.writingScope, "general");
  assert.equal(store.getTopicIntent(topic.id)?.inspirationRequiresFacts, false);
  assert.equal(store.getTopicIntent(topic.id)?.writingAngle, angle);
  assert.equal(store.getTopic(topic.id)?.status, "ready");
});

void test("general scope cannot smuggle own-brand claims or omit a deliberate angle", async (t) => {
  const { store, topic, workbench } = await fixture();
  t.after(() => store.close());
  for (const angle of [
    "Tokenhot 价格更便宜",
    "我们的 API 支持所有模型",
    "Our API supports every format",
  ]) {
    const checked = (await workbench.mutate(
      `/api/topics/${topic.id}/readiness`,
      { writingAngle: angle, writingScope: "general" },
    )) as { ready: boolean };
    assert.equal(checked.ready, false, angle);
    await assert.rejects(
      workbench.mutate(`/api/topics/${topic.id}/review`, {
        decision: "approve",
        reason: "测试拒绝",
        writingAngle: angle,
        writingScope: "general",
      }),
    );
  }
  await assert.rejects(
    workbench.mutate(`/api/topics/${topic.id}/readiness`, {
      writingScope: "general",
    }),
  );
  await assert.rejects(
    workbench.mutate(`/api/topics/${topic.id}/readiness`, {
      writingScope: "anything",
      writingAngle: "通用教程",
    }),
  );
  assert.equal(store.getTopic(topic.id)?.status, "awaiting_approval");
});

void test("ordinary brand approval still requires matching facts and cannot silently clear the old requirement", async (t) => {
  const { store, topic, workbench } = await fixture();
  t.after(() => store.close());
  await assert.rejects(
    workbench.mutate(`/api/topics/${topic.id}/review`, {
      decision: "approve",
      reason: "仍需要资料",
      writingAngle: "Tokenhot 输入格式说明",
    }),
  );
  assert.equal(store.getTopicIntent(topic.id), null);
  assert.equal(store.listGenerationAttempts({ brandId: brand.id }).length, 0);
});

void test("repair endpoint restores an identity-less candidate without approving or charging a model call", async (t) => {
  const { store, workbench, candidate } = await fixture("announcement");
  t.after(() => store.close());
  assert.equal(store.getCandidate(candidate.id)?.topicId, null);
  const before = store.socialQuotas(brand.id).selection.used;
  const repaired = (await workbench.mutate(
    `/api/social-candidates/${candidate.id}/repair`,
    { kind: "creative", reason: "人工确认只借鉴格式检查表达，不引用发布消息" },
  )) as { failures: unknown[] };
  assert.deepEqual(repaired.failures, []);
  const id = store.getCandidate(candidate.id)!.topicId!;
  assert.equal(store.getTopic(id)?.status, "awaiting_approval");
  assert.equal(store.getTopicIntent(id), null);
  assert.equal(store.socialQuotas(brand.id).selection.used, before);
  assert.equal(store.list({ brandId: brand.id }).length, 0);
  await assert.rejects(
    workbench.mutate(`/api/social-candidates/${candidate.id}/repair`, {
      kind: "anything",
      reason: "拒绝非法类型",
    }),
  );
});
