import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { Worker } from "node:worker_threads";
import {
  ContentJobStore,
  JobConflictError,
  LeaseLostError,
  type ContentCandidate,
  type EnqueueContentJob,
} from "../store.js";
import type { SelectionResult } from "../operations-types.js";

function fixture(t: TestContext, initial = Date.parse("2026-09-24T15:59:59Z")) {
  const dir = mkdtempSync(join(tmpdir(), "postiz-operations-"));
  const path = join(dir, "content.sqlite");
  const stores = new Set<ContentJobStore>();
  let now = initial;
  const open = () => {
    const store = new ContentJobStore(path, { now: () => now });
    stores.add(store);
    return store;
  };
  const close = (store: ContentJobStore) => {
    store.close();
    stores.delete(store);
  };
  t.after(() => {
    for (const store of stores) store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    path,
    open,
    close,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
const brand = {
  id: "tokenhot",
  name: "Tokenhot",
  audience: "Developers",
  businessContext: "AI tools",
  contentRules: [],
  examples: [],
  language: "English",
};
function job(id: string, url = `https://example.com/${id}`): EnqueueContentJob {
  return {
    id,
    brandId: brand.id,
    contentFingerprint: id,
    mode: "draft",
    input: {
      brand,
      sources: [{ url }],
      integrationId: "account-a",
      mediaPaths: [],
    },
  };
}
function candidate(store: ContentJobStore, id: string) {
  return store.upsertCandidates({
    brandId: brand.id,
    origin: "manual",
    primary: true,
    inputs: [
      {
        url: `https://example.com/${id}`,
        title: `SDK ${id}`,
        text: `Release ${id} with documented changes.`,
        publishedAt: "2026-09-24T10:00:00Z",
      },
    ],
  })[0];
}
function selection(
  candidates: ContentCandidate[],
  id: string,
  status: "ready" | "needs_review" = "ready",
): SelectionResult {
  const identity = {
    entity: "Acme",
    product: "SDK",
    version: id,
    eventType: "release" as const,
    eventDate: "2026-09-24",
    primaryUrl: candidates[0].input.url,
  };
  return {
    candidateDecisions: candidates.map((item) => ({
      candidateId: item.id,
      status: status === "ready" ? "selected" : "needs_review",
      scores: { relevance: 5, evidence: 5, freshness: 5, developerValue: 5 },
      totalScore: 20,
      reason: "Verified release",
      identity,
      topicId: id,
    })),
    topics: [
      {
        id,
        identityKey: `v1:${id}`,
        title: `Release ${id}`,
        identity,
        candidateIds: candidates.map((item) => item.id),
        sourceCandidateIds: candidates.map((item) => item.id),
        sourceMetadata: candidates.map((item) => ({
          candidateId: item.id,
          url: item.input.url,
          primary: item.primary,
        })),
        status,
        reason: "Evidence ready",
      },
    ],
    modelCalls: 1,
    warnings: [],
  };
}

void test("three durable Shanghai writing starts include previews, failures and crash retries, then reset at midnight", (t) => {
  const f = fixture(t);
  const a = f.open();
  a.enqueue(job("one"));
  const first = a.claimGeneration({
    workerId: "first",
    leaseMs: 100,
    brandId: brand.id,
  });
  assert.ok(first);
  a.failGeneration(first.id, first.leaseToken, "Provider refused model call");
  a.retry(first.id, { reason: "Retry provider failure" });
  assert.equal(a.getGenerationQuota({ brandId: brand.id }).used, 1);
  assert.ok(a.reserveGenerationAttempt({ brandId: brand.id, kind: "preview" }));
  const third = a.claimGeneration({
    workerId: "third",
    leaseMs: 100,
    brandId: brand.id,
  });
  assert.ok(third);
  f.close(a);
  f.advance(100);
  const b = f.open();
  assert.equal(b.recoverExpired().generation, 1);
  assert.equal(b.getGenerationQuota({ brandId: brand.id }).remaining, 0);
  assert.equal(
    b.claimGeneration({
      workerId: "over-limit",
      leaseMs: 100,
      brandId: brand.id,
    }),
    null,
  );
  assert.equal(b.get("one")?.state, "queued");
  assert.equal(
    b.reserveGenerationAttempt({ brandId: brand.id, kind: "preview" }),
    null,
  );
  assert.equal(b.listGenerationAttempts({ brandId: brand.id }).length, 3);
  assert.throws(
    () =>
      b.reserveGenerationAttempt({
        brandId: brand.id,
        kind: "preview",
        limit: 4,
      }),
    /between 1 and 3/,
  );
  f.advance(900);
  assert.equal(
    b.getGenerationQuota({ brandId: brand.id }).dayKey,
    "2026-09-25",
  );
  assert.equal(b.getGenerationQuota({ brandId: brand.id }).used, 0);
  assert.ok(
    b.claimGeneration({
      workerId: "next-day",
      leaseMs: 100,
      brandId: brand.id,
    }),
  );
  assert.equal(b.listGenerationAttempts({ brandId: brand.id }).length, 4);
  // UTC is still September 24: all four actual starts fall in that UTC day.
  assert.equal(
    b.getGenerationQuota({ brandId: brand.id, timeZone: "UTC" }).remaining,
    0,
  );
});

void test("five concurrent processes cannot reserve more than three generation starts", async (t) => {
  const f = fixture(t);
  const store = f.open();
  for (let i = 0; i < 5; i++) store.enqueue(job(`job-${i}`));
  const flag = new SharedArrayBuffer(4);
  const barrier = new Int32Array(flag);
  let ready = 0;
  const workers: Worker[] = [];
  t.after(async () => {
    await Promise.all(workers.map((worker) => worker.terminate()));
  });
  const compiled = new URL("../store.js", import.meta.url);
  const moduleUrl = existsSync(compiled)
    ? compiled.href
    : new URL("../store.ts", import.meta.url).href;
  const results = await Promise.all(
    Array.from(
      { length: 5 },
      (_, index) =>
        new Promise<boolean>((resolve, reject) => {
          const worker = new Worker(
            `const {parentPort,workerData}=require('node:worker_threads');
      (async()=>{if(workerData.moduleUrl.endsWith('.ts')){const {register}=await import('tsx/esm/api');register();}
      const {ContentJobStore}=await import(workerData.moduleUrl);const store=new ContentJobStore(workerData.path,{now:()=>workerData.now});
      parentPort.postMessage({ready:true});Atomics.wait(new Int32Array(workerData.flag),0,0,10000);
      const claim=store.claimGeneration({workerId:'worker-'+workerData.index,brandId:'tokenhot',leaseMs:60000});
      store.close();parentPort.postMessage({claimed:!!claim});})().catch(error=>{throw error;});`,
            {
              eval: true,
              workerData: {
                path: f.path,
                moduleUrl,
                flag,
                index,
                now: f.now(),
              },
            },
          );
          workers.push(worker);
          worker.once("error", reject);
          worker.on(
            "message",
            (message: { ready?: boolean; claimed?: boolean }) => {
              if (message.ready) {
                if (++ready === 5) {
                  Atomics.store(barrier, 0, 1);
                  Atomics.notify(barrier, 0, 5);
                }
              } else resolve(!!message.claimed);
            },
          );
        }),
    ),
  );
  assert.equal(results.filter(Boolean).length, 3);
  assert.equal(store.list({ state: "processing" }).length, 3);
  assert.equal(store.list({ state: "queued" }).length, 2);
  assert.equal(store.listGenerationAttempts({ brandId: brand.id }).length, 3);
});

void test("candidate identity keeps raw URL extraction stable, preserves web input versions and merges X mirrors", (t) => {
  const f = fixture(t);
  const store = f.open();
  const input = { url: "https://example.com/changelog?utm_source=rss" };
  const [first] = store.upsertCandidates({
    brandId: brand.id,
    origin: "url",
    inputs: [input],
  });
  store.recordCandidateDocument(first.id, {
    url: "https://example.com/changelog",
    text: "Extracted full document.",
  });
  assert.equal(
    store.upsertCandidates({
      brandId: brand.id,
      origin: "rss",
      inputs: [input],
    })[0].id,
    first.id,
  );
  assert.equal(
    store.getCandidate(first.id)?.document?.text,
    "Extracted full document.",
  );
  const version1 = store.upsertCandidates({
    brandId: brand.id,
    origin: "rss",
    inputs: [{ url: input.url, title: "SDK 1", text: "Version 1" }],
  })[0];
  const version2 = store.upsertCandidates({
    brandId: brand.id,
    origin: "rss",
    inputs: [{ url: input.url, title: "SDK 2", text: "Version 2" }],
  })[0];
  assert.notEqual(version1.id, version2.id);
  const bare = store.upsertCandidates({
    brandId: brand.id,
    origin: "manual",
    inputs: [{ url: "https://x.com/user/status/123" }],
  })[0];
  const filled = store.upsertCandidates({
    brandId: brand.id,
    origin: "getx-user",
    primary: true,
    inputs: [
      {
        url: "https://mobile.twitter.com/another/status/123?utm_medium=x",
        text: "Actual post body",
      },
    ],
  })[0];
  assert.equal(filled.id, bare.id);
  assert.equal(filled.document?.text, "Actual post body");
  assert.equal(filled.primary, true);
  assert.equal(
    store.listCandidates({ brandId: brand.id, limit: 100 }).length,
    4,
  );
});

void test("extraction failure stays failed across rediscovery and needs an audited explicit retry", (t) => {
  const f = fixture(t);
  const store = f.open();
  const input = { url: "https://example.com/broken" };
  const [item] = store.upsertCandidates({
    brandId: brand.id,
    origin: "manual",
    inputs: [input],
  });
  store.failCandidateFetch(item.id, "Upstream unavailable");
  store.upsertCandidates({
    brandId: brand.id,
    origin: "manual",
    inputs: [input],
  });
  assert.equal(
    store.listCandidates({ brandId: brand.id, status: "new" }).length,
    0,
  );
  assert.throws(
    () =>
      store.recordCandidateDocument(item.id, {
        ...input,
        text: "Late stale response",
      }),
    JobConflictError,
  );
  const retried = store.retryCandidate(item.id, {
    brandId: brand.id,
    reason: "Provider recovered",
  });
  assert.equal(retried.fetchState, "pending");
  assert.equal(retried.status, "new");
  assert.equal(
    store.listAuditEvents({ brandId: brand.id })[0].eventType,
    "candidate.retried",
  );
});

void test("legacy sources need explicit distinct-event confirmation, while exact X events stay bound to old work", (t) => {
  const f = fixture(t);
  const store = f.open();
  store.enqueue(job("legacy", "https://example.com/changelog"));
  const [ambiguous] = store.upsertCandidates({
    brandId: brand.id,
    origin: "rss",
    inputs: [
      {
        url: "https://example.com/changelog",
        text: "A new version is claimed",
      },
    ],
  });
  assert.equal(ambiguous.status, "needs_review");
  assert.deepEqual(ambiguous.legacyJobIds, ["legacy"]);
  assert.throws(
    () =>
      store.retryCandidate(ambiguous.id, {
        brandId: brand.id,
        reason: "No evidence",
      }),
    JobConflictError,
  );
  assert.throws(
    () =>
      store.saveSelection({
        brandId: brand.id,
        result: selection([ambiguous], "ambiguous"),
      }),
    JobConflictError,
  );
  const resolved = store.resolveCandidateLegacy(ambiguous.id, {
    brandId: brand.id,
    reason: "Operator verified distinct SDK 2 release",
  });
  assert.equal(resolved.status, "new");
  assert.equal(resolved.legacyConflict, false);
  assert.deepEqual(resolved.legacyJobIds, ["legacy"]);
  store.enqueue(job("legacy-x", "https://twitter.com/user/status/456"));
  const [same] = store.upsertCandidates({
    brandId: brand.id,
    origin: "getx-user",
    inputs: [
      {
        url: "https://x.com/other/status/456",
        text: "More complete source text",
      },
    ],
  });
  assert.equal(same.status, "selected");
  assert.deepEqual(same.legacyJobIds, ["legacy-x"]);
  assert.throws(
    () =>
      store.retryCandidate(same.id, {
        brandId: brand.id,
        reason: "Cannot duplicate",
      }),
    JobConflictError,
  );
});

void test("source checkpoints and candidates commit together; expired or config-invalidated leases cannot advance", (t) => {
  const f = fixture(t);
  const a = f.open();
  const b = f.open();
  a.ensureSources({
    brandId: brand.id,
    sources: [{ id: "feed", origin: "rss", primary: true, configHash: "v1" }],
  });
  const claim = a.claimDueSource({
    brandId: brand.id,
    sourceIds: ["feed"],
    workerId: "a",
    leaseMs: 100,
  });
  assert.ok(claim);
  assert.equal(
    b.claimDueSource({
      brandId: brand.id,
      sourceIds: ["feed"],
      workerId: "b",
      leaseMs: 100,
    }),
    null,
  );
  const circular: { self?: unknown } = {};
  circular.self = circular;
  assert.throws(
    () =>
      a.completeSourceCheck(claim, {
        checkedAt: f.now(),
        nextCheckAt: f.now(),
        checkpoint: circular,
        inputs: [{ url: "https://example.com/page1" }],
        origin: "rss",
      }),
    /circular/,
  );
  assert.equal(a.listCandidates({ brandId: brand.id }).length, 0);
  assert.equal(
    a.listSourceCheckpoints({ brandId: brand.id })[0].checkpoint,
    null,
  );
  assert.deepEqual(
    a.completeSourceCheck(claim, {
      checkedAt: f.now(),
      nextCheckAt: f.now() + 50,
      checkpoint: { page: 2 },
      inputs: [{ url: "https://example.com/page1" }],
      origin: "rss",
    }),
    { inserted: 1, duplicates: 0 },
  );
  f.advance(50);
  const second = b.claimDueSource({
    brandId: brand.id,
    sourceIds: ["feed"],
    workerId: "b",
    leaseMs: 100,
  });
  assert.ok(second);
  assert.deepEqual(second.checkpoint, { page: 2 });
  b.failSourceCheck(second, {
    checkedAt: f.now(),
    nextCheckAt: f.now() + 50,
    lastFailure: "Temporary provider error",
  });
  const failed = a.listSourceCheckpoints({ brandId: brand.id })[0];
  assert.deepEqual(failed.checkpoint, { page: 2 });
  assert.equal(failed.failureCount, 1);
  f.advance(50);
  const old = a.claimDueSource({
    brandId: brand.id,
    sourceIds: ["feed"],
    workerId: "a",
    leaseMs: 100,
  });
  assert.ok(old);
  f.advance(100);
  assert.throws(
    () =>
      a.failSourceCheck(old, {
        checkedAt: f.now(),
        nextCheckAt: f.now(),
        lastFailure: "Too late",
      }),
    LeaseLostError,
  );
  const fresh = b.claimDueSource({
    brandId: brand.id,
    sourceIds: ["feed"],
    workerId: "b",
    leaseMs: 100,
  });
  assert.ok(fresh);
  assert.notEqual(fresh.leaseToken, old.leaseToken);
  b.ensureSources({
    brandId: brand.id,
    sources: [{ id: "feed", origin: "rss", configHash: "v2" }],
  });
  assert.throws(
    () =>
      b.completeSourceCheck(fresh, {
        checkedAt: f.now(),
        nextCheckAt: f.now(),
        checkpoint: null,
        inputs: [],
        origin: "rss",
      }),
    LeaseLostError,
  );
  const reset = a.listSourceCheckpoints({ brandId: brand.id })[0];
  assert.equal(reset.checkpoint, null);
  assert.equal(reset.nextCheckAt, 0);
  assert.equal(reset.failureCount, 0);
});

void test("topic job binding is atomic and idempotent across connections, with full persistent topic history", (t) => {
  const f = fixture(t);
  const a = f.open();
  const b = f.open();
  const first = candidate(a, "release-a");
  a.saveSelection({ brandId: brand.id, result: selection([first], "sdk-v1") });
  const created = a.enqueueForTopic(
    "sdk-v1",
    job("topic-job", first.input.url),
  );
  assert.equal(
    b.enqueueForTopic("sdk-v1", job("different-job", first.input.url)).id,
    created.id,
  );
  assert.equal(a.list().length, 1);
  assert.equal(a.getTopic("sdk-v1")?.hasContent, true);
  const later = candidate(a, "second-report");
  const duplicate = selection([later], "sdk-v1");
  duplicate.topics[0].sourceCandidateIds = [first.id, later.id];
  duplicate.topics[0].sourceMetadata = [
    { candidateId: first.id, url: first.input.url, primary: true },
    { candidateId: later.id, url: later.input.url, primary: true },
  ];
  a.saveSelection({ brandId: brand.id, result: duplicate });
  assert.equal(a.getTopic("sdk-v1")?.jobId, created.id);
  assert.equal(a.getTopic("sdk-v1")?.status, "existing");
  assert.throws(
    () => b.saveSelection({ brandId: brand.id, result: duplicate }),
    JobConflictError,
  );
  for (let i = 0; i < 25; i++) {
    const item = candidate(a, `history-${i}`);
    a.saveSelection({
      brandId: brand.id,
      result: selection([item], `event-${i}`),
    });
  }
  assert.equal(b.listTopics({ brandId: brand.id }).length, 26);
  assert.ok(
    b
      .listTopics({ brandId: brand.id })
      .some((topic) => topic.id === "sdk-v1" && topic.hasContent),
  );
});

void test("new evidence cannot bypass manual topic review or rejection and model calls survive failed workflows", (t) => {
  const f = fixture(t);
  const store = f.open();
  const first = candidate(store, "review-one");
  store.recordSelectionModelCall({
    brandId: brand.id,
    task: "selection",
    candidateIds: [first.id],
  });
  store.saveSelection({
    brandId: brand.id,
    result: selection([first], "review-event", "needs_review"),
  });
  assert.throws(
    () =>
      store.enqueueForTopic("review-event", job("blocked", first.input.url)),
    JobConflictError,
  );
  const second = candidate(store, "review-two");
  store.saveSelection({
    brandId: brand.id,
    result: selection([second], "review-event"),
  });
  assert.equal(store.getTopic("review-event")?.status, "needs_review");
  store.reviewTopic("review-event", {
    brandId: brand.id,
    decision: "reject",
    reason: "Unverifiable central claim",
  });
  const third = candidate(store, "review-three");
  store.saveSelection({
    brandId: brand.id,
    result: selection([third], "review-event"),
  });
  assert.equal(store.getTopic("review-event")?.status, "rejected");
  assert.throws(
    () =>
      store.enqueueForTopic(
        "review-event",
        job("still-blocked", third.input.url),
      ),
    JobConflictError,
  );
  f.close(store);
  const reopened = f.open();
  assert.equal(
    reopened.listSelectionModelCalls({ brandId: brand.id }).length,
    1,
  );
  assert.equal(
    reopened.listGenerationAttempts({ brandId: brand.id }).length,
    0,
  );
});

void test("legacy distinct-event confirmation cannot bypass submitting, unknown or recorded provider receipts", (t) => {
  const f = fixture(t);
  const store = f.open();
  for (const state of ["submitting", "unknown", "submitted"] as const) {
    const original = job(`legacy-${state}`);
    store.enqueue(original);
    const generation = store.claimGeneration({
      workerId: "writer",
      jobId: original.id,
      leaseMs: 100,
    });
    assert.ok(generation);
    store.completeGeneration(original.id, generation.leaseToken, {
      post: "Original content",
    });
    const submit = store.claimSubmit({
      workerId: "publisher",
      jobId: original.id,
      leaseMs: 100,
    });
    assert.ok(submit);
    if (state === "unknown")
      store.markUnknown(original.id, submit.leaseToken, "Remote outcome lost");
    if (state === "submitted")
      store.recordSubmitted(original.id, submit.leaseToken, {
        postizId: "existing-postiz",
        postizState: "DRAFT",
      });
    const [item] = store.upsertCandidates({
      brandId: brand.id,
      origin: "manual",
      inputs: [
        {
          url: `https://example.com/${original.id}`,
          text: "Different prose alone does not prove a new safe event",
        },
      ],
    });
    assert.equal(item.status, "needs_review");
    assert.throws(
      () =>
        store.resolveCandidateLegacy(item.id, {
          brandId: brand.id,
          reason: "Claiming a new version cannot bypass remote reconciliation",
        }),
      /uncertain submission or provider receipt/,
    );
    assert.equal(store.getCandidate(item.id)?.legacyConflict, true);
    assert.equal(store.get(original.id)?.state, state);
  }
});

void test("a pending identity collision stays separate; explicit merge waits for reconciliation and changes no job data", (t) => {
  const f = fixture(t);
  const store = f.open();
  const first = candidate(store, "canonical");
  store.saveSelection({
    brandId: brand.id,
    result: selection([first], "canonical-event"),
  });
  store.enqueueForTopic(
    "canonical-event",
    job("canonical-job", first.input.url),
  );
  const generation = store.claimGeneration({
    workerId: "writer",
    leaseMs: 100,
  });
  assert.ok(generation);
  store.completeGeneration(generation.id, generation.leaseToken, {
    post: "Original approved draft",
    source: first.input.url,
  });
  const submit = store.claimSubmit({ workerId: "publisher", leaseMs: 100 });
  assert.ok(submit);
  store.markUnknown(submit.id, submit.leaseToken, "Lost provider response");
  const extra = candidate(store, "extra-evidence");
  const proposal = selection([extra], "review-proposal", "needs_review");
  proposal.topics[0].identityKey = "v1:canonical-event";
  store.saveSelection({ brandId: brand.id, result: proposal });
  const pending = store.getTopic("review-proposal")!;
  assert.equal(pending.status, "needs_review");
  assert.equal(pending.jobId, null);
  assert.deepEqual(pending.conflictingTopicIds, ["canonical-event"]);
  assert.equal(store.getCandidate(extra.id)?.topicId, "review-proposal");
  assert.throws(
    () =>
      store.reviewTopic(pending.id, {
        brandId: brand.id,
        decision: "approve",
        reason: "Unbound approval must not create a duplicate",
      }),
    /explicitly merge/,
  );
  assert.throws(
    () =>
      store.reviewTopic(pending.id, {
        brandId: brand.id,
        decision: "approve",
        reason: "Cannot merge unknown",
        mergeWith: "canonical-event",
      }),
    /Reconcile/,
  );
  store.bindUnknown(submit.id, {
    postizId: "verified-remote-draft",
    postizState: "DRAFT",
  });
  const before = store.get(submit.id)!;
  assert.throws(
    () =>
      store.reviewTopic(pending.id, {
        brandId: brand.id,
        decision: "approve",
        reason: "",
        mergeWith: "canonical-event",
      }),
    /reason/,
  );
  assert.equal(store.getTopic(pending.id)?.status, "needs_review");
  const merged = store.reviewTopic(pending.id, {
    brandId: brand.id,
    decision: "approve",
    reason: "Confirmed duplicate of the reconciled existing draft",
    mergeWith: "canonical-event",
  });
  assert.equal(merged.id, "canonical-event");
  assert.deepEqual(store.get(submit.id), before);
  assert.equal(store.getTopic(pending.id)?.mergedIntoTopicId, merged.id);
  assert.equal(store.getTopic(pending.id)?.hasContent, true);
  assert.equal(store.getCandidate(extra.id)?.topicId, merged.id);
  assert.equal(store.listTopics({ brandId: brand.id }).length, 1);
  assert.equal(
    store.listTopics({ brandId: brand.id, includeMerged: true }).length,
    2,
  );
  assert.equal(
    store.enqueueForTopic(pending.id, job("must-not-exist", extra.input.url))
      .id,
    submit.id,
  );
  assert.equal(store.list().length, 1);
});

void test("recorded historical conflict IDs also block approvals when a model proposes a different business key", (t) => {
  const f = fixture(t);
  const store = f.open();
  const original = candidate(store, "name-original");
  store.saveSelection({
    brandId: brand.id,
    result: selection([original], "real-event"),
  });
  const originalJob = store.enqueueForTopic(
    "real-event",
    job("real-job", original.input.url),
  );
  const drifting = candidate(store, "name-drift");
  const proposal = selection([drifting], "review-name-drift", "needs_review");
  proposal.topics[0].identityKey = "review-name-drift";
  proposal.topics[0].conflictingTopicIds = ["real-event"];
  store.saveSelection({ brandId: brand.id, result: proposal });
  assert.throws(
    () =>
      store.reviewTopic("review-name-drift", {
        brandId: brand.id,
        decision: "approve",
        reason: "Different model spelling is not a distinct event",
      }),
    /explicitly merge/,
  );
  const merged = store.reviewTopic("review-name-drift", {
    brandId: brand.id,
    decision: "approve",
    reason: "Operator confirms same real event",
    mergeWith: "real-event",
  });
  assert.equal(merged.jobId, originalJob.id);
  assert.deepEqual(store.get(originalJob.id), originalJob);
});

void test("two uncertain proposals for the same new event cannot both be approved into separate jobs", (t) => {
  const f = fixture(t);
  const store = f.open();
  const a = candidate(store, "pending-a");
  const b = candidate(store, "pending-b");
  const first = selection([a], "review-a", "needs_review");
  const second = selection([b], "review-b", "needs_review");
  first.topics[0].identityKey = "review-a";
  second.topics[0].identityKey = "review-b";
  second.topics[0].identity = first.topics[0].identity;
  second.candidateDecisions[0].identity = first.topics[0].identity;
  store.saveSelection({
    brandId: brand.id,
    result: {
      candidateDecisions: [
        ...first.candidateDecisions,
        ...second.candidateDecisions,
      ],
      topics: [...first.topics, ...second.topics],
      modelCalls: 1,
      warnings: [],
    },
  });
  assert.equal(
    store.getTopic("review-a")?.proposedIdentityKey,
    store.getTopic("review-b")?.proposedIdentityKey,
  );
  store.reviewTopic("review-a", {
    brandId: brand.id,
    decision: "approve",
    reason: "Verified the first proposal",
  });
  const original = store.enqueueForTopic(
    "review-a",
    job("first-and-only-job", a.input.url),
  );
  assert.throws(
    () =>
      store.reviewTopic("review-b", {
        brandId: brand.id,
        decision: "approve",
        reason: "Second proposal is the same release",
      }),
    /already exists/,
  );
  assert.equal(store.getTopic("review-b")?.status, "needs_review");
  const merged = store.reviewTopic("review-b", {
    brandId: brand.id,
    decision: "approve",
    reason: "Confirmed duplicate of the first reviewed proposal",
    mergeWith: "review-a",
  });
  assert.equal(merged.jobId, original.id);
  assert.equal(store.list().length, 1);
});

void test("generation starts with the highest persisted topic score even when a lower score was queued first", (t) => {
  const f = fixture(t);
  const store = f.open();
  for (const [id, score] of [
    ["low", 35],
    ["high", 95],
  ] as const) {
    const item = candidate(store, id);
    const selected = selection([item], `topic-${id}`);
    selected.candidateDecisions[0].totalScore = score;
    selected.topics[0].sourceMetadata[0].totalScore = score;
    store.saveSelection({ brandId: brand.id, result: selected });
    store.enqueueForTopic(`topic-${id}`, job(`job-${id}`, item.input.url));
    f.advance(1);
  }
  assert.equal(
    store.claimGeneration({
      brandId: brand.id,
      workerId: "writer",
      leaseMs: 100,
    })?.id,
    "job-high",
  );
  assert.equal(
    store.claimGeneration({
      brandId: brand.id,
      workerId: "second-writer",
      leaseMs: 100,
    })?.id,
    "job-low",
  );
});

void test("approval rechecks durable source conflicts when two old proposals used different model names", (t) => {
  const f = fixture(t);
  const store = f.open();
  const items = store.upsertCandidates({
    brandId: brand.id,
    origin: "manual",
    primary: true,
    inputs: [
      {
        url: "https://example.com/shared-announcement",
        text: "SDK 1.0 first account",
      },
      {
        url: "https://example.com/shared-announcement",
        text: "SDK 1.0 another account",
      },
    ],
  });
  const first = selection([items[0]], "old-review-a", "needs_review");
  const second = selection([items[1]], "old-review-b", "needs_review");
  first.topics[0].identityKey = "old-review-a";
  second.topics[0].identityKey = "old-review-b";
  first.topics[0].identity.version = "1.0";
  second.topics[0].identity.version = "1.0";
  second.topics[0].identity.entity =
    "A different model-generated company spelling";
  store.saveSelection({
    brandId: brand.id,
    result: {
      candidateDecisions: [
        ...first.candidateDecisions,
        ...second.candidateDecisions,
      ],
      topics: [...first.topics, ...second.topics],
      modelCalls: 1,
      warnings: [],
    },
  });
  store.reviewTopic("old-review-a", {
    brandId: brand.id,
    decision: "approve",
    reason: "Verified the first account",
  });
  store.enqueueForTopic(
    "old-review-a",
    job("shared-event-job", items[0].input.url),
  );
  const writing = store.claimGeneration({ workerId: "writer", leaseMs: 100 });
  assert.ok(writing);
  store.completeGeneration(writing.id, writing.leaseToken, {
    post: "Original draft",
  });
  const submit = store.claimSubmit({ workerId: "publisher", leaseMs: 100 });
  assert.ok(submit);
  store.markUnknown(submit.id, submit.leaseToken, "Uncertain remote result");
  assert.throws(
    () =>
      store.reviewTopic("old-review-b", {
        brandId: brand.id,
        decision: "approve",
        reason: "Name drift is insufficient",
      }),
    /explicitly merge/,
  );
  assert.throws(
    () =>
      store.reviewTopic("old-review-b", {
        brandId: brand.id,
        decision: "approve",
        reason: "Cannot merge before reconciliation",
        mergeWith: "old-review-a",
      }),
    /Reconcile/,
  );
  assert.equal(store.list().length, 1);
  assert.equal(store.getTopic("old-review-b")?.status, "needs_review");
});
