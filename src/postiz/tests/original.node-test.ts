import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  generateContent,
  validatePost,
  type ContentInput,
} from "../content.js";
import type { ContentModel, ModelRequest } from "../models.js";
import type { PostizClient } from "../postiz-client.js";
import { enqueueContent, submitNext } from "../runner.js";
import { ContentJobStore } from "../store.js";
import { readConfig } from "../config.js";
import { runWorkbenchTick } from "../workbench-runtime.js";
import { validateContentInput, validateJobInput } from "../validation.js";

const sourceUrl = "https://competitor.example/blog/old-release";
const factUrl = "https://example.com/docs/images";
const brand = {
  id: "example",
  name: "Example API",
  audience: "Image developers",
  businessContext: "Image integration guidance",
  contentRules: [],
  examples: [],
  language: "English",
  verifiedFacts: [
    {
      claim: "Example API accepts PNG and JPEG inputs.",
      url: factUrl,
      evidence: "Supported image input formats: PNG and JPEG.",
    },
  ],
};
const input: ContentInput = {
  brand,
  sources: [
    {
      url: sourceUrl,
      title: "Competitor launch announcement",
      publishedAt: "2025-01-01T00:00:00Z",
      text: "The competitor announced a new image upload workflow and a marketing checklist.",
    },
  ],
  purpose: "brand_original",
  writingAngle: "Explain the benefit of checking image formats before upload",
  inspirationRequiresFacts: true,
};

function fakeModel(outputs: string[]) {
  const calls: ModelRequest[] = [];
  const model: ContentModel = {
    async invoke(request) {
      calls.push(request);
      const output = outputs[calls.length - 1];
      if (output === undefined) throw new Error("Unexpected model request");
      return output;
    },
  };
  return { model, calls };
}

void test("original mode uses an evergreen competitor idea without citing it or changing English publication", async () => {
  const post =
    "Example API accepts PNG and JPEG inputs. Check the format before uploading an image.";
  const { model, calls } = fakeModel([
    '{"relevant":true,"reasoning":"可借鉴图片上传前检查格式的角度。"}',
    `<report>品牌事实支持 PNG 和 JPEG 输入：${factUrl}</report>`,
    `<post>${post}</post>`,
    '{"approved":true,"reasons":[]}',
  ]);
  const result = await generateContent(input, {
    model,
    now: Date.UTC(2026, 8, 30),
  });
  assert.equal(result.quality.approved, true);
  assert.equal(result.post, post);
  assert.deepEqual(
    calls.map((call) => call.task),
    ["relevance", "report", "post", "quality"],
  );
  for (const call of calls) {
    assert.match(call.system, /Purpose: brand_original/);
    assert.match(call.system, /checking image formats before upload/);
    assert.match(call.system, /competitor inspiration/);
  }
  assert.match(calls[0].system, /evergreen marketing or educational idea/);
  assert.match(calls[1].system, /verifiedFacts claim and its URL/);
  assert.match(calls[2].system, /public URL is optional/);
  assert.doesNotMatch(
    calls[2].system,
    /Include exactly one supplied source URL at the end/,
  );
  assert.match(calls[2].system, /public post in English/);
  assert.match(
    calls[3].system,
    /competitor capabilities recast as this brand's own/,
  );
});

void test("legacy commentary still needs a source link; original URLs remain allowlisted", () => {
  const noLink = "Example API accepts PNG and JPEG inputs.";
  assert.deepEqual(validatePost(noLink, input), []);
  assert.ok(
    validatePost(noLink, { ...input, purpose: undefined }).some((reason) =>
      reason.includes("来源链接"),
    ),
  );
  assert.ok(
    validatePost(`${noLink} https://untrusted.com/promo`, input).some(
      (reason) => reason.includes("不在所提供证据中的 URL"),
    ),
  );
  assert.ok(
    validatePost(`${noLink} https://untrusted.example/promo`, input).some(
      (reason) => reason.includes("不在所提供证据中的 URL"),
    ),
  );
  assert.deepEqual(validatePost(`${noLink} ${factUrl}`, input), []);
});

void test("original mode rejects unsupported own-brand capability and copied competitor wording", () => {
  const withoutFacts: ContentInput = {
    ...input,
    brand: { ...brand, verifiedFacts: [] },
  };
  assert.ok(
    validatePost("Example API supports every image model.", withoutFacts).some(
      (reason) => reason.includes("品牌事实库中已核实的证据"),
    ),
  );
  const copied =
    "Build a faster creative workflow by choosing the right image format before every upload and checking each file carefully.";
  const competitorInput: ContentInput = {
    ...input,
    sources: [{ ...input.sources[0], text: copied }],
  };
  assert.ok(
    validatePost(copied, competitorInput).some((reason) =>
      reason.includes("连续 12 个英文词"),
    ),
  );
  assert.deepEqual(
    validatePost("Check PNG and JPEG inputs.", competitorInput),
    [],
  );
  const beforeUrl = "Plan every image upload with checks for";
  const afterUrl = "the selected file format before sending requests";
  assert.deepEqual(
    validatePost(`${beforeUrl} ${afterUrl}`, {
      ...input,
      sources: [
        {
          ...input.sources[0],
          text: `${beforeUrl} https://competitor.example/guide ${afterUrl}`,
        },
      ],
    }),
    [],
  );
});

void test("brand fact wording is exempt from competitor-copy detection, and missing required facts stop before model use", async () => {
  const claim =
    "Example API accepts PNG and JPEG images before upload and validates their file type for every request.";
  const withFact: ContentInput = {
    ...input,
    brand: { ...brand, verifiedFacts: [{ claim, url: factUrl }] },
    sources: [{ ...input.sources[0], text: claim }],
  };
  assert.deepEqual(validatePost(claim, withFact), []);
  const { model, calls } = fakeModel([]);
  const result = await generateContent(
    { ...input, brand: { ...brand, verifiedFacts: [] } },
    { model },
  );
  assert.equal(result.relevant, false);
  assert.match(result.reasoning, /需要已核实的品牌事实/);
  assert.equal(calls.length, 0);
});

void test("purpose metadata is bounded and survives content/job validation", () => {
  const parsed = validateContentInput(input);
  assert.equal(parsed.purpose, "brand_original");
  assert.equal(parsed.writingAngle, input.writingAngle);
  assert.equal(parsed.inspirationRequiresFacts, true);
  const job = validateJobInput({
    ...input,
    integrationId: "x-account",
    mediaPaths: [],
  });
  assert.equal(job.purpose, "brand_original");
  assert.equal(job.writingAngle, input.writingAngle);
  assert.throws(() =>
    validateContentInput({ ...input, writingAngle: "x".repeat(2_001) }),
  );
  assert.throws(() => validateJobInput({ ...job, purpose: "unknown" }));
});

void test("submission rechecks a link-free original with its persisted purpose", async (t: TestContext) => {
  const directory = mkdtempSync(join(tmpdir(), "postiz-original-"));
  const store = new ContentJobStore(join(directory, "jobs.sqlite"));
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const job = enqueueContent(store, {
    ...input,
    integrationId: "x-account",
    mediaPaths: [],
  });
  const claim = store.claimGeneration({
    workerId: "writer",
    leaseMs: 30_000,
    jobId: job.id,
  });
  assert.ok(claim);
  const post =
    "Example API accepts PNG and JPEG inputs. Check formats before upload.";
  store.completeGeneration(job.id, claim.leaseToken, {
    relevant: true,
    reasoning: "来源可启发原创角度",
    report: "已核实格式事实",
    post,
    quality: { approved: true, reasons: [] },
    sources: input.sources,
  });
  let creates = 0;
  const client = {
    async listIntegrations() {
      return [{ id: "x-account", identifier: "x", disabled: false }];
    },
    async createPost() {
      creates++;
      return { postId: "draft-1" };
    },
  } as unknown as PostizClient;
  const result = await submitNext({
    store,
    client,
    brandId: brand.id,
    leaseMs: 30_000,
    jobId: job.id,
  });
  assert.equal(result?.state, "submitted");
  assert.equal(creates, 1);
});

void test("draft revision keeps original purpose, angle and fact requirement", (t: TestContext) => {
  const store = new ContentJobStore(":memory:");
  t.after(() => store.close());
  const job = enqueueContent(store, {
    ...input,
    integrationId: "x-account",
    mediaPaths: [],
  });
  const claim = store.claimGeneration({
    workerId: "writer",
    leaseMs: 30_000,
    jobId: job.id,
  });
  assert.ok(claim);
  store.completeGeneration(job.id, claim.leaseToken, {
    relevant: true,
    reasoning: "已核实",
    report: "品牌事实",
    post: "Example API accepts PNG and JPEG inputs.",
    quality: { approved: true, reasons: [] },
    sources: input.sources,
  });
  const revised = store.reviseJob(job.id, {
    revision: {
      kind: "edit",
      post: "Example API accepts PNG and JPEG inputs. Check formats first.",
    },
    reason: "Improve the wording",
  });
  const saved = validateJobInput(revised.input);
  assert.equal(saved.purpose, "brand_original");
  assert.equal(saved.writingAngle, input.writingAngle);
  assert.equal(saved.inspirationRequiresFacts, true);
});

void test("expired or missing brand evidence stops original writing before quota reservation", async (t: TestContext) => {
  let clock = Date.UTC(2026, 8, 30);
  const store = new ContentJobStore(":memory:", { now: () => clock });
  t.after(() => store.close());
  const original = {
    ...input,
    brand: { ...brand, verifiedFacts: [] },
    integrationId: "x-account",
    mediaPaths: [],
  };
  const job = enqueueContent(store, original);
  let modelCalls = 0;
  const config = {
    ...readConfig({}),
    competitorMode: true,
    autoSubmit: false,
    postiz: { ...readConfig({}).postiz, integrationId: "x-account" },
  };
  const tick = () =>
    runWorkbenchTick({
      store,
      config,
      brand: original.brand,
      model: () => ({
        async invoke() {
          modelCalls++;
          throw new Error("No model call expected");
        },
      }),
      client: () => {
        throw new Error("No Postiz call expected");
      },
    });
  await tick();
  assert.equal(store.get(job.id)?.state, "queued");
  assert.equal(store.listGenerationAttempts({ brandId: brand.id }).length, 0);
  const fact = store.createBrandFact(brand.id, {
    claim: "Example API accepts PNG and JPEG inputs.",
    url: factUrl,
    evidence: "The docs list PNG and JPEG.",
    keywords: ["format"],
    category: "feature",
    observedAt: clock,
    expiresAt: clock + 86_400_000,
  });
  store.updateBrandFact(brand.id, fact.id, {
    status: "verified",
    reason: "Reviewed docs",
  });
  clock += 86_400_001;
  await tick();
  assert.equal(store.get(job.id)?.state, "queued");
  assert.equal(store.listGenerationAttempts({ brandId: brand.id }).length, 0);
  assert.equal(modelCalls, 0);
});

void test("writing angle can match a current fact while the competitor text stays unchanged", async (t: TestContext) => {
  const clock = Date.UTC(2026, 8, 30);
  const store = new ContentJobStore(":memory:", { now: () => clock });
  t.after(() => store.close());
  const fact = store.createBrandFact(brand.id, {
    claim: "Example API accepts PNG and JPEG inputs.",
    url: factUrl,
    evidence: "The docs list PNG and JPEG.",
    keywords: ["format"],
    category: "feature",
    observedAt: clock,
    expiresAt: clock + 86_400_000,
  });
  store.updateBrandFact(brand.id, fact.id, {
    status: "verified",
    reason: "Reviewed docs",
  });
  const original = {
    ...input,
    brand: { ...brand, verifiedFacts: [] },
    writingAngle: "Explain format validation for Example API",
    integrationId: "x-account",
    mediaPaths: [],
  };
  const job = enqueueContent(store, original);
  const fake = fakeModel([
    '{"relevant":true,"reasoning":"已核实格式事实支持该角度。"}',
    `<report>格式事实见 ${factUrl}</report>`,
    "<post>Example API accepts PNG and JPEG inputs. Check formats before upload.</post>",
    '{"approved":true,"reasons":[]}',
  ]);
  const config = {
    ...readConfig({}),
    competitorMode: true,
    autoSubmit: false,
    postiz: { ...readConfig({}).postiz, integrationId: "x-account" },
  };
  await runWorkbenchTick({
    store,
    config,
    brand: original.brand,
    model: () => fake.model,
    client: () => {
      throw new Error("No Postiz call expected");
    },
  });
  const saved = store.get(job.id)!;
  assert.equal(saved.state, "ready");
  assert.equal(
    (saved.input as { brand: typeof brand }).brand.verifiedFacts?.[0]
      ?.knowledgeId,
    fact.id,
  );
  assert.equal(
    (saved.input as { sources: ContentInput["sources"] }).sources[0].text,
    input.sources[0].text,
  );
  assert.deepEqual(
    fake.calls.map((call) => call.task),
    ["relevance", "report", "post", "quality"],
  );
});
