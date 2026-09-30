import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { BrandKnowledgeStore } from "../brand-knowledge.js";
import {
  CONTENT_SCHEMA_VERSION,
  migrateContentDatabase,
} from "../migrations.js";
import type { ContentJob, EnqueueContentJob } from "../store.js";

const DAY = 86_400_000;
const START = Date.UTC(2026, 8, 30);

class TestStore extends BrandKnowledgeStore {
  get(_id: string): ContentJob | null {
    return null;
  }
  enqueue(_input: EnqueueContentJob): ContentJob {
    throw new Error("Unused in brand fact tests");
  }
}

function open(path = ":memory:") {
  let now = START;
  const db = new DatabaseSync(path);
  const migration = migrateContentDatabase(db, {
    databasePath: path,
    now: () => now,
  });
  const store = new TestStore(db, () => now);
  return {
    db,
    store,
    migration,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    claim: "The exact model is gemini-3.8-flash.",
    url: "https://example.com/models/gemini-3.8-flash",
    evidence: "Model Code: gemini-3.8-flash",
    keywords: ["gemini-3.8-flash"],
    category: "model",
    observedAt: START,
    expiresAt: START + 30 * DAY,
    ...overrides,
  };
}

void test("v10 migrates memory and disk databases without losing jobs, with a disk backup", (t) => {
  const memory = open();
  assert.equal(memory.migration.version, CONTENT_SCHEMA_VERSION);
  assert.equal(CONTENT_SCHEMA_VERSION, 10);
  memory.db.close();

  const dir = mkdtempSync(join(tmpdir(), "postiz-brand-knowledge-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "content.sqlite");
  const first = open(path);
  first.db
    .prepare(
      `INSERT INTO postiz_content_jobs
    (id,brand_id,content_fingerprint,input_json,state,mode,attempt_count,created_at,updated_at)
    VALUES ('old-job','tokenhot','old-fingerprint','{}','queued','draft',0,1,1)`,
    )
    .run();
  // Leave a real v8 migration history and task in place for the next open.
  first.db.exec(
    "DROP TABLE social_topic_intents; DROP TABLE social_provider_calls; DROP TABLE social_candidates; DROP TABLE social_observations; DROP TABLE brand_facts",
  );
  first.db.prepare("DELETE FROM schema_migrations WHERE version>=9").run();
  first.db.close();
  const second = open(path);
  assert.equal(
    second.db
      .prepare("SELECT id FROM postiz_content_jobs WHERE id='old-job'")
      .get()?.id,
    "old-job",
  );
  assert.ok(
    second.migration.backupPath && existsSync(second.migration.backupPath),
  );
  const fact = second.store.createBrandFact("tokenhot", input());
  second.db.close();
  const third = open(path);
  assert.deepEqual(third.store.listBrandFacts("tokenhot"), [fact]);
  assert.equal(third.migration.backupPath, null);
  third.db.close();
  assert.ok(existsSync(path));
});

void test("confirmation, content edits, retirement and expiry control matching with audit snapshots", () => {
  const { db, store, advance } = open();
  const source = [
    { url: "https://example.com/news", title: "gemini-3.8-flash released" },
  ];
  const pending = store.createBrandFact("tokenhot", input());
  assert.equal(pending.status, "pending");
  assert.deepEqual(store.matchBrandFacts("tokenhot", source), []);
  assert.throws(
    () => store.updateBrandFact("tokenhot", pending.id, { status: "verified" }),
    /reason/,
  );
  const verified = store.updateBrandFact("tokenhot", pending.id, {
    status: "verified",
    reason: "Checked official model page",
  });
  assert.equal(verified.verifiedAt, START);
  assert.deepEqual(store.matchBrandFacts("tokenhot", source), [verified]);
  const edited = store.updateBrandFact("tokenhot", pending.id, {
    claim: "Updated claim",
    reason: "Evidence changed",
  });
  assert.equal(edited.status, "pending");
  assert.equal(edited.verifiedAt, null);
  assert.deepEqual(store.matchBrandFacts("tokenhot", source), []);
  const reconfirmed = store.updateBrandFact("tokenhot", pending.id, {
    status: "verified",
    reason: "Rechecked",
  });
  assert.equal(reconfirmed.status, "verified");
  store.updateBrandFact("tokenhot", pending.id, {
    status: "retired",
    reason: "Withdrawn",
  });
  assert.deepEqual(store.matchBrandFacts("tokenhot", source), []);
  store.updateBrandFact("tokenhot", pending.id, {
    status: "verified",
    reason: "Rechecked again",
  });
  advance(30 * DAY);
  assert.deepEqual(store.matchBrandFacts("tokenhot", source), []);
  assert.throws(
    () =>
      store.updateBrandFact("tokenhot", pending.id, {
        status: "verified",
        reason: "Too late",
      }),
    /Expired/,
  );
  const events = db
    .prepare(
      "SELECT event_type,reason,before_json,after_json FROM audit_events WHERE brand_id='tokenhot' ORDER BY rowid",
    )
    .all();
  assert.equal(events.length, 6);
  assert.equal(events[0].before_json, "null");
  assert.equal(JSON.parse(String(events[1].before_json)).status, "pending");
  assert.equal(JSON.parse(String(events[1].after_json)).status, "verified");
  db.close();
});

void test("validation bounds URLs, text, terms, and category freshness", () => {
  const { db, store } = open();
  assert.throws(
    () =>
      store.createBrandFact(
        "tokenhot",
        input({ url: "http://localhost/secret" }),
      ),
    TypeError,
  );
  assert.throws(
    () => store.createBrandFact("tokenhot", input({ observedAt: START + 1 })),
    /future/,
  );
  assert.throws(() => store.createBrandFact("tokenhot", input({ claim: " " })));
  assert.throws(() =>
    store.createBrandFact(
      "tokenhot",
      input({ keywords: Array(13).fill("model") }),
    ),
  );
  assert.throws(() =>
    store.createBrandFact("tokenhot", input({ expiresAt: START + 91 * DAY })),
  );
  assert.throws(() =>
    store.createBrandFact(
      "tokenhot",
      input({ category: "pricing", expiresAt: START + 8 * DAY }),
    ),
  );
  const pending = store.createBrandFact(
    "tokenhot",
    input({ status: "verified" }),
  );
  assert.equal(pending.status, "pending");
  assert.throws(
    () =>
      store.updateBrandFact("tokenhot", pending.id, {
        observedAt: START + 1,
        reason: "Future observation",
      }),
    /future/,
  );
  assert.throws(
    () =>
      store.updateBrandFact("tokenhot", pending.id, {
        url: "http://localhost/secret",
        reason: "Bad URL",
      }),
    TypeError,
  );
  const expired = store.createBrandFact(
    "tokenhot",
    input({ expiresAt: START - 1, observedAt: START - DAY }),
  );
  assert.throws(
    () =>
      store.updateBrandFact("tokenhot", expired.id, {
        status: "verified",
        reason: "Confirm",
      }),
    /Expired/,
  );
  db.close();
});

void test("model matching requires an exact code or exact page; other categories match bounded phrases", () => {
  const { db, store } = open();
  const model = store.createBrandFact("tokenhot", input());
  const tts = store.createBrandFact(
    "tokenhot",
    input({
      claim: "The exact TTS model is gemini-3.8-flash-tts.",
      url: "https://example.com/models/gemini-3.8-flash-tts",
      evidence: "Model Code: gemini-3.8-flash-tts",
      keywords: ["gemini-3.8-flash-tts"],
    }),
  );
  const integration = store.createBrandFact(
    "tokenhot",
    input({
      claim: "An OpenAI SDK integration is documented.",
      url: "https://example.com/integration",
      evidence: "OpenAI SDK integration",
      keywords: ["OpenAI SDK"],
      category: "integration",
    }),
  );
  for (const fact of [model, tts, integration])
    store.updateBrandFact("tokenhot", fact.id, {
      status: "verified",
      reason: "Checked",
    });
  const source = (title: string, url = "https://example.com/news") => [
    { url, title },
  ];
  assert.deepEqual(
    store
      .matchBrandFacts("tokenhot", source("gemini-3.8-flash-tts"))
      .map((fact) => fact.id),
    [tts.id],
  );
  assert.deepEqual(
    store
      .matchBrandFacts("tokenhot", source("gemini-3.8-flash-tts."))
      .map((fact) => fact.id),
    [tts.id],
  );
  assert.deepEqual(
    store.matchBrandFacts("tokenhot", source("gemini-3.8-flash-tts-pro")),
    [],
  );
  assert.deepEqual(
    store.matchBrandFacts("tokenhot", source("gemini-3.8-flash-tts.pro")),
    [],
  );
  assert.deepEqual(
    store.matchBrandFacts("tokenhot", source("gemini-3.8-flash-lite")),
    [],
  );
  assert.deepEqual(
    store
      .matchBrandFacts("tokenhot", source("gemini-3.8-flash"))
      .map((fact) => fact.id),
    [model.id],
  );
  assert.deepEqual(
    store
      .matchBrandFacts("tokenhot", source("unrelated", model.url))
      .map((fact) => fact.id),
    [model.id],
  );
  assert.deepEqual(
    store.matchBrandFacts("tokenhot", source("OpenAI SDKs")),
    [],
  );
  assert.deepEqual(
    store
      .matchBrandFacts("tokenhot", source("OpenAI SDK update"))
      .map((fact) => fact.id),
    [integration.id],
  );
  const generic = store.createBrandFact(
    "tokenhot",
    input({
      claim: "Generic brand reference",
      keywords: ["tokenhot"],
      category: "feature",
    }),
  );
  store.updateBrandFact("tokenhot", generic.id, {
    status: "verified",
    reason: "Checked",
  });
  assert.deepEqual(
    store.matchBrandFacts("tokenhot", source("tokenhot announcement")),
    [],
  );
  db.close();
});

void test("Tokenhot seeds are pending, brand-scoped and idempotent without overwriting review", () => {
  const { db, store } = open();
  store.seedBrandFacts("another-brand");
  assert.deepEqual(store.listBrandFacts("another-brand"), []);
  store.seedBrandFacts("tokenhot");
  const initial = store.listBrandFacts("tokenhot");
  assert.equal(initial.length, 8);
  assert.ok(initial.every((fact) => fact.status === "pending"));
  const reviewed = store.updateBrandFact("tokenhot", initial[0].id, {
    status: "verified",
    reason: "Checked official documentation",
  });
  store.seedBrandFacts("tokenhot");
  assert.equal(store.listBrandFacts("tokenhot").length, 8);
  assert.equal(
    db
      .prepare(
        "SELECT count(*) AS total FROM audit_events WHERE event_type='brand_fact.seeded'",
      )
      .get()?.total,
    8,
  );
  assert.deepEqual(
    store.listBrandFacts("tokenhot").find((fact) => fact.id === reviewed.id),
    reviewed,
  );
  db.close();
});
