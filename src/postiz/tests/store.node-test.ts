import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { Worker } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { CONTENT_SCHEMA_VERSION } from "../migrations.js";
import {
  ContentJobStore,
  JobConflictError,
  LeaseLostError,
  type EnqueueContentJob,
} from "../store.js";

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "postiz-content-store-"));
  const path = join(directory, "jobs.sqlite");
  const connections = new Set<ContentJobStore>();
  const rawConnections = new Set<DatabaseSync>();
  let clock = 1000;
  const open = () => {
    const store = new ContentJobStore(path, { now: () => clock });
    connections.add(store);
    return store;
  };
  const close = (store: ContentJobStore) => {
    store.close();
    connections.delete(store);
  };
  t.after(() => {
    for (const store of connections) store.close();
    for (const db of rawConnections) db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    path,
    open,
    close,
    raw: () => {
      const db = new DatabaseSync(path);
      rawConnections.add(db);
      return db;
    },
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

function request(id = "job-a", brandId = "brand-a"): EnqueueContentJob {
  return {
    id,
    brandId,
    contentFingerprint: `fingerprint-${id}`,
    mode: "draft",
    input: {
      source: "https://example.com/announcement",
      integrationId: `integration-${brandId}`,
    },
  };
}

function ready(store: ContentJobStore, id = "job-a", brandId = "brand-a") {
  store.enqueue(request(id, brandId));
  const claim = store.claimGeneration({
    workerId: "generator",
    leaseMs: 100,
    jobId: id,
    brandId,
  });
  assert.ok(claim);
  return store.completeGeneration(id, claim.leaseToken, {
    content: "A verified product update.",
  });
}

void test("jobs survive reopening and both stable ID and brand fingerprint prevent duplicates", (t) => {
  const f = fixture(t);
  const a = f.open();
  const input = request();
  const first = a.enqueue(input);
  assert.deepEqual(a.enqueue(input), first);
  assert.equal(
    a.enqueue({ ...input, id: "different-generated-id" }).id,
    first.id,
  );
  assert.throws(
    () => a.enqueue({ ...input, input: { changed: true } }),
    JobConflictError,
  );
  assert.throws(
    () => a.enqueue({ ...input, contentFingerprint: "new-fingerprint" }),
    JobConflictError,
  );
  a.enqueue({ ...input, id: "brand-b-job", brandId: "brand-b" });
  f.close(a);
  const b = f.open();
  assert.deepEqual(b.get(first.id), first);
  assert.equal(b.list().length, 2);
  assert.deepEqual(
    b.list({ brandId: "brand-b" }).map((job) => job.id),
    ["brand-b-job"],
  );
});

void test("two concurrent SQLite connections can claim the same job only once", async (t) => {
  const f = fixture(t);
  const store = f.open();
  store.enqueue(request());
  const flag = new SharedArrayBuffer(4);
  const barrier = new Int32Array(flag);
  const compiledUrl = new URL("../store.js", import.meta.url);
  const moduleUrl = existsSync(compiledUrl)
    ? compiledUrl.href
    : new URL("../store.ts", import.meta.url).href;
  const workers: Worker[] = [];
  let readyCount = 0;
  t.after(async () => {
    await Promise.all(workers.map((worker) => worker.terminate()));
  });
  const results = await Promise.all(
    ["worker-a", "worker-b"].map(
      (workerId) =>
        new Promise<{ id: string; leaseToken: string } | null>(
          (resolve, reject) => {
            const worker = new Worker(
              `
      const { parentPort, workerData } = require('node:worker_threads');
      (async () => {
        if (workerData.moduleUrl.endsWith('.ts')) {
          const { register } = await import('tsx/esm/api');
          register();
        }
        const { ContentJobStore } = await import(workerData.moduleUrl);
        const store = new ContentJobStore(workerData.path);
        const flag = new Int32Array(workerData.flag);
        parentPort.postMessage({ ready: true });
        Atomics.wait(flag, 0, 0, 10000);
        const job = store.claimGeneration({ workerId: workerData.workerId, leaseMs: 60000 });
        store.close();
        parentPort.postMessage({ result: job ? { id: job.id, leaseToken: job.leaseToken } : null });
      })().catch((error) => { throw error; });
    `,
              {
                eval: true,
                workerData: { path: f.path, moduleUrl, flag, workerId },
              },
            );
            workers.push(worker);
            worker.once("error", reject);
            worker.on(
              "message",
              (message: {
                ready?: boolean;
                result?: { id: string; leaseToken: string } | null;
              }) => {
                if (message.ready) {
                  readyCount++;
                  if (readyCount === 2) {
                    Atomics.store(barrier, 0, 1);
                    Atomics.notify(barrier, 0, 2);
                  }
                } else {
                  resolve(message.result ?? null);
                }
              },
            );
          },
        ),
    ),
  );
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(store.get("job-a")?.state, "processing");
  assert.equal(store.get("job-a")?.attemptCount, 1);
});

void test("both claim phases respect brand isolation even with an explicit other-brand job ID", (t) => {
  const f = fixture(t);
  const a = f.open();
  const b = f.open();
  a.enqueue(request("first", "brand-b"));
  a.enqueue(request("second", "brand-a"));
  assert.equal(
    b.claimGeneration({
      workerId: "a",
      leaseMs: 100,
      brandId: "brand-a",
      jobId: "first",
    }),
    null,
  );
  const claimed = b.claimGeneration({
    workerId: "a",
    leaseMs: 100,
    brandId: "brand-a",
  });
  assert.equal(claimed?.id, "second");
  assert.ok(claimed);
  b.completeGeneration(claimed.id, claimed.leaseToken, {
    content: "Only brand A.",
  });
  assert.equal(
    a.claimSubmit({
      workerId: "b",
      leaseMs: 100,
      brandId: "brand-b",
      jobId: "second",
    }),
    null,
  );
  assert.equal(
    a.claimSubmit({ workerId: "a", leaseMs: 100, brandId: "brand-a" })?.id,
    "second",
  );
});

void test("expired generation leases cannot finish, fail, renew, or overwrite a new owner", (t) => {
  const f = fixture(t);
  const a = f.open();
  const b = f.open();
  a.enqueue(request());
  const old = a.claimGeneration({ workerId: "old", leaseMs: 100 });
  assert.ok(old);
  f.advance(100);
  assert.throws(
    () => a.completeGeneration(old.id, old.leaseToken, {}),
    LeaseLostError,
  );
  assert.throws(
    () => a.failGeneration(old.id, old.leaseToken, "late failure"),
    LeaseLostError,
  );
  assert.throws(
    () => a.renewLease(old.id, old.leaseToken, 100),
    LeaseLostError,
  );
  assert.deepEqual(b.recoverExpired(), { generation: 1, submission: 0 });
  const current = b.claimGeneration({ workerId: "new", leaseMs: 100 });
  assert.ok(current);
  assert.notEqual(current.leaseToken, old.leaseToken);
  assert.throws(
    () => a.completeGeneration(old.id, old.leaseToken, { stale: true }),
    LeaseLostError,
  );
  b.completeGeneration(current.id, current.leaseToken, { current: true });
  assert.deepEqual(a.get(current.id)?.output, { current: true });
});

void test("heartbeats extend a live lease without permitting a stale token to renew", (t) => {
  const f = fixture(t);
  const store = f.open();
  store.enqueue(request());
  const claim = store.claimGeneration({ workerId: "generator", leaseMs: 100 });
  assert.ok(claim);
  f.advance(90);
  assert.equal(
    store.renewLease(claim.id, claim.leaseToken, 100).leaseExpiresAt,
    1190,
  );
  f.advance(20);
  assert.deepEqual(store.recoverExpired(), { generation: 0, submission: 0 });
  assert.throws(
    () => store.renewLease(claim.id, "wrong-token", 100),
    LeaseLostError,
  );
  assert.equal(
    store.completeGeneration(claim.id, claim.leaseToken, {}).state,
    "ready",
  );
});

void test("a crash after the submission claim becomes unknown and can never be automatically resubmitted", (t) => {
  const f = fixture(t);
  const a = f.open();
  ready(a);
  const claim = a.claimSubmit({ workerId: "publisher", leaseMs: 100 });
  assert.ok(claim);
  f.close(a);
  const b = f.open();
  assert.equal(b.get(claim.id)?.state, "submitting");
  f.advance(100);
  assert.throws(
    () =>
      b.recordSubmitted(claim.id, claim.leaseToken, { postizId: "may-exist" }),
    LeaseLostError,
  );
  assert.throws(
    () => b.markUnknown(claim.id, claim.leaseToken, "late"),
    LeaseLostError,
  );
  assert.deepEqual(b.recoverExpired(), { generation: 0, submission: 1 });
  assert.equal(b.get(claim.id)?.state, "unknown");
  assert.equal(b.claimSubmit({ workerId: "other", leaseMs: 100 }), null);
  assert.equal(b.claimGeneration({ workerId: "other", leaseMs: 100 }), null);
  assert.throws(() => b.retry(claim.id), JobConflictError);
  assert.equal(b.enqueue(request()).state, "unknown");
  assert.deepEqual(b.recoverExpired(), { generation: 0, submission: 0 });
});

void test("a Postiz accepted draft is submitted locally, not falsely marked as platform published", (t) => {
  const f = fixture(t);
  const store = f.open();
  ready(store);
  const claim = store.claimSubmit({ workerId: "publisher", leaseMs: 100 });
  assert.ok(claim);
  const accepted = store.recordSubmitted(claim.id, claim.leaseToken, {
    postizId: "postiz-1",
    postizState: "DRAFT",
  });
  assert.equal(accepted.state, "submitted");
  assert.equal(accepted.postizState, "DRAFT");
  assert.equal(accepted.platformPostId, null);
  assert.equal(accepted.platformUrl, null);
  assert.throws(
    () =>
      store.recordPlatformResult(claim.id, {
        postizId: "another-postiz-id",
        platformPostId: "x-1",
      }),
    JobConflictError,
  );
  store.recordPlatformResult(claim.id, {
    postizId: "postiz-1",
    postizState: "QUEUE",
  });
  const published = store.recordPlatformResult(claim.id, {
    postizId: "postiz-1",
    postizState: "PUBLISHED",
    platformPostId: "x-1",
    platformUrl: "https://x.com/example/status/x-1",
  });
  assert.equal(published.state, "submitted");
  assert.equal(published.postizState, "PUBLISHED");
  assert.equal(published.platformPostId, "x-1");
  assert.throws(
    () =>
      store.recordPlatformResult(claim.id, {
        postizId: "postiz-1",
        platformPostId: "x-2",
      }),
    JobConflictError,
  );
  assert.equal(
    store.recordPlatformResult(claim.id, {
      postizId: "postiz-1",
      postizState: "ERROR",
    }).platformPostId,
    "x-1",
  );
});

void test("an ambiguous response quarantines the job until an explicitly verified existing ID is bound", (t) => {
  const f = fixture(t);
  const store = f.open();
  ready(store);
  const claim = store.claimSubmit({ workerId: "publisher", leaseMs: 100 });
  assert.ok(claim);
  store.markUnknown(
    claim.id,
    claim.leaseToken,
    "Connection lost after request started",
  );
  assert.throws(() => store.retry(claim.id), JobConflictError);
  const bound = store.bindUnknown(claim.id, {
    postizId: "verified-postiz-id",
    postizState: "DRAFT",
  });
  assert.equal(bound.state, "submitted");
  assert.equal(bound.postizId, "verified-postiz-id");
  assert.equal(bound.platformPostId, null);
  assert.throws(
    () => store.bindUnknown(claim.id, { postizId: "other-id" }),
    JobConflictError,
  );
});

void test("oldest-updated ordering rotates submitted sync batches after recording platform results", (t) => {
  const f = fixture(t);
  const store = f.open();
  for (const id of ["one", "two", "three", "four"]) {
    if (id === "four") f.advance(86_400_000);
    ready(store, id);
    const claim = store.claimSubmit({
      workerId: "publisher",
      leaseMs: 100,
      jobId: id,
    });
    assert.ok(claim);
    store.recordSubmitted(id, claim.leaseToken, {
      postizId: `postiz-${id}`,
      postizState: "DRAFT",
    });
    f.advance(1);
  }
  const batch = store.list({
    state: "submitted",
    brandId: "brand-a",
    limit: 2,
    orderBy: "updatedAt",
  });
  assert.deepEqual(
    batch.map((job) => job.id),
    ["one", "two"],
  );
  f.advance(10);
  for (const job of batch) {
    assert.ok(job.postizId);
    store.recordPlatformResult(job.id, {
      postizId: job.postizId,
      postizState: "QUEUE",
    });
  }
  assert.deepEqual(
    store
      .list({ state: "submitted", limit: 2, orderBy: "updatedAt" })
      .map((job) => job.id),
    ["three", "four"],
  );
  assert.deepEqual(
    store.list({ state: "submitted", limit: 2 }).map((job) => job.id),
    ["one", "two"],
  );
  assert.throws(
    () =>
      store.list({
        orderBy: "updated_at; DROP TABLE postiz_content_jobs" as "updatedAt",
      }),
    /orderBy/,
  );
});

void test("missing remote results rotate after a sync check without inferring a provider state", (t) => {
  const f = fixture(t);
  const store = f.open();
  for (const id of ["one", "two", "three", "four"]) {
    if (id === "four") f.advance(86_400_000);
    ready(store, id);
    const claim = store.claimSubmit({
      workerId: "publisher",
      leaseMs: 100,
      jobId: id,
    });
    assert.ok(claim);
    store.recordSubmitted(id, claim.leaseToken, {
      postizId: `postiz-${id}`,
      postizState: "QUEUE",
    });
    f.advance(1);
  }
  const batch = store.list({
    state: "submitted",
    limit: 2,
    orderBy: "updatedAt",
  });
  assert.deepEqual(
    batch.map((job) => job.id),
    ["one", "two"],
  );
  f.advance(10);
  for (const before of batch) {
    const after = store.markSyncChecked(before.id);
    assert.ok(after.updatedAt > before.updatedAt);
    assert.deepEqual({ ...after, updatedAt: before.updatedAt }, before);
  }
  assert.deepEqual(
    store
      .list({ state: "submitted", limit: 2, orderBy: "updatedAt" })
      .map((job) => job.id),
    ["three", "four"],
  );
  store.enqueue(request("not-submitted"));
  assert.throws(() => store.markSyncChecked("not-submitted"), JobConflictError);
  assert.throws(
    () => store.markSyncChecked("missing-local-id"),
    JobConflictError,
  );
});

void test("definitive submission rejection requires explicit retry while rejected content is regenerated", (t) => {
  const f = fixture(t);
  const store = f.open();
  ready(store);
  const publish = store.claimSubmit({ workerId: "publisher", leaseMs: 100 });
  assert.ok(publish);
  store.failSubmission(
    publish.id,
    publish.leaseToken,
    "Provider rejected invalid payload before creation",
  );
  assert.equal(store.claimSubmit({ workerId: "other", leaseMs: 100 }), null);
  assert.equal(store.retry(publish.id).state, "ready");
  const retried = store.claimSubmit({ workerId: "other", leaseMs: 100 });
  assert.ok(retried);
  store.recordSubmitted(retried.id, retried.leaseToken, {
    postizId: "postiz-1",
  });

  store.enqueue(request("quality-failed"));
  const generation = store.claimGeneration({
    workerId: "generator",
    leaseMs: 100,
  });
  assert.ok(generation);
  store.completeGeneration(
    generation.id,
    generation.leaseToken,
    { reason: "Unsupported claim" },
    "rejected",
  );
  assert.equal(
    store.claimSubmit({ workerId: "publisher", leaseMs: 100 }),
    null,
  );
  const again = store.retry(generation.id);
  assert.equal(again.state, "queued");
  assert.equal(again.output, null);
  assert.equal(
    store.claimSubmit({ workerId: "publisher", leaseMs: 100 }),
    null,
  );
});

void test("one existing Postiz receipt cannot silently bind to two content jobs", (t) => {
  const f = fixture(t);
  const store = f.open();
  for (const id of ["one", "two"]) {
    ready(store, id);
    const claim = store.claimSubmit({
      workerId: "publisher",
      leaseMs: 100,
      jobId: id,
    });
    assert.ok(claim);
    store.markUnknown(id, claim.leaseToken, "unknown");
  }
  store.bindUnknown("one", { postizId: "verified-existing-id" });
  assert.throws(
    () => store.bindUnknown("two", { postizId: "verified-existing-id" }),
    /UNIQUE/,
  );
  assert.equal(store.get("two")?.state, "unknown");
});

void test("invalid scheduling and unsupported modes do not create content jobs", (t) => {
  const f = fixture(t);
  const store = f.open();
  assert.throws(
    () => store.enqueue({ ...request(), mode: "schedule" }),
    /scheduledAt/,
  );
  assert.throws(
    () => store.enqueue({ ...request(), scheduledAt: "invalid" }),
    /scheduledAt/,
  );
  assert.throws(
    () => store.enqueue({ ...request(), mode: "now" as "draft" }),
    /mode/,
  );
  assert.throws(
    () => store.enqueue({ ...request(), input: undefined }),
    /JSON serializable/,
  );
  assert.equal(store.list().length, 0);
  const scheduled = store.enqueue({
    ...request(),
    mode: "schedule",
    scheduledAt: "2026-10-01T08:30:00.000Z",
  });
  assert.equal(scheduled.scheduledAt, "2026-10-01T08:30:00.000Z");
});

function repairRequest(id = "repair-job"): EnqueueContentJob {
  return {
    ...request(id),
    mode: "schedule",
    scheduledAt: "2026-10-01T08:30:00.000Z",
    input: {
      brand: {
        id: "brand-a",
        name: "Tokenhot",
        audience: "Developers",
        businessContext: "AI tools for developers",
        contentRules: [],
        examples: [],
        language: "English",
        verifiedFacts: [],
        maxPostLength: 280,
      },
      sources: [
        { url: "https://example.com/release", text: "A documented release." },
      ],
      integrationId: "existing-account",
      mediaPaths: [],
    },
  };
}

void test("versioned migrations preserve every legacy state and create a WAL-consistent pre-upgrade backup", (t) => {
  const f = fixture(t);
  const initial = f.open();
  assert.equal(initial.migrationBackupPath, null);
  f.close(initial);
  const legacy = f.raw();
  legacy.exec("PRAGMA journal_mode = WAL;");
  // Recreate the original unversioned installation regardless of later tables.
  for (const row of legacy
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name != 'postiz_content_jobs' AND name NOT LIKE 'sqlite_%'",
    )
    .all()) {
    legacy.exec(`DROP TABLE "${String(row.name).replaceAll('"', '""')}"`);
  }
  const states = [
    "queued",
    "processing",
    "ready",
    "rejected",
    "submitting",
    "submitted",
    "unknown",
    "failed",
  ];
  for (const [index, state] of states.entries()) {
    legacy
      .prepare(
        `INSERT INTO postiz_content_jobs (
      id, brand_id, content_fingerprint, input_json, output_json, state, mode,
      scheduled_at, postiz_id, postiz_state, platform_post_id, platform_url,
      last_error, failure_phase, lease_token, lease_owner, lease_expires_at,
      attempt_count, created_at, updated_at
    ) VALUES (?, 'legacy-brand', ?, ?, ?, ?, 'schedule', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        state,
        `fingerprint-${state}`,
        JSON.stringify({ preserved: state }),
        JSON.stringify({ draft: state }),
        state,
        "2026-10-01T08:30:00Z",
        state === "submitted" ? "remote-123" : null,
        state === "submitted" ? "PUBLISHED" : null,
        state === "submitted" ? "platform-456" : null,
        state === "submitted" ? "https://x.com/example/status/456" : null,
        "Retained diagnostic",
        state === "failed" ? "generation" : null,
        ["processing", "submitting"].includes(state) ? `lease-${state}` : null,
        ["processing", "submitting"].includes(state) ? "worker" : null,
        ["processing", "submitting"].includes(state) ? 50000 : null,
        index + 1,
        100 + index,
        200 + index,
      );
  }
  const before = legacy
    .prepare("SELECT * FROM postiz_content_jobs ORDER BY id")
    .all();
  const upgraded = f.open();
  assert.ok(upgraded.migrationBackupPath);
  assert.ok(existsSync(upgraded.migrationBackupPath));
  assert.deepEqual(
    legacy.prepare("SELECT * FROM postiz_content_jobs ORDER BY id").all(),
    before,
  );
  assert.equal(
    legacy.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get()?.n,
    CONTENT_SCHEMA_VERSION,
  );
  assert.equal(upgraded.listAuditEvents().length, 0);
  const backup = new DatabaseSync(upgraded.migrationBackupPath, {
    readOnly: true,
  });
  try {
    assert.deepEqual(
      backup.prepare("SELECT * FROM postiz_content_jobs ORDER BY id").all(),
      before,
    );
    assert.equal(
      backup
        .prepare("SELECT 1 FROM sqlite_master WHERE name='schema_migrations'")
        .get(),
      undefined,
    );
  } finally {
    backup.close();
  }
  const reopened = f.open();
  assert.equal(reopened.migrationBackupPath, null);
  assert.equal(reopened.get("submitted")?.postizId, "remote-123");
});

void test("a database from a newer schema is rejected before migration or backup", (t) => {
  const f = fixture(t);
  const first = f.open();
  first.enqueue(request());
  f.close(first);
  const raw = new DatabaseSync(f.path);
  raw
    .prepare(
      "INSERT INTO schema_migrations(version,name,applied_at) VALUES (999,'future',0)",
    )
    .run();
  raw.close();
  assert.throws(() => f.open(), /newer than or incompatible/);
  assert.equal(
    readdirSync(join(f.path, "..")).filter((name) => name.includes(".pre-v"))
      .length,
    0,
  );
  const verify = new DatabaseSync(f.path, { readOnly: true });
  assert.equal(
    verify.prepare("SELECT COUNT(*) AS n FROM postiz_content_jobs").get()?.n,
    1,
  );
  verify.close();
});

void test("explicit repair refreshes a failed snapshot or draft mode without changing source identity and preserves an audit", (t) => {
  const f = fixture(t);
  const store = f.open();
  const input = repairRequest();
  store.enqueue(input);
  const claim = store.claimGeneration({ workerId: "old-worker", leaseMs: 100 });
  assert.ok(claim);
  store.completeGeneration(
    claim.id,
    claim.leaseToken,
    { oldDraft: "Requires repair" },
    "rejected",
  );
  const before = store.get(claim.id)!;
  const snapshot = {
    ...(input.input as { brand: Record<string, unknown> }).brand,
    businessContext: "Updated verified AI tooling context",
  };
  f.advance(5);
  const repaired = store.repairFailed(claim.id, {
    reason: "Refresh verified context and require draft review",
    actor: "operator:alice",
    brandSnapshot: snapshot,
    toDraft: true,
  });
  assert.equal(repaired.state, "queued");
  assert.equal(repaired.mode, "draft");
  assert.equal(repaired.scheduledAt, null);
  assert.equal(repaired.output, null);
  assert.equal(repaired.contentFingerprint, before.contentFingerprint);
  assert.equal(repaired.attemptCount, before.attemptCount);
  assert.equal(repaired.createdAt, before.createdAt);
  const finalInput = repaired.input as Record<string, unknown>;
  assert.deepEqual(finalInput.brand, snapshot);
  assert.deepEqual(
    finalInput.sources,
    (input.input as Record<string, unknown>).sources,
  );
  assert.equal(finalInput.integrationId, "existing-account");
  const [audit] = store.listAuditEvents({
    jobId: claim.id,
    brandId: "brand-a",
  });
  assert.deepEqual(audit.before, before);
  assert.deepEqual(audit.after, repaired);
  assert.equal(
    audit.reason,
    "Refresh verified context and require draft review",
  );
  assert.equal(audit.actor, "operator:alice");
  assert.equal(audit.eventType, "job.repaired");
  assert.throws(
    () => store.enqueue({ ...input, id: "new-id-for-same-source" }),
    JobConflictError,
  );
  assert.equal(store.list().length, 1);
  assert.equal(
    store.enqueue({
      ...input,
      id: "new-id-for-same-source",
      input: repaired.input,
      mode: "draft",
      scheduledAt: null,
    }).id,
    repaired.id,
  );
});

void test("repair and retry reject active or uncertain jobs and any stored provider receipt", (t) => {
  const f = fixture(t);
  const store = f.open();
  const raw = f.raw();
  for (const state of [
    "queued",
    "processing",
    "ready",
    "submitting",
    "submitted",
    "unknown",
  ]) {
    store.enqueue(repairRequest(state));
    raw
      .prepare("UPDATE postiz_content_jobs SET state = ? WHERE id = ?")
      .run(state, state);
    assert.throws(
      () =>
        store.repairFailed(state, { reason: "Cannot reset", toDraft: true }),
      JobConflictError,
    );
    assert.throws(() => store.retry(state), JobConflictError);
  }
  for (const [index, column] of [
    "postiz_id",
    "platform_post_id",
    "platform_url",
  ].entries()) {
    const id = `receipt-${index}`;
    store.enqueue(repairRequest(id));
    raw
      .prepare(
        `UPDATE postiz_content_jobs SET state = 'failed', ${column} = ? WHERE id = ?`,
      )
      .run(`known-${index}`, id);
    assert.throws(
      () =>
        store.repairFailed(id, { reason: "Must keep receipt", toDraft: true }),
      JobConflictError,
    );
    assert.throws(() => store.retry(id), JobConflictError);
  }
  assert.equal(store.listAuditEvents().length, 0);
});

void test("invalid repaired brands or sources and failed audit writes leave the job unchanged", (t) => {
  const f = fixture(t);
  const store = f.open();
  store.enqueue(repairRequest());
  const claim = store.claimGeneration({ workerId: "worker", leaseMs: 100 });
  assert.ok(claim);
  const before = store.failGeneration(
    claim.id,
    claim.leaseToken,
    "Draft-only mode blocks old schedule",
  );
  assert.throws(
    () =>
      store.repairFailed(claim.id, {
        reason: "Wrong brand",
        brandSnapshot: { id: "other-brand" },
      }),
    JobConflictError,
  );
  assert.throws(() =>
    store.repairFailed(claim.id, {
      reason: "Incomplete brand",
      brandSnapshot: { id: "brand-a" },
    }),
  );
  assert.throws(
    () =>
      store.repairFailed(claim.id, {
        reason: "Audit actor invalid",
        actor: "",
        toDraft: true,
      }),
    /actor/,
  );
  assert.deepEqual(store.get(claim.id), before);
  assert.equal(store.listAuditEvents().length, 0);
  const raw = new DatabaseSync(f.path);
  const invalid = {
    ...(before.input as Record<string, unknown>),
    sources: [{ url: "http://127.0.0.1/private" }],
  };
  raw
    .prepare("UPDATE postiz_content_jobs SET input_json = ? WHERE id = ?")
    .run(JSON.stringify(invalid), claim.id);
  raw.close();
  assert.throws(() =>
    store.repairFailed(claim.id, {
      reason: "Mode-only still checks sources",
      toDraft: true,
    }),
  );
  assert.equal(store.get(claim.id)?.state, "failed");
  assert.equal(store.get(claim.id)?.mode, "schedule");
});
