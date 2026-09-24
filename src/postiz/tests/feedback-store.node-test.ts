import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import {
  ContentJobStore,
  JobConflictError,
  type PostizObservationInput,
} from "../store.js";

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "postiz-feedback-"));
  const path = join(dir, "content.sqlite");
  let now = Date.parse("2026-09-24T09:00:00Z");
  const stores = new Set<ContentJobStore>();
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
    advance: (ms: number) => {
      now += ms;
    },
  };
}
function queued(
  store: ContentJobStore,
  id = "content-job",
  brandId = "tokenhot",
) {
  return store.enqueue({
    id,
    brandId,
    contentFingerprint: id,
    mode: "draft",
    input: { source: "https://example.com/release" },
  });
}
function submitted(store: ContentJobStore) {
  const job = queued(store);
  const claim = store.claimGeneration({ workerId: "writer", leaseMs: 100 });
  assert.ok(claim);
  store.completeGeneration(job.id, claim.leaseToken, {
    post: "Original approved draft",
    quality: { approved: true },
    report: "Original report",
  });
  const submit = store.claimSubmit({ workerId: "publisher", leaseMs: 100 });
  assert.ok(submit);
  return store.recordSubmitted(job.id, submit.leaseToken, {
    postizId: "postiz-draft",
    postizState: "DRAFT",
  });
}
const snapshot: PostizObservationInput = {
  brandId: "tokenhot",
  jobId: "content-job",
  postizId: "postiz-draft",
  postizState: "DRAFT",
  content: "Original approved draft",
  scheduledAt: null,
  platformPostId: null,
  platformUrl: null,
};

void test("observations append only actual changes, order same-millisecond snapshots, and never overwrite original job data", (t) => {
  const f = fixture(t);
  const store = f.open();
  const before = submitted(store);
  const first = store.observePostiz(snapshot);
  assert.deepEqual(store.observePostiz(snapshot), first);
  const edited = store.observePostiz({
    ...snapshot,
    content: "Human edited this draft",
  });
  const reverted = store.observePostiz(snapshot);
  assert.notEqual(edited.id, first.id);
  assert.notEqual(reverted.id, first.id);
  assert.equal(first.observedAt, edited.observedAt);
  assert.equal(edited.observedAt, reverted.observedAt);
  assert.ok(
    first.sequence < edited.sequence && edited.sequence < reverted.sequence,
  );
  assert.equal(store.listObservations({ brandId: "tokenhot" }).length, 3);
  assert.deepEqual(store.get(before.id), before);
  f.advance(1);
  const scheduled = store.observePostiz({
    ...snapshot,
    postizState: "QUEUE",
    scheduledAt: "2026-10-01T16:30:00+08:00",
  });
  assert.equal(scheduled.scheduledAt, "2026-10-01T08:30:00.000Z");
  const published = store.observePostiz({
    ...snapshot,
    postizState: "PUBLISHED",
    platformPostId: "123",
    platformUrl: "https://x.com/account/status/123",
  });
  assert.equal(published.platformPostId, "123");
  assert.equal(store.get(before.id)?.postizState, "DRAFT");
  assert.equal(store.get(before.id)?.platformPostId, null);
  assert.deepEqual(store.get(before.id)?.output, before.output);
  assert.equal(store.listObservations({ brandId: "other-brand" }).length, 0);
  assert.equal(
    store.listObservations({ brandId: "tokenhot", since: scheduled.observedAt })
      .length,
    2,
  );
});

void test("observations require an exact submitted receipt and reject conflicting identities before writing history", (t) => {
  const f = fixture(t);
  const store = f.open();
  const job = queued(store);
  assert.throws(() => store.observePostiz(snapshot), JobConflictError);
  const claim = store.claimGeneration({ workerId: "writer", leaseMs: 100 });
  assert.ok(claim);
  store.completeGeneration(job.id, claim.leaseToken, { post: "Original" });
  const submit = store.claimSubmit({ workerId: "publisher", leaseMs: 100 });
  assert.ok(submit);
  store.markUnknown(job.id, submit.leaseToken, "Uncertain result");
  assert.throws(() => store.observePostiz(snapshot), JobConflictError);
  store.bindUnknown(job.id, {
    postizId: "postiz-draft",
    platformPostId: "123",
    postizState: "PUBLISHED",
  });
  assert.throws(
    () => store.observePostiz({ ...snapshot, brandId: "wrong-brand" }),
    JobConflictError,
  );
  assert.throws(
    () => store.observePostiz({ ...snapshot, postizId: "wrong-remote-id" }),
    JobConflictError,
  );
  assert.throws(
    () => store.observePostiz({ ...snapshot, platformPostId: "999" }),
    JobConflictError,
  );
  assert.throws(
    () =>
      store.observePostiz({ ...snapshot, scheduledAt: "2026-10-01T12:00:00" }),
    /timezone/,
  );
  assert.throws(() =>
    store.observePostiz({ ...snapshot, platformUrl: "javascript:alert(1)" }),
  );
  assert.equal(store.listObservations({ brandId: "tokenhot" }).length, 0);
});

void test("feedback preserves the reviewed output and state, records before data, and rolls back if audit insertion fails", (t) => {
  const f = fixture(t);
  const store = f.open();
  const before = submitted(store);
  const edit = store.recordFeedback({
    brandId: "tokenhot",
    jobId: before.id,
    kind: "edit",
    reason: "Shortened the introduction in Postiz",
    actor: "operator:alice",
  });
  store.recordFeedback({
    brandId: "tokenhot",
    jobId: before.id,
    kind: "reject",
    reason: "The example did not fit the audience",
  });
  store.recordFeedback({
    brandId: "tokenhot",
    jobId: before.id,
    kind: "note",
    reason: "Review the next similar release manually",
  });
  assert.deepEqual(store.get(before.id), before);
  const events = store.listAuditEvents({ jobId: before.id });
  assert.deepEqual(events[0].before, before);
  assert.deepEqual(events[0].after, edit);
  assert.equal(
    store.listFeedback({ brandId: "tokenhot", jobId: before.id }).length,
    3,
  );
  assert.throws(
    () =>
      store.recordFeedback({
        brandId: "other-brand",
        jobId: before.id,
        kind: "note",
        reason: "Wrong brand",
      }),
    JobConflictError,
  );
  assert.throws(
    () =>
      store.recordFeedback({
        brandId: "tokenhot",
        jobId: before.id,
        kind: "note",
        reason: "",
      }),
    /reason/,
  );
  const raw = new DatabaseSync(f.path);
  raw.exec(
    "CREATE TRIGGER test_feedback_audit_failure BEFORE INSERT ON audit_events WHEN NEW.event_type='feedback.recorded' BEGIN SELECT RAISE(ABORT,'audit unavailable'); END;",
  );
  assert.throws(
    () =>
      store.recordFeedback({
        brandId: "tokenhot",
        jobId: before.id,
        kind: "note",
        reason: "Must roll back too",
      }),
    /audit unavailable/,
  );
  raw.close();
  assert.equal(store.listFeedback({ brandId: "tokenhot" }).length, 3);
  assert.equal(store.listAuditEvents({ jobId: before.id }).length, 3);
  f.close(store);
  const reopened = f.open();
  assert.equal(
    reopened.listFeedback({ brandId: "tokenhot" })[0].actor,
    "operator:alice",
  );
});

void test("writing calls count real stages independently from daily starts and persist before a failed request", (t) => {
  const f = fixture(t);
  const store = f.open();
  const job = queued(store);
  assert.ok(store.claimGeneration({ workerId: "writer", leaseMs: 100 }));
  for (const task of ["relevance", "report", "post", "quality"] as const)
    store.recordWritingModelCall({ brandId: "tokenhot", jobId: job.id, task });
  assert.ok(
    store.reserveGenerationAttempt({ brandId: "tokenhot", kind: "preview" }),
  );
  store.recordWritingModelCall({ brandId: "tokenhot", task: "relevance" });
  assert.throws(
    () =>
      store.recordWritingModelCall({
        brandId: "other",
        jobId: job.id,
        task: "post",
      }),
    JobConflictError,
  );
  assert.throws(
    () =>
      store.recordWritingModelCall({
        brandId: "tokenhot",
        task: "selection" as "post",
      }),
    /Invalid writing/,
  );
  assert.equal(store.getGenerationQuota({ brandId: "tokenhot" }).used, 2);
  f.close(store);
  const reopened = f.open();
  assert.equal(
    reopened.listWritingModelCalls({ brandId: "tokenhot" }).length,
    5,
  );
  assert.equal(
    reopened.listWritingModelCalls({ brandId: "tokenhot", jobId: job.id })
      .length,
    4,
  );
  assert.equal(reopened.listWritingModelCalls({ brandId: "other" }).length, 0);
  assert.equal(
    reopened.listGenerationAttempts({ brandId: "tokenhot" }).length,
    2,
  );
});

void test("upgrading version three preserves prior jobs and daily reservations in a consistent backup", (t) => {
  const f = fixture(t);
  const first = f.open();
  const original = submitted(first);
  const attempts = first.listGenerationAttempts({ brandId: "tokenhot" });
  f.close(first);
  const previous = new DatabaseSync(f.path);
  previous.exec(
    "DROP TABLE brand_integrations; DROP TABLE content_feedback; DROP TABLE postiz_observations; DROP TABLE writing_model_calls; DELETE FROM schema_migrations WHERE version>=4;",
  );
  previous.close();
  const upgraded = f.open();
  assert.ok(upgraded.migrationBackupPath);
  assert.deepEqual(upgraded.get(original.id), original);
  assert.deepEqual(
    upgraded.listGenerationAttempts({ brandId: "tokenhot" }),
    attempts,
  );
  assert.deepEqual(upgraded.listObservations({ brandId: "tokenhot" }), []);
  assert.deepEqual(upgraded.listFeedback({ brandId: "tokenhot" }), []);
  const backup = new DatabaseSync(upgraded.migrationBackupPath, {
    readOnly: true,
  });
  assert.equal(
    backup.prepare("SELECT MAX(version) AS v FROM schema_migrations").get()?.v,
    3,
  );
  assert.equal(
    backup
      .prepare("SELECT postiz_id FROM postiz_content_jobs WHERE id=?")
      .get(original.id)?.postiz_id,
    original.postizId,
  );
  backup.close();
});
