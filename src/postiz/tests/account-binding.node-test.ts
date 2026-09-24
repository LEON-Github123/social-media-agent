import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { ContentJobStore, JobConflictError } from "../store.js";

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "postiz-account-binding-"));
  const path = join(directory, "content.sqlite");
  const connections = new Set<ContentJobStore>();
  const open = () => {
    const store = new ContentJobStore(path, { now: () => 1000 });
    connections.add(store);
    return store;
  };
  const close = (store: ContentJobStore) => {
    store.close();
    connections.delete(store);
  };
  t.after(() => {
    for (const store of connections) store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { path, directory, open, close };
}

function job(id: string, brandId: string, integrationId?: string) {
  return {
    id,
    brandId,
    contentFingerprint: id,
    input: integrationId === undefined ? {} : { integrationId },
    mode: "draft" as const,
  };
}

void test("first binding protects candidate-only brands across restart and checks enqueue", (t) => {
  const f = fixture(t);
  const first = f.open();
  first.upsertCandidates({
    brandId: "tokenhot",
    origin: "manual",
    inputs: [{ url: "https://example.com/release", text: "Release facts" }],
  });
  first.bindBrandIntegration("tokenhot", "account-a");
  first.bindBrandIntegration("tokenhot", "account-a");
  assert.equal(
    first
      .listAuditEvents({ brandId: "tokenhot" })
      .filter((event) => event.eventType === "brand.integration_bound").length,
    1,
  );
  f.close(first);
  const reopened = f.open();
  assert.throws(
    () => reopened.bindBrandIntegration("tokenhot", "account-b"),
    JobConflictError,
  );
  assert.throws(
    () => reopened.enqueue(job("wrong", "tokenhot", "account-b")),
    JobConflictError,
  );
  assert.equal(reopened.list({ brandId: "tokenhot" }).length, 0);
  assert.equal(reopened.listCandidates({ brandId: "tokenhot" }).length, 1);
  reopened.enqueue(job("correct", "tokenhot", "account-a"));
  reopened.bindBrandIntegration("another-brand", "account-b");
  reopened.enqueue(job("other", "another-brand", "account-b"));
});

void test("first binding rejects invalid, mixed or mismatched legacy jobs without altering them", (t) => {
  const f = fixture(t);
  const store = f.open();
  store.enqueue(job("invalid", "invalid-brand"));
  store.enqueue(job("mixed-a", "mixed-brand", "account-a"));
  store.enqueue(job("mixed-b", "mixed-brand", "account-b"));
  store.enqueue(job("mismatch", "mismatch-brand", "account-a"));
  const before = store.list();
  for (const brandId of ["invalid-brand", "mixed-brand", "mismatch-brand"]) {
    assert.throws(
      () => store.bindBrandIntegration(brandId, "account-b"),
      JobConflictError,
    );
  }
  assert.deepEqual(store.list(), before);
  assert.equal(store.listAuditEvents().length, 0);
  store.bindBrandIntegration("mismatch-brand", "account-a");
  assert.throws(
    () => store.enqueue(job("new-wrong", "mismatch-brand", "account-b")),
    JobConflictError,
  );
});

void test("two connections cannot bind one brand to different accounts", (t) => {
  const f = fixture(t);
  const first = f.open();
  const second = f.open();
  first.bindBrandIntegration("tokenhot", "account-a");
  assert.throws(
    () => second.bindBrandIntegration("tokenhot", "account-b"),
    JobConflictError,
  );
  assert.equal(second.listAuditEvents({ brandId: "tokenhot" }).length, 1);
});

void test("racing processes can persist only one brand account binding", async (t) => {
  const f = fixture(t);
  const main = f.open();
  const compiledUrl = new URL("../store.js", import.meta.url);
  const moduleUrl = existsSync(compiledUrl)
    ? compiledUrl.href
    : new URL("../store.ts", import.meta.url).href;
  const barrier = new Int32Array(new SharedArrayBuffer(4));
  const workers: Worker[] = [];
  t.after(async () => {
    await Promise.all(workers.map((worker) => worker.terminate()));
  });
  let ready = 0;
  const results = await Promise.all(
    ["account-a", "account-b"].map(
      (account) =>
        new Promise<{ account: string; success: boolean }>(
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
                parentPort.postMessage({ ready: true });
                Atomics.wait(new Int32Array(workerData.barrier), 0, 0, 10000);
                let success = false;
                try {
                  store.bindBrandIntegration('tokenhot', workerData.account);
                  success = true;
                } finally {
                  store.close();
                }
                parentPort.postMessage({ account: workerData.account, success });
              })().catch(error => parentPort.postMessage({ account: workerData.account, success: false, error: String(error) }));
            `,
              {
                eval: true,
                workerData: {
                  path: f.path,
                  moduleUrl,
                  barrier: barrier.buffer,
                  account,
                },
              },
            );
            workers.push(worker);
            worker.once("error", reject);
            worker.on(
              "message",
              (message: {
                ready?: boolean;
                account?: string;
                success?: boolean;
                error?: string;
              }) => {
                if (message.ready) {
                  ready++;
                  if (ready === 2) {
                    Atomics.store(barrier, 0, 1);
                    Atomics.notify(barrier, 0, 2);
                  }
                } else if (message.account) {
                  if (
                    message.error &&
                    !message.error.includes("already bound")
                  ) {
                    reject(new Error(message.error));
                  } else {
                    resolve({
                      account: message.account,
                      success: message.success === true,
                    });
                  }
                }
              },
            );
          },
        ),
    ),
  );
  assert.equal(results.filter((result) => result.success).length, 1);
  const winner = results.find((result) => result.success)!.account;
  main.bindBrandIntegration("tokenhot", winner);
  assert.throws(
    () =>
      main.bindBrandIntegration(
        "tokenhot",
        winner === "account-a" ? "account-b" : "account-a",
      ),
    JobConflictError,
  );
  assert.equal(main.listAuditEvents({ brandId: "tokenhot" }).length, 1);
});

void test("version four upgrades with a consistent backup and keeps historical jobs", (t) => {
  const f = fixture(t);
  const initial = f.open();
  initial.enqueue(job("old", "tokenhot", "account-a"));
  f.close(initial);
  const raw = new DatabaseSync(f.path);
  raw.exec("DROP TABLE brand_integrations");
  raw.prepare("DELETE FROM schema_migrations WHERE version = 5").run();
  raw.close();
  const upgraded = f.open();
  assert.ok(upgraded.migrationBackupPath);
  assert.ok(existsSync(upgraded.migrationBackupPath));
  assert.ok(readdirSync(f.directory).some((name) => name.includes(".pre-v5-")));
  const backup = new DatabaseSync(upgraded.migrationBackupPath, {
    readOnly: true,
  });
  try {
    assert.equal(
      backup
        .prepare("SELECT input_json FROM postiz_content_jobs WHERE id='old'")
        .get()?.input_json,
      JSON.stringify({ integrationId: "account-a" }),
    );
    assert.equal(
      backup
        .prepare("SELECT 1 FROM sqlite_master WHERE name='brand_integrations'")
        .get(),
      undefined,
    );
  } finally {
    backup.close();
  }
  assert.equal(
    upgraded.get("old")?.input &&
      (upgraded.get("old")?.input as { integrationId: string }).integrationId,
    "account-a",
  );
  upgraded.bindBrandIntegration("tokenhot", "account-a");
  f.close(upgraded);
  assert.equal(f.open().migrationBackupPath, null);
});

void test("unknown receipt reconciliation is audited and refuses an existing receipt", (t) => {
  const f = fixture(t);
  const store = f.open();
  for (const id of ["one", "two"]) {
    store.enqueue(job(id, "tokenhot", "account-a"));
    const generation = store.claimGeneration({
      workerId: "writer",
      leaseMs: 100,
      jobId: id,
    });
    assert.ok(generation);
    store.completeGeneration(id, generation.leaseToken, { post: id });
    const submission = store.claimSubmit({
      workerId: "sender",
      leaseMs: 100,
      jobId: id,
    });
    assert.ok(submission);
    store.markUnknown(id, submission.leaseToken, "Response lost");
  }
  const before = store.get("one");
  const after = store.bindUnknown(
    "one",
    { postizId: "post-1" },
    {
      actor: "operator:alice",
      reason: "Verified against Postiz",
    },
  );
  const audit = store.listAuditEvents({ jobId: "one" });
  assert.equal(audit.length, 1);
  assert.equal(audit[0].eventType, "job.reconciled");
  assert.equal(audit[0].actor, "operator:alice");
  assert.equal(audit[0].reason, "Verified against Postiz");
  assert.deepEqual(audit[0].before, before);
  assert.deepEqual(audit[0].after, after);
  assert.throws(
    () => store.bindUnknown("two", { postizId: "post-1" }),
    JobConflictError,
  );
  assert.equal(store.get("two")?.state, "unknown");
  assert.equal(store.listAuditEvents({ jobId: "two" }).length, 0);
});
