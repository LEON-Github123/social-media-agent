import assert from "node:assert/strict";
import test from "node:test";
import { ContentJobStore } from "../store.js";
import { readConfig } from "../config.js";
import { Workbench } from "../workbench.js";
import { validateBrand, validateJobInput } from "../validation.js";
import { runWorkbenchTick } from "../workbench-runtime.js";
import type { ContentModel, ModelRequest } from "../models.js";
import type { PostizClient } from "../postiz-client.js";

void test("operator confirms a fact, edits a rejected draft, and delivers one checked draft without rewriting", async (t) => {
  const store = new ContentJobStore(":memory:");
  t.after(() => store.close());
  const brand = validateBrand({
    id: "example",
    name: "Example",
    audience: "Developers",
    businessContext: "API guidance",
  });
  const config = readConfig({
    CONTENT_MODEL: "fixture",
    CONTENT_MODEL_API_KEY: "fixture",
    POSTIZ_API_KEY: "fixture",
    POSTIZ_INTEGRATION_ID: "x-test",
  });
  const source = {
    url: "https://example.com/guide",
    title: "Bearer token",
    text: "The guide shows bearer token authentication.",
  };
  const input = validateJobInput({
    brand,
    sources: [source],
    integrationId: "x-test",
  });
  const original = "Unsupported original post https://example.com/guide";
  const edited =
    "Use bearer token authentication for API requests. https://example.com/guide";
  const calls: ModelRequest[] = [];
  let creates = 0;
  const model: ContentModel = {
    async invoke(request) {
      calls.push(request);
      if (request.task === "relevance")
        return JSON.stringify({
          relevant: true,
          reasoning: "Supported API guidance",
        });
      if (request.task === "quality") {
        assert.equal(JSON.parse(request.user).post, edited);
        assert.match(request.system, /Verified fixture claim/);
        return JSON.stringify({ approved: true, reasons: [] });
      }
      throw new Error(`Unexpected model step ${request.task}`);
    },
  };
  const client = {
    async listIntegrations() {
      return [{ id: "x-test", identifier: "x", disabled: false }];
    },
    async createPost(value: { content: string; mode: string }) {
      assert.equal(value.content, edited);
      assert.equal(value.mode, "draft");
      creates++;
      return { postId: "fixture-draft", integrationId: "x-test" };
    },
    async listPosts() {
      return [];
    },
  } as unknown as PostizClient;
  const workbench = new Workbench({
    store,
    config,
    brand,
    model: () => model,
    client: () => client,
    postizUrl: "https://postiz.example",
  });
  const now = Date.now();
  const created = (await workbench.mutate("/api/brand-facts", {
    claim: "Verified fixture claim: the Example API uses bearer tokens.",
    url: source.url,
    evidence: source.text,
    keywords: ["bearer token"],
    category: "integration",
    observedAt: now,
    expiresAt: now + 86_400_000,
  })) as { fact: { id: string; status: string } };
  assert.equal(created.fact.status, "pending");
  await workbench.mutate(`/api/brand-facts/${created.fact.id}/update`, {
    status: "verified",
    reason: "Fixture evidence checked",
  });
  store.enqueue({
    id: "edit-job",
    brandId: brand.id,
    contentFingerprint: "one-material",
    input,
    mode: "draft",
  });
  assert.equal(store.get("edit-job")?.writingApproved, true);
  const claimed = store.claimGeneration({
    brandId: brand.id,
    workerId: "test",
    leaseMs: 60_000,
  })!;
  store.completeGeneration(
    claimed.id,
    claimed.leaseToken,
    {
      relevant: true,
      reasoning: "Useful",
      report: "Original brief",
      post: original,
      quality: { approved: false, reasons: ["Unsupported sentence"] },
      sources: [source],
    },
    "rejected",
  );
  await assert.rejects(
    workbench.mutate("/api/jobs/edit-job/revise", {
      kind: "edit",
      post: 123,
      reason: "Bad input",
    }),
  );
  const revised = (await workbench.mutate("/api/jobs/edit-job/revise", {
    kind: "edit",
    post: edited,
    reason: "Removed unsupported sentence",
  })) as { job: { state: string } };
  assert.equal(revised.job.state, "queued");
  await runWorkbenchTick({
    store,
    config,
    brand,
    model: () => model,
    client: () => client,
    autoSubmit: true,
  });
  assert.deepEqual(
    calls.map((call) => call.task),
    ["relevance", "quality"],
  );
  assert.equal(creates, 1);
  assert.equal(store.get("edit-job")?.postizId, "fixture-draft");
  assert.ok(
    JSON.stringify(
      store.listAuditEvents({ brandId: brand.id, jobId: "edit-job" }),
    ).includes(original),
  );
  assert.equal(
    store.getGenerationQuota({
      brandId: brand.id,
      limit: 3,
      timeZone: "Asia/Shanghai",
    }).used,
    2,
  );
  await assert.rejects(
    workbench.mutate("/api/jobs/edit-job/revise", {
      kind: "edit",
      post: edited,
      reason: "Cannot change a submitted job",
    }),
  );
  assert.equal(creates, 1);
});
