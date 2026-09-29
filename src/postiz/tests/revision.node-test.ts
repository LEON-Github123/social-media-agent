import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { generateContent, type ContentResult } from "../content.js";
import type { ContentModel, ModelRequest } from "../models.js";
import { enqueueContent, submitNext, type JobInput } from "../runner.js";
import { ContentJobStore, JobConflictError } from "../store.js";
import type { PostizClient } from "../postiz-client.js";

const start = Date.UTC(2026, 8, 29);
const url = "https://example.com/docs/images";
const brand = {
  id: "example",
  name: "Example API",
  audience: "Image developers",
  businessContext: "Image API docs",
  contentRules: [],
  examples: [],
  language: "English",
};
const sources = [
  {
    url,
    text: "The image endpoint accepts PNG and JPEG inputs.",
    title: "Image inputs",
  },
];
const post = `Check whether your image is PNG or JPEG before sending it. ${url}`;
const input: JobInput = {
  brand,
  sources,
  integrationId: "x-account",
  mediaPaths: [],
};
const output: ContentResult = {
  relevant: true,
  reasoning: "Useful developer guidance",
  report: "Image formats",
  post,
  sources,
  quality: { approved: true, reasons: [] },
};

function model(outputs: Partial<Record<ModelRequest["task"], string>>) {
  const calls: ModelRequest[] = [];
  const value: ContentModel = {
    async invoke(request) {
      calls.push(request);
      const result = outputs[request.task];
      if (result === undefined)
        throw new Error(`Unexpected ${request.task} call`);
      return result;
    },
  };
  return { calls, value };
}

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "postiz-revision-"));
  let now = start;
  const store = new ContentJobStore(join(directory, "jobs.sqlite"), {
    now: () => now,
  });
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const job = enqueueContent(store, input);
  const claim = store.claimGeneration({
    workerId: "writer",
    leaseMs: 30_000,
    jobId: job.id,
  });
  assert.ok(claim);
  store.completeGeneration(job.id, claim.leaseToken, output);
  return {
    store,
    job,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

void test("rewrite instructions enter both writing prompts and are bounded as editorial direction", async () => {
  const fake = model({
    relevance: '{"relevant":true,"reasoning":"Useful"}',
    report: `<report>PNG and JPEG are accepted. ${url}</report>`,
    post: `<post>${post}</post>`,
    quality: '{"approved":true,"reasons":[]}',
  });
  const result = await generateContent(
    {
      brand,
      sources,
      revision: {
        kind: "rewrite",
        instructions: "Lead with file format validation",
      },
    },
    { model: fake.value, now: start },
  );
  assert.equal(result.quality.approved, true);
  for (const task of ["report", "post"] as const) {
    const request = fake.calls.find((call) => call.task === task)!;
    assert.match(request.user, /Lead with file format validation/);
    assert.match(request.user, /not evidence/);
  }
});

void test("edit preserves exact submitted text and still checks relevance, sources and quality", async () => {
  const fake = model({
    relevance: '{"relevant":true,"reasoning":"Useful"}',
    quality: '{"approved":true,"reasons":[]}',
  });
  const edited = `First validate the input format; PNG and JPEG are accepted. ${url}`;
  const result = await generateContent(
    { brand, sources, revision: { kind: "edit", post: edited } },
    { model: fake.value, now: start },
  );
  assert.equal(result.post, edited);
  assert.deepEqual(
    fake.calls.map((call) => call.task),
    ["relevance", "quality"],
  );
  const withoutSource = await generateContent(
    {
      brand,
      sources,
      revision: { kind: "edit", post: "PNG and JPEG are accepted." },
    },
    {
      model: model({ relevance: '{"relevant":true,"reasoning":"Useful"}' })
        .value,
      now: start,
    },
  );
  assert.equal(withoutSource.quality.approved, false);
  assert.match(withoutSource.quality.reasons.join(";"), /supplied source/);
  const claim = await generateContent(
    {
      brand,
      sources,
      revision: {
        kind: "edit",
        post: `Example API supports every image model. ${url}`,
      },
    },
    {
      model: model({ relevance: '{"relevant":true,"reasoning":"Useful"}' })
        .value,
      now: start,
    },
  );
  assert.equal(claim.quality.approved, false);
  assert.match(claim.quality.reasons.join(";"), /verifiedFacts/);
});

void test("revision preserves identity, freezes original evidence, audits prior draft and consumes generation quota", (t) => {
  const { store, job } = fixture(t);
  const revised = store.reviseJob(job.id, {
    revision: { kind: "edit", post },
    reason: "Tighten wording",
  });
  assert.equal(revised.id, job.id);
  assert.equal(revised.contentFingerprint, job.contentFingerprint);
  assert.equal(revised.state, "queued");
  assert.equal(revised.output, null);
  assert.deepEqual((revised.input as JobInput).sources, output.sources);
  const audit = store
    .listAuditEvents({ jobId: job.id })
    .find((event) => event.eventType === "job.revised")!;
  assert.equal(
    (audit.before as typeof job).output &&
      ((audit.before as typeof job).output as ContentResult).post,
    post,
  );
  assert.equal(audit.reason, "Tighten wording");
  const quota = { limit: 3, timeZone: "UTC" };
  for (let n = 0; n < 2; n++) {
    const claim = store.claimGeneration({
      workerId: "writer",
      leaseMs: 30_000,
      jobId: job.id,
      quota,
    });
    assert.ok(claim);
    store.completeGeneration(job.id, claim.leaseToken, output);
    if (n < 1)
      store.reviseJob(job.id, {
        revision: { kind: "edit", post },
        reason: "Try again",
      });
  }
  store.reviseJob(job.id, {
    revision: { kind: "edit", post },
    reason: "Fourth attempt",
  });
  assert.equal(
    store.claimGeneration({
      workerId: "writer",
      leaseMs: 30_000,
      jobId: job.id,
      quota,
    }),
    null,
  );
});

void test("active, unknown and receipted jobs cannot be revised", (t) => {
  const { store, job } = fixture(t);
  const action = { revision: { kind: "edit" as const, post }, reason: "Edit" };
  const submit = store.claimSubmit({
    workerId: "sender",
    leaseMs: 30_000,
    jobId: job.id,
  });
  assert.ok(submit);
  assert.throws(() => store.reviseJob(job.id, action), JobConflictError);
  store.markUnknown(job.id, submit.leaseToken, "Network outcome unknown");
  assert.throws(() => store.reviseJob(job.id, action), JobConflictError);
});

void test("generation snapshot rejects changed source or integration identity", (t) => {
  const { store, job } = fixture(t);
  store.reviseJob(job.id, {
    revision: { kind: "rewrite", instructions: "Focus on input formats" },
    reason: "New angle",
  });
  const claim = store.claimGeneration({
    workerId: "writer",
    leaseMs: 30_000,
    jobId: job.id,
  });
  assert.ok(claim);
  const original = claim.input as JobInput;
  assert.throws(
    () =>
      store.snapshotGenerationInput(job.id, claim.leaseToken, {
        ...original,
        integrationId: "other-account",
      }),
    JobConflictError,
  );
  assert.throws(
    () =>
      store.snapshotGenerationInput(job.id, claim.leaseToken, {
        ...original,
        sources: [{ ...sources[0], url: "https://example.com/other" }],
      }),
    JobConflictError,
  );
  assert.equal(
    (store.get(job.id)!.input as JobInput).integrationId,
    "x-account",
  );
});

void test("submission refuses a generated draft whose source URL changed", async (t) => {
  const { store, job } = fixture(t);
  store.reviseJob(job.id, {
    revision: { kind: "rewrite", instructions: "Clarify formats" },
    reason: "Update",
  });
  const claim = store.claimGeneration({
    workerId: "writer",
    leaseMs: 30_000,
    jobId: job.id,
  });
  assert.ok(claim);
  const substituted = "https://example.com/unrelated";
  store.completeGeneration(job.id, claim.leaseToken, {
    ...output,
    sources: [{ ...sources[0], url: substituted }],
    post: `Check the PNG format. ${substituted}`,
  });
  let apiCalls = 0;
  const client = {
    async listIntegrations() {
      apiCalls++;
      return [];
    },
    async createPost() {
      apiCalls++;
      throw new Error("must not call");
    },
  } as unknown as PostizClient;
  assert.equal(
    (
      await submitNext({
        store,
        client,
        brandId: brand.id,
        leaseMs: 30_000,
        jobId: job.id,
      })
    )?.state,
    "failed",
  );
  assert.equal(apiCalls, 0);
});

void test("snapshotted source text cannot be swapped on edit or submission", async (t) => {
  const { store, job } = fixture(t);
  store.reviseJob(job.id, {
    revision: { kind: "rewrite", instructions: "Clarify formats" },
    reason: "Update",
  });
  const claim = store.claimGeneration({
    workerId: "writer",
    leaseMs: 30_000,
    jobId: job.id,
  });
  assert.ok(claim);
  store.snapshotGenerationInput(job.id, claim.leaseToken, claim.input);
  assert.equal(
    (store.get(job.id)!.input as JobInput).sourceEvidenceSnapshot,
    true,
  );
  store.completeGeneration(job.id, claim.leaseToken, {
    ...output,
    sources: [
      { ...sources[0], text: "A made-up capability using the same URL." },
    ],
  });
  assert.throws(
    () =>
      store.reviseJob(job.id, {
        revision: { kind: "edit", post },
        reason: "Use this draft",
      }),
    JobConflictError,
  );
  let apiCalls = 0;
  const client = {
    async listIntegrations() {
      apiCalls++;
      return [];
    },
    async createPost() {
      apiCalls++;
      throw new Error("must not call");
    },
  } as unknown as PostizClient;
  assert.equal(
    (
      await submitNext({
        store,
        client,
        brandId: brand.id,
        leaseMs: 30_000,
        jobId: job.id,
      })
    )?.state,
    "failed",
  );
  assert.equal(apiCalls, 0);
});

void test("revoked or expired knowledge blocks submission while static facts remain compatible", async (t) => {
  const { store, job, advance } = fixture(t);
  const fact = store.createBrandFact(brand.id, {
    claim: "Example API accepts PNG and JPEG",
    url,
    evidence: "PNG and JPEG input formats",
    keywords: ["JPEG"],
    category: "feature",
    observedAt: start,
    expiresAt: start + 86_400_000,
  });
  store.updateBrandFact(brand.id, fact.id, {
    status: "verified",
    reason: "Checked docs",
  });
  const enriched = store.brandWithKnowledge(brand, sources);
  assert.equal(enriched.verifiedFacts?.[0]?.knowledgeId, fact.id);
  store.reviseJob(job.id, {
    revision: { kind: "edit", post },
    reason: "Use verified fact",
    brandSnapshot: enriched,
  });
  const claim = store.claimGeneration({
    workerId: "writer",
    leaseMs: 30_000,
    jobId: job.id,
  });
  assert.ok(claim);
  store.snapshotGenerationInput(job.id, claim.leaseToken, {
    ...input,
    brand: enriched,
    revision: { kind: "edit", post },
  });
  store.completeGeneration(job.id, claim.leaseToken, output);
  store.updateBrandFact(brand.id, fact.id, {
    status: "retired",
    reason: "Withdrawn",
  });
  let creates = 0;
  const client = {
    async listIntegrations() {
      return [];
    },
    async createPost() {
      creates++;
      throw new Error("must not call");
    },
  } as unknown as PostizClient;
  assert.equal(
    (
      await submitNext({
        store,
        client,
        brandId: brand.id,
        leaseMs: 30_000,
        jobId: job.id,
      })
    )?.state,
    "failed",
  );
  assert.equal(creates, 0);
  store.reviseJob(job.id, {
    revision: { kind: "edit", post },
    reason: "Refresh evidence",
    brandSnapshot: {
      ...brand,
      verifiedFacts: [{ claim: "Static verified statement", url }],
    },
  });
  const staticBrand = (store.get(job.id)!.input as JobInput).brand;
  assert.doesNotThrow(() => store.assertKnowledgeCurrent(staticBrand));
  advance(86_400_001);
  assert.throws(() => store.assertKnowledgeCurrent(enriched), JobConflictError);
});
