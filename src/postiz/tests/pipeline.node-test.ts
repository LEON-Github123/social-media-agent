import assert from "node:assert/strict";
import test from "node:test";
import { ContentJobStore } from "../store.js";
import { collectSources } from "../collector.js";
import { selectAndQueue } from "../pipeline.js";
import { generateNext, submitNext } from "../runner.js";
import { PostizClient } from "../postiz-client.js";
import type { ContentModel } from "../models.js";
import type { SourceInput } from "../sources.js";

const now = Date.parse("2026-09-24T09:00:00Z");
const brand = {
  id: "tokenhot",
  name: "Tokenhot",
  audience: "API developers",
  businessContext: "Useful API changes",
  language: "English",
  contentRules: [],
  examples: [],
};
function material(version: string, host = "primary.example.com"): SourceInput {
  return {
    url: `https://${host}/release-${version}`,
    title: `Model ${version} release`,
    text: `Acme released Model ${version} with documented structured outputs.`,
    publishedAt: "2026-09-23T00:00:00Z",
  };
}
function selectorModel(): ContentModel {
  return {
    invoke: async (request) => {
      const payload = JSON.parse(request.user);
      if (request.task === "selection_review")
        return JSON.stringify({
          groups: payload.groups.map((group: { topicId: string }) => ({
            topicId: group.topicId,
            confirmed: true,
            reason: "Exact same product and release version",
          })),
        });
      return JSON.stringify({
        decisions: payload.candidates.map(
          (source: {
            candidateId: string;
            text: string;
            title: string;
            url: string;
          }) => {
            const version = /Model (\d+\.\d+)/.exec(source.title)![1];
            return {
              candidateId: source.candidateId,
              scores: { relevance: 95, evidence: 95, developerValue: 90 },
              certainty: "confirmed",
              reason: "Actionable API release",
              identity: {
                entity: "Acme",
                product: "Model",
                version,
                eventType: "release",
                eventDate: "2026-09-23",
                primaryUrl: source.url,
              },
              identityEvidence: `Acme released Model ${version} with documented structured outputs.`,
            };
          },
        ),
      });
    },
  };
}

void test("same announcement across batches stays one job after an unknown submission; another version is independent", async (t) => {
  const store = new ContentJobStore(":memory:", { now: () => now });
  t.after(() => store.close());
  store.upsertCandidates({
    brandId: brand.id,
    origin: "manual",
    primary: true,
    inputs: [material("1.10"), material("1.10", "reporter.example.com")],
  });
  const options = {
    store,
    brand,
    integrationId: "x-tokenhot",
    model: selectorModel(),
    now,
  };
  const first = await selectAndQueue(options);
  assert.equal(first.queued, 1);
  const [job] = store.list();
  const source = material("1.10");
  await generateNext({
    store,
    brandId: brand.id,
    leaseMs: 30000,
    generate: async () => ({
      relevant: true,
      reasoning: "Useful",
      report: "Verified release",
      post: `Model 1.10 adds structured outputs. ${source.url}`,
      sources: [{ ...source, text: source.text! }],
      quality: { approved: true, reasons: [] },
    }),
  });
  const client = new PostizClient({
    baseUrl: "http://postiz.test/api/public/v1",
    apiKey: "test",
    fetch: async (url, init) => {
      if (init?.method === "POST") throw new Error("Response lost");
      return Response.json([
        {
          id: "x-tokenhot",
          name: "Tokenhot",
          identifier: "x",
          disabled: false,
        },
      ]);
    },
  });
  assert.equal(
    (await submitNext({ store, client, brandId: brand.id, leaseMs: 30000 }))
      ?.state,
    "unknown",
  );
  store.upsertCandidates({
    brandId: brand.id,
    origin: "rss",
    inputs: [material("1.10", "late-reporter.example.com"), material("1.11")],
  });
  assert.equal((await selectAndQueue(options)).queued, 1);
  assert.equal(store.list().length, 2);
  assert.equal(store.get(job.id)?.state, "unknown");
  assert.equal(
    store
      .listTopics({ brandId: brand.id })
      .filter((topic) => topic.identity.version === "1.10").length,
    1,
  );
});

void test("SQLite source checkpoints survive restart and a failed source does not block another", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = mkdtempSync(join(tmpdir(), "source-checkpoints-"));
  const path = join(directory, "content.sqlite");
  let store = new ContentJobStore(path, { now: () => now });
  let requests = 0;
  try {
    const options = {
      brandId: brand.id,
      workerId: "worker",
      now: () => now,
      maxSourcesPerTick: 2,
      sources: [
        { id: "bad", type: "rss" as const, url: "https://bad.example/rss" },
        { id: "good", type: "rss" as const, url: "https://good.example/rss" },
      ],
      discover: async (source: { id?: string }) => {
        requests++;
        if (source.id === "bad") throw new Error("Temporary outage");
        return { inputs: [material("1.10")], checkpoint: null, complete: true };
      },
    };
    const first = await collectSources({ ...options, store });
    assert.equal(first.failed, 1);
    assert.equal(first.inserted, 1);
    store.close();
    store = new ContentJobStore(path, { now: () => now });
    assert.equal((await collectSources({ ...options, store })).checked, 0);
    assert.equal(requests, 2);
    assert.equal(store.listCandidates({ brandId: brand.id }).length, 1);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

void test("selection failure is persisted for manual review and is not called again each tick", async (t) => {
  const store = new ContentJobStore(":memory:", { now: () => now });
  t.after(() => store.close());
  store.upsertCandidates({
    brandId: brand.id,
    origin: "manual",
    inputs: [material("1.10")],
  });
  let calls = 0;
  const options = {
    store,
    brand,
    integrationId: "x-tokenhot",
    now,
    model: {
      invoke: async () => {
        calls++;
        throw new Error("Model unavailable");
      },
    },
  };
  assert.equal((await selectAndQueue(options)).queued, 0);
  assert.equal(
    store.listCandidates({ brandId: brand.id })[0].status,
    "needs_review",
  );
  assert.equal((await selectAndQueue(options)).evaluated, 0);
  assert.equal(calls, 1);
  assert.equal(store.getGenerationQuota({ brandId: brand.id }).used, 0);
});
