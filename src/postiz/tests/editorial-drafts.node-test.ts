import assert from "node:assert/strict";
import test from "node:test";
import { generateContent, type ContentInput } from "../content.js";
import type { ContentModel, ModelRequest } from "../models.js";
import { ContentJobStore } from "../store.js";
import { enqueueContent } from "../runner.js";
import { readConfig } from "../config.js";
import { runWorkbenchTick } from "../workbench-runtime.js";
import type { PostizClient } from "../postiz-client.js";

const input: ContentInput = {
  brand: {
    id: "tokenhot",
    name: "Tokenhot",
    audience: "Developers using model APIs",
    businessContext: "AI API workflows",
    contentRules: [],
    examples: [],
    language: "English",
    verifiedFacts: [],
  },
  sources: [
    {
      url: "https://x.com/wavespeed_ai/status/2107112608964972853",
      text: "Depth Anything V3 captures the motion + camera. Seedance 2.5 rebuilds everything else. New characters. New scenes. Same choreography. On WaveSpeed.",
    },
  ],
  purpose: "brand_original",
  writingScope: "general",
  writingAngle:
    "从 WaveSpeed 的演示讨论运动信息与画面生成分工，保留第三方来源归属，关注行业实践。",
  inspirationRequiresFacts: false,
  revision: {
    kind: "rewrite",
    instructions: "允许出现 WaveSpeed；运营会核对演示并补充正确模型链接。",
  },
};
const post =
  "WaveSpeed's demo pairs Depth Anything V3 with Seedance 2.5. The interesting idea: separate motion from scene generation when exploring video workflows.";
const warnings = [
  "厂商演示尚未独立复现，发布前核对能力表述。",
  "运营可在 Postiz 补充正确的模型页面链接。",
];

function model(review = { approved: true, reasons: [] as string[], warnings }) {
  const calls: ModelRequest[] = [];
  const value: ContentModel = {
    async invoke(request) {
      calls.push(request);
      if (request.task === "relevance")
        return JSON.stringify({
          relevant: true,
          reasoning: "可写成注明来源的行业演示短帖。",
        });
      if (request.task === "report")
        return "<report>WaveSpeed 自述两个模型的分工；仅归因转述，不声称已亲测，发布前由运营核对。</report>";
      if (request.task === "post") return `<post>${post}</post>`;
      return JSON.stringify(review);
    },
  };
  return { value, calls };
}

void test("an attributed competitor demo with editorial warnings reaches Postiz once as a draft", async (t) => {
  const store = new ContentJobStore(":memory:");
  t.after(() => store.close());
  const job = enqueueContent(store, {
    ...input,
    integrationId: "x-account",
    mediaPaths: [],
  });
  const fake = model();
  const sent: unknown[] = [];
  const client = {
    async listIntegrations() {
      return [{ id: "x-account", identifier: "x", disabled: false }];
    },
    async createPost(request: unknown) {
      sent.push(request);
      return { postId: "editorial-draft" };
    },
  } as unknown as PostizClient;
  const config = {
    ...readConfig({}),
    competitorMode: true,
    autoSubmit: true,
    postiz: { ...readConfig({}).postiz, integrationId: "x-account" },
  };
  const tick = () =>
    runWorkbenchTick({
      store,
      config,
      brand: input.brand,
      model: () => fake.value,
      client: () => client,
    });
  await tick();
  assert.equal(store.get(job.id)?.state, "submitted");
  assert.equal(store.get(job.id)?.postizId, "editorial-draft");
  assert.deepEqual(
    (store.get(job.id)?.output as { quality: unknown }).quality,
    { approved: true, reasons: [], warnings },
  );
  assert.equal((sent[0] as { mode: string }).mode, "draft");
  assert.equal((sent[0] as { content: string }).content, post);
  assert.equal(
    store.listGenerationAttempts({ brandId: input.brand.id }).length,
    1,
  );
  assert.deepEqual(
    fake.calls.map((call) => call.task),
    ["relevance", "report", "post", "quality"],
  );
  assert.match(fake.calls[0].user, /WaveSpeed/);
  assert.match(fake.calls[0].user, /editorialInstructions/);
  assert.match(
    fake.calls[0].system,
    /Third-party brand and model names are allowed/,
  );
  assert.match(fake.calls[3].system, /warnings/);
  await tick();
  assert.equal(sent.length, 1, "repeated ticks cannot create a second draft");
});

void test("editorial warnings never override a blocking quality rejection", async () => {
  const fake = model({
    approved: false,
    reasons: ["正文编造了来源未提供的性能数据。"],
    warnings,
  });
  const result = await generateContent(input, { model: fake.value });
  assert.equal(result.quality.approved, false);
  assert.deepEqual(result.quality.reasons, [
    "正文编造了来源未提供的性能数据。",
  ]);
});

void test("general drafts still block own-brand inventions before quality review", async () => {
  const calls: string[] = [];
  const result = await generateContent(
    {
      ...input,
      revision: {
        kind: "edit",
        post: "Tokenhot supports all WaveSpeed models at half the price.",
      },
    },
    {
      model: {
        async invoke(request) {
          calls.push(request.task);
          return JSON.stringify({
            relevant: true,
            reasoning: "测试后续确定性检查。",
          });
        },
      },
    },
  );
  assert.equal(result.quality.approved, false);
  assert.deepEqual(calls, ["relevance"]);
  assert.match(result.quality.reasons.join(";"), /自有产品/);
});
