import assert from "node:assert/strict";
import test from "node:test";
import { ContentJobStore } from "../store.js";
import {
  collectCompetitorSources,
  selectSocialAndQueue,
} from "../social-pipeline.js";
import { validateBrand } from "../validation.js";
import type { SourceConfig, SourceOptions } from "../sources.js";

const brand = validateBrand({
  id: "tokenhot",
  name: "Tokenhot",
  audience: "Developers",
  businessContext: "AI model API",
  language: "English",
  contentRules: [],
  examples: [],
  verifiedFacts: [],
  maxPostLength: 280,
});
const handles = [
  "ooffooxx",
  "CheaperInfer",
  "wavespeed_ai",
  "OpenRouter",
  "fal",
];
const sources: SourceConfig[] = [
  ...handles.map((userName) => ({
    id: `twitterapi-${userName}`,
    type: "twitterapi-user" as const,
    userName,
  })),
  { id: "old-rss", type: "rss", url: "https://example.com/feed" },
];
const lookup: SourceOptions["lookup"] = async () => [
  { address: "8.8.8.8", family: 4 },
];
const base = Date.parse("2026-09-30T03:00:00Z");
function page(handle: string, index: number) {
  return {
    tweets: [
      {
        id: String(index + 100),
        text: "A useful developer API demo: choose the workflow before choosing a model.",
        createdAt: "2026-09-29T03:00:00Z",
        author: { userName: handle },
        viewCount: 1000,
        likeCount: 12,
        replyCount: 2,
        retweetCount: 3,
        quoteCount: 1,
      },
    ],
    has_next_page: false,
  };
}

void test("09:00 collection isolates failures, excludes RSS, counts failed calls and resumes without duplicate reads", async (t) => {
  let now = base - 3 * 3_600_000;
  const store = new ContentJobStore(":memory:", { now: () => now });
  t.after(() => store.close());
  const requests: string[] = [];
  const sourceOptions: SourceOptions = {
    lookup,
    twitterApiIoApiKey: "test-only",
    fetch: (async (url) => {
      const parsed = new URL(String(url));
      const handle = parsed.searchParams.get("userName")!;
      requests.push(handle);
      if (handle === "CheaperInfer") return new Response("{}", { status: 429 });
      return new Response(
        JSON.stringify(page(handle, handles.indexOf(handle))),
      );
    }) as typeof fetch,
  };
  const options = {
    store,
    brandId: brand.id,
    sources,
    sourceOptions,
    workerId: "test",
    now: () => now,
  };
  assert.equal((await collectCompetitorSources(options)).checked, 0);
  assert.equal(requests.length, 0);
  now = base;
  const collected = await collectCompetitorSources(options);
  assert.equal(collected.checked, 5);
  assert.equal(collected.failed, 1);
  assert.equal(store.socialQuotas(brand.id).provider.used, 5);
  assert.equal(store.listCandidates({ brandId: brand.id }).length, 4);
  assert.equal(store.socialHistory(brand.id).length, 4);
  await collectCompetitorSources({ ...options, workerId: "restarted" });
  assert.equal(requests.length, 5);
  now += 86_400_000;
  await collectCompetitorSources(options);
  assert.equal(requests.length, 10);
  assert.equal(store.listCandidates({ brandId: brand.id }).length, 4);
  assert.equal(store.socialHistory(brand.id).length, 8);
});

void test("metrics refresh is bounded and never repeats successfully observed or failed IDs that day", async (t) => {
  const store = new ContentJobStore(":memory:", { now: () => base });
  t.after(() => store.close());
  const inputs = Array.from({ length: 105 }, (_, index) => ({
    url: `https://x.com/fal/status/${index + 1000}`,
    text: "Useful demo",
    publishedAt: "2026-09-29T03:00:00Z",
  }));
  store.upsertCandidates({
    brandId: brand.id,
    origin: "twitterapi-user",
    sourceId: "twitterapi-fal",
    inputs,
  });
  const batches: string[][] = [];
  const sourceOptions: SourceOptions = {
    lookup,
    twitterApiIoApiKey: "test",
    fetch: (async (url) => {
      const parsed = new URL(String(url));
      if (parsed.pathname.includes("last_tweets"))
        return new Response('{"tweets":[],"has_next_page":false}');
      const ids = parsed.searchParams.get("tweet_ids")!.split(",");
      batches.push(ids);
      return new Response("{}", { status: 503 });
    }) as typeof fetch,
  };
  const options = {
    store,
    brandId: brand.id,
    sources,
    sourceOptions,
    workerId: "test",
    now: base,
  };
  await collectCompetitorSources(options);
  assert.equal(batches.length, 5);
  assert.equal(new Set(batches.flat()).size, 100);
  assert.ok(batches.every((batch) => batch.length <= 20));
  assert.equal(store.socialQuotas(brand.id).provider.used, 10);
  await collectCompetitorSources(options);
  assert.equal(batches.length, 5);
});

void test("social inspiration needs human approval and missing brand facts block before writing quota", async (t) => {
  const store = new ContentJobStore(":memory:", { now: () => base });
  t.after(() => store.close());
  await collectCompetitorSources({
    store,
    brandId: brand.id,
    sources: [sources[4]],
    workerId: "test",
    now: base,
    sourceOptions: {
      lookup,
      twitterApiIoApiKey: "test",
      fetch: (async () =>
        new Response(JSON.stringify(page("fal", 4)))) as typeof fetch,
    },
  });
  let calls = 0;
  const options = {
    store,
    brand,
    integrationId: "x-test",
    now: base,
    model: {
      invoke: async () => {
        calls++;
        const candidate = store.listCandidates({ brandId: brand.id })[0];
        return JSON.stringify({
          decisions: [
            {
              candidateId: candidate.id,
              title: "从使用流程出发选择 API",
              summary: "展示具体开发场景。",
              reason: "可借鉴先展示问题再给解决方法的表达。",
              angle: "解释开发者选择 API 的取舍",
              factGaps: [],
              relevance: 90,
              reusability: 85,
              kind: "creative",
              requiresBrandFacts: false,
              excludedReason: null,
              identity: null,
              identityEvidence: null,
              certainty: "confirmed",
            },
          ],
        });
      },
    },
  };
  await selectSocialAndQueue(options);
  assert.equal(calls, 1);
  assert.equal(store.list({ brandId: brand.id }).length, 0);
  const topic = store.listTopics({ brandId: brand.id })[0];
  assert.equal(topic.status, "awaiting_approval");
  assert.equal(store.listSocialStates(brand.id)[0].tier, "watch");
  assert.throws(
    () =>
      store.reviewSocialTopic(topic.id, {
        brand,
        decision: "approve",
        reason: "测试资料拦截",
        writingAngle: "Tokenhot 比竞争对手便宜 50%",
      }),
    /待补充品牌资料/,
  );
  assert.equal(store.getGenerationQuota({ brandId: brand.id }).used, 0);
  const unrelatedBrand = validateBrand({
    ...brand,
    verifiedFacts: [
      {
        claim: "Tokenhot has an official website.",
        url: "https://tokenhot.ai",
        evidence: "Official website address.",
      },
    ],
  });
  assert.throws(
    () =>
      store.reviewSocialTopic(topic.id, {
        brand: unrelatedBrand,
        decision: "approve",
        reason: "无关资料不能放行",
        writingAngle: "Tokenhot 提供视频生成",
      }),
    /待补充品牌资料/,
  );
  assert.equal(store.getGenerationQuota({ brandId: brand.id }).used, 0);
  store.reviewSocialTopic(topic.id, {
    brand,
    decision: "approve",
    reason: "人工确认写开发者通用经验",
  });
  await selectSocialAndQueue(options);
  const job = store.list({ brandId: brand.id })[0];
  assert.equal(job.mode, "draft");
  assert.equal((job.input as { purpose: string }).purpose, "brand_original");
  assert.equal(store.getGenerationQuota({ brandId: brand.id }).used, 0);
  await selectSocialAndQueue(options);
  assert.equal(store.list({ brandId: brand.id }).length, 1);
  const [extra] = store.upsertCandidates({
    brandId: brand.id,
    origin: "twitterapi-user",
    sourceId: "twitterapi-fal",
    inputs: [
      {
        url: "https://x.com/fal/status/999",
        text: "Additional commentary on the same demo",
        publishedAt: "2026-09-29T03:00:00Z",
      },
    ],
  });
  store.recordCandidateDocument(extra.id, {
    ...extra.input,
    text: extra.input.text!,
  });
  store.saveSelection({
    brandId: brand.id,
    result: {
      modelCalls: 1,
      warnings: [],
      candidateDecisions: [
        {
          candidateId: extra.id,
          status: "needs_review",
          scores: {
            relevance: 80,
            evidence: 80,
            freshness: 80,
            developerValue: 80,
          },
          totalScore: 80,
          reason: "可能同题，需要人工归组",
          identity: topic.identity,
          topicId: "merge-proposal",
        },
      ],
      topics: [
        {
          id: "merge-proposal",
          identityKey: "merge-proposal",
          title: "待归组",
          identity: topic.identity,
          candidateIds: [extra.id],
          sourceCandidateIds: [extra.id],
          sourceMetadata: [
            { candidateId: extra.id, url: extra.input.url, primary: false },
          ],
          status: "needs_review",
          reason: "核对同题",
          conflictingTopicIds: [topic.id],
        },
      ],
    },
  });
  const originalIntent = store.getTopicIntent(topic.id);
  const originalJob = store.get(job.id);
  store.reviewSocialTopic("merge-proposal", {
    brand,
    decision: "approve",
    reason: "人工确认同一题",
    mergeWith: topic.id,
    writingAngle: "不能覆盖原写作角度",
  });
  assert.deepEqual(store.getTopicIntent(topic.id), originalIntent);
  assert.deepEqual(store.get(job.id), originalJob);
});
