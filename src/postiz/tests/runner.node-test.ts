import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContentJobStore } from "../store.js";
import { PostizClient } from "../postiz-client.js";
import {
  enqueueContent,
  generateNext,
  submitNext,
  syncJob,
  type JobInput,
} from "../runner.js";
import type { ContentResult } from "../content.js";

const brand = {
  id: "brand-a",
  name: "Brand A",
  audience: "Developers",
  businessContext: "Developer tools",
  contentRules: [],
  examples: [],
  language: "English",
};
const input: JobInput = {
  brand,
  sources: [
    { url: "https://example.com/release", text: "A tool release with docs." },
  ],
  integrationId: "x-account",
  mediaPaths: [],
};
const output: ContentResult = {
  relevant: true,
  reasoning: "Useful release",
  report: "Source report",
  post: "A tool release with docs. https://example.com/release",
  sources: [{ ...input.sources[0], text: "A tool release with docs." }],
  quality: { approved: true, reasons: [] },
};

function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "content-runner-"));
  let now = Date.now();
  const store = new ContentJobStore(join(dir, "jobs.sqlite"), {
    now: () => now,
  });
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const job = enqueueContent(store, input);
  return {
    store,
    job,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function api(
  behavior: {
    create?: () => Response | Promise<Response>;
    posts?: () => unknown[];
    identifier?: string;
  } = {},
) {
  let creates = 0;
  const client = new PostizClient({
    baseUrl: "http://postiz.test/api/public/v1",
    apiKey: "test-key",
    fetch: async (url, init) => {
      assert.equal(new Headers(init?.headers).get("Authorization"), "test-key");
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/integrations"))
        return Response.json([
          {
            id: "x-account",
            name: "X",
            identifier: behavior.identifier ?? "x",
            disabled: false,
            profile: null,
          },
        ]);
      if (init?.method === "POST" && path.endsWith("/posts")) {
        creates++;
        return behavior.create
          ? behavior.create()
          : Response.json([{ postId: "postiz-1", integration: "x-account" }]);
      }
      if (path.endsWith("/posts"))
        return Response.json({ posts: behavior.posts?.() ?? [] });
      throw new Error("Unexpected request");
    },
  });
  return { client, creates: () => creates };
}

async function ready(store: ContentJobStore) {
  return generateNext({
    store,
    brandId: brand.id,
    leaseMs: 30_000,
    generate: async () => output,
  });
}

void test("source URL aliases and updated source text return the original job without regenerating", (t) => {
  const { store, job } = setup(t);
  const duplicate = enqueueContent(store, {
    ...input,
    sources: [
      {
        url: `${input.sources[0].url}?utm_source=feed#section`,
        text: "Updated text",
      },
    ],
  });
  assert.equal(duplicate.id, job.id);
  assert.deepEqual((duplicate.input as JobInput).sources, input.sources);
  assert.equal(store.list().length, 1);
});

void test("X and Twitter handles, domains and photo links share a persistent status identity", (t) => {
  const { store } = setup(t);
  const first = enqueueContent(store, {
    ...input,
    sources: [
      {
        url: "https://twitter.com/oldhandle/status/123456789?s=20",
        text: "Original",
      },
    ],
  });
  for (const url of [
    "https://x.com/newhandle/status/123456789",
    "https://x.com/newhandle/status/123456789/photo/1",
    "https://x.com/i/web/status/123456789",
  ]) {
    assert.equal(
      enqueueContent(store, {
        ...input,
        sources: [{ url, text: "Refreshed text" }],
      }).id,
      first.id,
    );
  }
});

void test("approved generation submits once; acceptance is separate from X publication", async (t) => {
  const { store, job } = setup(t);
  let generations = 0;
  const generate = async () => {
    generations++;
    return output;
  };
  const options = { store, brandId: brand.id, leaseMs: 30_000, generate };
  assert.equal((await generateNext(options))?.state, "ready");
  assert.equal(await generateNext(options), null);
  const remote = api();
  const submit = { ...options, client: remote.client };
  assert.equal((await submitNext(submit))?.state, "submitted");
  assert.equal(await submitNext(submit), null);
  assert.equal(generations, 1);
  assert.equal(remote.creates(), 1);
  assert.equal(store.get(job.id)?.platformPostId, null);
});

void test("ambiguous create is unknown and cannot be retried or submitted again", async (t) => {
  const { store, job } = setup(t);
  await ready(store);
  const remote = api({
    create: () => {
      throw new Error("Response lost");
    },
  });
  const options = {
    store,
    client: remote.client,
    brandId: brand.id,
    leaseMs: 30_000,
  };
  assert.equal((await submitNext(options))?.state, "unknown");
  assert.throws(() => store.retry(job.id));
  assert.equal(enqueueContent(store, input).state, "unknown");
  assert.equal(await submitNext(options), null);
  assert.equal(remote.creates(), 1);
});

void test("a confirmed 401 needs explicit retry, preserving the generated content", async (t) => {
  const { store, job } = setup(t);
  await ready(store);
  const remote = api({
    create: () => new Response("Unauthorized", { status: 401 }),
  });
  const result = await submitNext({
    store,
    client: remote.client,
    brandId: brand.id,
    leaseMs: 30_000,
  });
  assert.equal(result?.state, "failed");
  assert.equal(store.retry(job.id).state, "ready");
  assert.deepEqual(store.get(job.id)?.output, output);
});

void test("lease loss after remote acceptance recovers as unknown without a second POST", async (t) => {
  const { store, advance } = setup(t);
  await ready(store);
  const remote = api({
    create: () => {
      advance(30_001);
      return Response.json([
        { postId: "accepted-but-late", integration: "x-account" },
      ]);
    },
  });
  const options = {
    store,
    client: remote.client,
    brandId: brand.id,
    leaseMs: 30_000,
  };
  assert.equal((await submitNext(options))?.state, "unknown");
  assert.equal(await submitNext(options), null);
  assert.equal(remote.creates(), 1);
});

void test("an integration for a different platform cannot receive this X job", async (t) => {
  const { store } = setup(t);
  await ready(store);
  const remote = api({ identifier: "linkedin" });
  assert.equal(
    (
      await submitNext({
        store,
        client: remote.client,
        brandId: brand.id,
        leaseMs: 30_000,
      })
    )?.state,
    "failed",
  );
  assert.equal(remote.creates(), 0);
});

void test("missing X receipt remains null and can later become a real numeric ID", async (t) => {
  const { store, job } = setup(t);
  await ready(store);
  let releaseId = "missing";
  const remote = api({
    posts: () => [
      {
        id: "postiz-1",
        content: output.post,
        publishDate: new Date().toISOString(),
        state: "PUBLISHED",
        releaseId,
        releaseURL: null,
        integration: { id: "x-account", providerIdentifier: "x" },
      },
    ],
  });
  await submitNext({
    store,
    client: remote.client,
    brandId: brand.id,
    leaseMs: 30_000,
  });
  assert.equal(
    (await syncJob(store, remote.client, store.get(job.id)!)).platformPostId,
    null,
  );
  releaseId = "1234567890123456789";
  assert.equal(
    (await syncJob(store, remote.client, store.get(job.id)!)).platformPostId,
    releaseId,
  );
});

void test("manual unknown binding verifies content and integration before accepting an existing ID", async (t) => {
  const { store, job } = setup(t);
  await ready(store);
  const failed = api({
    create: () => new Response("uncertain", { status: 502 }),
  });
  await submitNext({
    store,
    client: failed.client,
    brandId: brand.id,
    leaseMs: 30_000,
  });
  let content = "Unrelated post";
  const remote = api({
    posts: () => [
      {
        id: "postiz-existing",
        content,
        publishDate: new Date().toISOString(),
        state: "DRAFT",
        releaseId: null,
        releaseURL: null,
        integration: { id: "x-account", providerIdentifier: "x" },
      },
    ],
  });
  await assert.rejects(
    syncJob(store, remote.client, store.get(job.id)!, "postiz-existing"),
    /content differs/,
  );
  assert.equal(store.get(job.id)?.state, "unknown");
  content = output.post;
  assert.equal(
    (await syncJob(store, remote.client, store.get(job.id)!, "postiz-existing"))
      .postizId,
    "postiz-existing",
  );
  assert.equal(remote.creates(), 0);
});

void test("invalid calendar dates and timezone-less schedules are rejected before enqueue", (t) => {
  const { store } = setup(t);
  for (const date of [
    "2030-02-31T12:00:00Z",
    "2030-03-01T24:00:00Z",
    "2030-03-01T12:00:00",
  ])
    assert.throws(
      () => enqueueContent(store, input, date, { allowScheduling: true }),
      /ISO/,
    );
});

void test("new and persisted schedules require explicit draft repair before generation or submission", async (t) => {
  const { store } = setup(t);
  const scheduledInput = {
    ...input,
    sources: [
      {
        url: "https://example.com/scheduled",
        text: "A separate developer release.",
      },
    ],
  };
  const date = "2099-01-01T00:00:00Z";
  assert.throws(
    () => enqueueContent(store, scheduledInput, date),
    /Scheduling is disabled/,
  );
  const old = enqueueContent(store, scheduledInput, date, {
    allowScheduling: true,
  });
  let generations = 0;
  const generate = async () => {
    generations++;
    return output;
  };
  const blocked = await generateNext({
    store,
    brandId: brand.id,
    jobId: old.id,
    leaseMs: 30_000,
    generate,
  });
  assert.equal(blocked?.state, "failed");
  assert.equal(generations, 0);
  assert.match(blocked!.lastError!, /Scheduling is disabled/);

  // A task already generated before the switch was closed is gated as well.
  store.retry(old.id);
  await generateNext({
    store,
    brandId: brand.id,
    jobId: old.id,
    leaseMs: 30_000,
    generate,
    allowScheduling: true,
  });
  let requests = 0;
  const client = new PostizClient({
    baseUrl: "http://postiz.test/api/public/v1",
    apiKey: "test",
    fetch: async () => {
      requests++;
      throw new Error("Must not call Postiz");
    },
  });
  const failed = await submitNext({
    store,
    client,
    brandId: brand.id,
    jobId: old.id,
    leaseMs: 30_000,
  });
  assert.equal(failed?.state, "failed");
  assert.equal(requests, 0);

  const repaired = store.repairFailed(old.id, {
    toDraft: true,
    reason: "Review in Postiz first",
    brandSnapshot: {
      ...brand,
      contentRules: ["Use a practical developer example"],
    },
  });
  assert.equal(repaired.state, "queued");
  assert.equal(repaired.mode, "draft");
  assert.equal(repaired.output, null);
  await generateNext({
    store,
    brandId: brand.id,
    jobId: old.id,
    leaseMs: 30_000,
    generate: async (revised) => {
      assert.deepEqual(revised.brand.contentRules, [
        "Use a practical developer example",
      ]);
      return output;
    },
  });
  const remote = api();
  assert.equal(
    (
      await submitNext({
        store,
        client: remote.client,
        brandId: brand.id,
        jobId: old.id,
        leaseMs: 30_000,
      })
    )?.state,
    "submitted",
  );
  assert.equal(remote.creates(), 1);
  assert.equal(store.listAuditEvents({ jobId: old.id }).length, 2);
});

void test("a failed quality review never enters the publication queue", async (t) => {
  const { store } = setup(t);
  assert.equal(
    (
      await generateNext({
        store,
        brandId: brand.id,
        leaseMs: 30_000,
        generate: async () => ({
          ...output,
          quality: { approved: false, reasons: ["unsupported claim"] },
        }),
      })
    )?.state,
    "rejected",
  );
  const remote = api();
  assert.equal(
    await submitNext({
      store,
      client: remote.client,
      brandId: brand.id,
      leaseMs: 30_000,
    }),
    null,
  );
  assert.equal(remote.creates(), 0);
});

void test("historical approved output is rechecked for current source attribution before any API call", async (t) => {
  const { store, job } = setup(t);
  const claim = store.claimGeneration({
    workerId: "old-version",
    leaseMs: 30_000,
    jobId: job.id,
  })!;
  store.completeGeneration(
    job.id,
    claim.leaseToken,
    {
      ...output,
      post: "Read our API documentation. https://docs.tokenhot.ai/general",
    },
    "ready",
  );
  let calls = 0;
  const client = new PostizClient({
    baseUrl: "http://postiz.test/api/public/v1",
    apiKey: "test",
    fetch: async () => {
      calls++;
      throw new Error("Must not request");
    },
  });
  const result = await submitNext({
    store,
    client,
    brandId: brand.id,
    leaseMs: 30_000,
  });
  assert.equal(result?.state, "failed");
  assert.match(result!.lastError!, /must link to a supplied source/);
  assert.equal(calls, 0);
});
