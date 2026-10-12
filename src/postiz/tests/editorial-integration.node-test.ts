import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { createServer } from "node:net";
import { ContentJobStore } from "../store.js";
import { JobConflictError } from "../store-errors.js";
import { readConfig } from "../config.js";
import { Workbench, createWorkbenchHttp } from "../workbench.js";
import { runWorkbenchTick } from "../workbench-runtime.js";
import { selectSocialCandidates } from "../social-selector.js";
import { generateContent, validatePost } from "../content.js";
import {
  validateBrand,
  validateContentInput,
  validateJobInput,
} from "../validation.js";
import { enqueueApprovedTopics } from "../pipeline.js";
import { withEditorialPreferences } from "../editorial-preferences.js";
import type { EditorialPreferences } from "../editorial-types.js";
import type { ModelRequest } from "../models.js";

const initialTime = Date.parse("2026-10-06T01:00:00Z");
const brand = validateBrand({
  id: "editorial-test",
  name: "Example API",
  audience: "developers",
  businessContext: "Practical API engineering",
  language: "English",
});
const guidance = {
  selectionGuidance: "Prefer concrete API integration tradeoffs",
  writingGuidance: "Explain one practical step with direct verbs",
  examples: [
    "Example API supports every model for $0.01: https://invalid.example/claim",
  ],
};
const saveBody = { expectedVersion: 0, ...guidance, confirmed: true };

class FixtureStore extends ContentJobStore {
  approvalSnapshot(topicId: string): {
    brand: { editorialPreferences?: EditorialPreferences };
  } {
    const row = this.db
      .prepare(
        "SELECT approval_snapshot_json FROM social_topic_intents WHERE topic_id=?",
      )
      .get(topicId);
    assert.ok(row);
    return JSON.parse(String(row.approval_snapshot_json));
  }
}

async function fixture(t: test.TestContext, requiresBrandFacts = false) {
  let clock = initialTime;
  const store = new FixtureStore(":memory:", { now: () => clock });
  t.after(() => store.close());
  const [candidate] = store.upsertCandidates({
    brandId: brand.id,
    origin: "twitterapi-user",
    sourceId: "competitor",
    inputs: [
      {
        url: "https://x.com/example/status/123",
        text: "Compare retry policies before changing providers.",
        publishedAt: new Date(clock - 3600000).toISOString(),
      },
    ],
  });
  assert.ok(candidate.input.text);
  const document = { ...candidate.input, text: candidate.input.text };
  const social = {
    tweetId: "123",
    authorId: "example",
    authorHandle: "example",
    authorName: "Example",
    postType: "original" as const,
    quotedTweetId: null,
    publishedAt: candidate.input.publishedAt!,
    observedAt: clock,
    views: 1000,
    likes: 20,
    replies: 1,
    reposts: 2,
    quotes: 0,
    bookmarks: null,
  };
  store.recordSocialObservation(candidate.id, social);
  store.recordCandidateDocument(candidate.id, document);
  store.beginSocialEvaluation([candidate.id]);
  const decision = {
    candidateId: candidate.id,
    title: "比较 API 重试策略",
    summary: "比较重试策略",
    reason: "开发者实用观点",
    angle: requiresBrandFacts ? "Example API 的重试能力" : "比较重试策略",
    factGaps: requiresBrandFacts ? ["品牌重试能力依据"] : [],
    relevance: 85,
    reusability: 80,
    kind: "creative",
    requiresBrandFacts,
    excludedReason: null,
    identity: null,
    identityEvidence: null,
    certainty: "confirmed",
  };
  const selectionInput = {
    brand,
    candidates: [
      {
        ...document,
        id: candidate.id,
        primary: false,
        firstSeenAt: clock,
        social,
      },
    ],
    history: [],
    now: clock,
  };
  const result = await selectSocialCandidates(selectionInput, {
    model: { invoke: async () => JSON.stringify({ decisions: [decision] }) },
  });
  assert.deepEqual(result.failures, []);
  store.saveSocialSelection(brand.id, result);
  const topic = store.getTopic(store.getCandidate(candidate.id)!.topicId!)!;
  assert.ok(topic);
  const config = {
    ...readConfig({
      CONTENT_MODEL: "fixture",
      CONTENT_MODEL_API_KEY: "fixture",
      POSTIZ_API_KEY: "fixture",
      POSTIZ_INTEGRATION_ID: "test",
    }),
    competitorMode: true,
  };
  let modelCalls = 0;
  const model = () => {
    modelCalls++;
    throw new Error("Editorial actions must not call a model");
  };
  const client = () => {
    throw new Error("Editorial actions must not call Postiz");
  };
  const workbench = new Workbench({
    store,
    brand,
    config,
    postizUrl: "https://postiz.example",
    model,
    client,
  });
  return {
    store,
    candidate,
    topic,
    workbench,
    config,
    model,
    client,
    selectionInput,
    decision,
    setClock: (value: number) => {
      clock = value;
    },
    modelCalls: () => modelCalls,
  };
}

void test("preference API requires explicit confirmation, bounded fields and matching version", async (t) => {
  const { workbench, store } = await fixture(t);
  for (const body of [
    { ...saveBody, confirmed: undefined },
    { ...saveBody, confirmed: false },
    { ...saveBody, selectionGuidance: "x".repeat(1201) },
    { ...saveBody, writingGuidance: "x".repeat(1201) },
    { ...saveBody, examples: ["x".repeat(601)] },
    { ...saveBody, examples: ["a", "b", "c", "d"] },
  ])
    await assert.rejects(workbench.mutate("/api/editorial/preferences", body));
  assert.equal(store.getEditorialPreferences(brand.id).version, 0);
  await workbench.mutate("/api/editorial/preferences", saveBody);
  await assert.rejects(
    workbench.mutate("/api/editorial/preferences", saveBody),
    JobConflictError,
  );
  assert.equal(store.getEditorialPreferences(brand.id).version, 1);
});

void test("feedback and seen are explicit, brand isolated, and never apply preferences or consume quota", async (t) => {
  const { store, workbench, candidate, modelCalls } = await fixture(t);
  const quota = store.socialQuotas(brand.id);
  await workbench.mutate(`/api/social-candidates/${candidate.id}/feedback`, {
    tag: "good_expression",
    note: "Clear and useful",
  });
  assert.equal(
    store.getEditorialDashboard(brand.id).feedbackSummary.uniqueCandidates,
    1,
  );
  assert.equal(store.getEditorialPreferences(brand.id).version, 0);
  assert.equal(store.list({ brandId: brand.id }).length, 0);
  assert.equal(store.listGenerationAttempts({ brandId: brand.id }).length, 0);
  assert.deepEqual(store.socialQuotas(brand.id), quota);
  assert.equal(modelCalls(), 0);
  await workbench.mutate(`/api/social-candidates/${candidate.id}/seen`, {});
  const seen = store
    .listSocialStates(brand.id)
    .find((item) => item.candidateId === candidate.id)!.editorial!.seenAt;
  assert.equal(seen, initialTime);
  const [foreign] = store.upsertCandidates({
    brandId: "other-brand",
    origin: "twitterapi-user",
    sourceId: "competitor",
    inputs: [
      { url: "https://x.com/other/status/456", text: "Foreign material" },
    ],
  });
  for (const [action, body] of [
    ["feedback", { tag: "useful_topic" }],
    ["seen", {}],
    ["snooze", { days: 1, reason: "wait" }],
  ] as const)
    await assert.rejects(
      workbench.mutate(`/api/social-candidates/${foreign.id}/${action}`, body),
      JobConflictError,
    );
  assert.equal(
    store.getEditorialDashboard(brand.id).feedbackSummary.uniqueCandidates,
    1,
  );
});

void test("new approval freezes confirmed preferences; later edits and clearing cannot mutate it", async (t) => {
  const { workbench, store, topic } = await fixture(t);
  assert.equal(
    withEditorialPreferences(brand, store.getEditorialPreferences(brand.id))
      .editorialPreferences,
    undefined,
  );
  await workbench.mutate("/api/editorial/preferences", saveBody);
  await workbench.mutate(`/api/topics/${topic.id}/review`, {
    decision: "approve",
    reason: "Concrete general advice",
    writingAngle: "Compare retry policies",
    writingScope: "general",
  });
  const frozen = store.approvalSnapshot(topic.id);
  assert.deepEqual(frozen.brand.editorialPreferences, {
    version: 1,
    ...guidance,
  });
  const intent = store.getTopicIntent(topic.id);
  await workbench.mutate("/api/editorial/preferences", {
    ...saveBody,
    expectedVersion: 1,
    writingGuidance: "New style",
  });
  await workbench.mutate("/api/editorial/preferences", {
    expectedVersion: 2,
    selectionGuidance: "",
    writingGuidance: "",
    examples: [],
    confirmed: true,
  });
  assert.deepEqual(store.approvalSnapshot(topic.id), frozen);
  assert.deepEqual(store.getTopicIntent(topic.id), intent);
  const cleared = store.getEditorialPreferences(brand.id);
  assert.deepEqual(cleared, {
    version: 3,
    selectionGuidance: "",
    writingGuidance: "",
    examples: [],
  });
  assert.deepEqual(
    withEditorialPreferences(brand, cleared).editorialPreferences,
    cleared,
  );
});

void test("delayed enqueue preserves the preference version confirmed at social approval", async (t) => {
  const { workbench, store, topic, modelCalls } = await fixture(t);
  await workbench.mutate("/api/editorial/preferences", saveBody);
  await workbench.mutate(`/api/topics/${topic.id}/review`, {
    decision: "approve",
    reason: "Approve the current direction",
    writingAngle: "Compare retry policies",
    writingScope: "general",
  });
  await workbench.mutate("/api/editorial/preferences", {
    ...saveBody,
    expectedVersion: 1,
    selectionGuidance: "Prefer a different topic",
    writingGuidance: "Use a different style",
    examples: ["A different example"],
  });
  const latest = withEditorialPreferences(
    brand,
    store.getEditorialPreferences(brand.id),
  );
  assert.equal(latest.editorialPreferences?.version, 2);
  const result = enqueueApprovedTopics({
    store,
    brand: latest,
    integrationId: "test",
  });
  assert.equal(result.queued, 1);
  assert.deepEqual(result.warnings, []);
  const job = store.get(topic.id);
  assert.ok(job);
  assert.deepEqual(validateJobInput(job.input).brand.editorialPreferences, {
    version: 1,
    ...guidance,
  });
  assert.equal(modelCalls(), 0);
  assert.equal(store.listGenerationAttempts({ brandId: brand.id }).length, 0);
});

void test("delayed enqueue cannot apply a new profile to a social topic approved without preferences", async (t) => {
  const { workbench, store, topic, modelCalls } = await fixture(t);
  await workbench.mutate(`/api/topics/${topic.id}/review`, {
    decision: "approve",
    reason: "Approve without editorial preferences",
    writingAngle: "Compare retry policies",
    writingScope: "general",
  });
  assert.equal(
    store.approvalSnapshot(topic.id).brand.editorialPreferences,
    undefined,
  );
  await workbench.mutate("/api/editorial/preferences", saveBody);
  const latest = withEditorialPreferences(
    brand,
    store.getEditorialPreferences(brand.id),
  );
  assert.equal(latest.editorialPreferences?.version, 1);
  const result = enqueueApprovedTopics({
    store,
    brand: latest,
    integrationId: "test",
  });
  assert.equal(result.queued, 1);
  assert.deepEqual(result.warnings, []);
  const job = store.get(topic.id);
  assert.ok(job);
  assert.equal(
    validateJobInput(job.input).brand.editorialPreferences,
    undefined,
  );
  assert.equal(modelCalls(), 0);
  assert.equal(store.listGenerationAttempts({ brandId: brand.id }).length, 0);
});

void test("selection uses confirmed guidance as direction, never as verified facts", async (t) => {
  const { workbench, store, selectionInput, decision } = await fixture(t);
  await workbench.mutate("/api/editorial/preferences", saveBody);
  const calls: ModelRequest[] = [];
  await selectSocialCandidates(
    {
      ...selectionInput,
      brand: withEditorialPreferences(
        brand,
        store.getEditorialPreferences(brand.id),
      ),
    },
    {
      model: {
        invoke: async (request) => {
          calls.push(request);
          return JSON.stringify({ decisions: [decision] });
        },
      },
    },
  );
  assert.equal(calls.length, 1);
  assert.match(calls[0].system, /Confirmed selection guidance/);
  assert.ok(calls[0].system.includes(guidance.selectionGuidance));
  assert.match(calls[0].system, /never factual evidence/);
  assert.match(calls[0].system, /never override verifiedFacts/);
  assert.match(calls[0].system, /"verifiedFacts":\[\]/);
});

void test("all writing stages receive profile and non-factual boundaries; examples cannot unlock brand preflight", async () => {
  const profile = { version: 1, ...guidance };
  const configured = withEditorialPreferences(brand, profile);
  const input = validateContentInput({
    brand: configured,
    sources: [
      {
        url: "https://source.example/docs",
        text: "Compare retry policies before changing providers.",
      },
    ],
    purpose: "brand_original",
    writingAngle: "Compare retry policies",
    writingScope: "general",
    inspirationRequiresFacts: false,
  });
  const calls: ModelRequest[] = [];
  const outputs = [
    '{"relevant":true,"reasoning":"实用观点"}',
    "<report>比较重试策略。</report>",
    "<post>Compare retry policies before changing providers.</post>",
    '{"approved":true,"reasons":[]}',
  ];
  const result = await generateContent(input, {
    model: {
      invoke: async (request) => {
        calls.push(request);
        return outputs[calls.length - 1];
      },
    },
  });
  assert.equal(result.quality.approved, true);
  assert.deepEqual(
    calls.map((request) => request.task),
    ["relevance", "report", "post", "quality"],
  );
  for (const request of calls) {
    assert.ok(request.system.includes(JSON.stringify(profile)));
    assert.match(request.system, /never factual evidence/);
    assert.match(request.system, /never override verifiedFacts/);
    assert.match(request.system, /must not be copied or treated as facts/);
    assert.match(request.system, /Writing scope: general/);
  }
  assert.ok(
    validatePost("Example API supports every model for $0.01.", input).length >
      0,
  );
  const blocked = await generateContent(
    { ...input, writingScope: undefined, inspirationRequiresFacts: true },
    {
      model: {
        invoke: async () => {
          throw new Error("Missing facts must stop before model calls");
        },
      },
    },
  );
  assert.equal(blocked.relevant, false);
  assert.match(blocked.reasoning, /需要已核实的品牌事实/);
});

void test("confirmed preferences and examples cannot bypass workbench brand readiness", async (t) => {
  const { workbench, store, topic, modelCalls } = await fixture(t, true);
  await workbench.mutate("/api/editorial/preferences", saveBody);
  const readiness = await workbench.mutate(
    `/api/topics/${topic.id}/readiness`,
    { writingAngle: "Example API 的重试能力" },
  );
  assert.equal((readiness as { ready: boolean }).ready, false);
  await assert.rejects(
    workbench.mutate(`/api/topics/${topic.id}/review`, {
      decision: "approve",
      reason: "Example is not evidence",
    }),
    JobConflictError,
  );
  assert.equal(store.getTopicIntent(topic.id), null);
  assert.equal(modelCalls(), 0);
});

void test("snapshot reads never mark seen or resume expired snoozes; an aborted tick resumes without models", async (t) => {
  const f = await fixture(t);
  await f.workbench.snapshot();
  assert.equal(f.store.listSocialStates(brand.id)[0].editorial!.seenAt, null);
  const snooze = (await f.workbench.mutate(
    `/api/social-candidates/${f.candidate.id}/snooze`,
    { days: 1, reason: "Review tomorrow" },
  )) as { snoozedUntil: number };
  f.setClock(snooze.snoozedUntil + 1);
  await f.workbench.snapshot();
  assert.equal(f.store.listSocialStates(brand.id)[0].held, true);
  assert.equal(f.store.listSocialStates(brand.id)[0].editorial!.seenAt, null);
  const controller = new AbortController();
  controller.abort();
  await runWorkbenchTick({
    store: f.store,
    config: f.config,
    brand,
    model: f.model,
    client: f.client,
    signal: controller.signal,
    autoSubmit: false,
  });
  assert.equal(f.store.listSocialStates(brand.id)[0].held, false);
  assert.equal(
    f.store.listSocialStates(brand.id)[0].editorial!.snoozedUntil,
    null,
  );
  assert.equal(f.modelCalls(), 0);
});

void test("HTTP maps stale preference version to 409 and exposes dashboard without mutation", async (t) => {
  const { workbench, store } = await fixture(t);
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const origin = `http://127.0.0.1:${port}`;
  const password = "editorial test password only 12345";
  const server = createWorkbenchHttp(workbench, { password, origin });
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const login = await fetch(`${origin}/api/login`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  const save = () =>
    fetch(`${origin}/api/editorial/preferences`, {
      method: "POST",
      headers: { cookie, origin, "content-type": "application/json" },
      body: JSON.stringify(saveBody),
    });
  assert.equal((await save()).status, 200);
  assert.equal((await save()).status, 409);
  const response = await fetch(`${origin}/api/snapshot`, {
    headers: { cookie },
  });
  assert.equal(response.status, 200);
  const snapshot = await response.json();
  assert.equal(snapshot.editorial.profile.version, 1);
  assert.equal(snapshot.editorial.feedbackSummary.uniqueCandidates, 0);
  assert.equal(store.listSocialStates(brand.id)[0].editorial!.seenAt, null);
});
