import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createTcpServer } from "node:net";
import { request as httpRequest } from "node:http";
import { ContentJobStore } from "../store.js";
import { readConfig } from "../config.js";
import { validateBrand } from "../validation.js";
import { Workbench, createWorkbenchHttp } from "../workbench.js";
import { runWorkbenchTick } from "../workbench-runtime.js";
import type { ContentModel } from "../models.js";
import type { PostizClient } from "../postiz-client.js";

const brand = validateBrand({
  id: "brand",
  name: "Test",
  audience: "Developers",
  businessContext: "Developer tools",
  contentRules: [],
  examples: [],
  language: "English",
  verifiedFacts: [],
  maxPostLength: 280,
});

async function fixture(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "postiz-workbench-"));
  const dbPath = join(dir, "work.sqlite");
  const config = readConfig({
    CONTENT_DB_PATH: dbPath,
    CONTENT_MODEL: "mock",
    CONTENT_MODEL_API_KEY: "fake",
    POSTIZ_API_KEY: "fake",
    POSTIZ_INTEGRATION_ID: "x-test",
  });
  const store = new ContentJobStore(dbPath);
  t.after(() => store.close());
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, dbPath, config, store };
}

async function freePort(): Promise<number> {
  const server = createTcpServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((done) => server.close(() => done()));
  return address.port;
}

async function requestWithHost(
  port: number,
  path: string,
  method: "GET" | "HEAD" | "POST",
  host: string,
) {
  return new Promise<{ status: number; body: string }>(
    (resolveRequest, rejectRequest) => {
      const request = httpRequest(
        { hostname: "127.0.0.1", port, path, method, headers: { host } },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () =>
            resolveRequest({
              status: response.statusCode ?? 0,
              body: Buffer.concat(chunks).toString("utf8"),
            }),
          );
        },
      );
      request.on("error", rejectRequest);
      request.end();
    },
  );
}

void test("HTTP requires origin, JSON and an authenticated session; setup remains visible", async (t) => {
  const { config, store } = await fixture(t);
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const workbench = new Workbench({
    store,
    config,
    brand: null,
    postizUrl: "https://postiz.example",
  });
  const server = createWorkbenchHttp(workbench, {
    password: "a strong test password 12345",
    origin,
  });
  await new Promise<void>((done) => server.listen(port, "127.0.0.1", done));
  t.after(
    () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  );
  assert.equal((await fetch(`${origin}/healthz`)).status, 200);
  const railwayHealth = await requestWithHost(
    port,
    "/healthz",
    "GET",
    "healthcheck.railway.app",
  );
  assert.equal(railwayHealth.status, 200);
  assert.deepEqual(JSON.parse(railwayHealth.body), { ok: true });
  assert.equal(
    (await requestWithHost(port, "/healthz", "HEAD", "healthcheck.railway.app"))
      .status,
    200,
  );
  assert.equal(
    (
      await requestWithHost(
        port,
        "/api/snapshot",
        "GET",
        "healthcheck.railway.app",
      )
    ).status,
    403,
  );
  assert.equal(
    (await requestWithHost(port, "/healthz", "POST", "healthcheck.railway.app"))
      .status,
    403,
  );
  assert.equal((await fetch(`${origin}/C:%5cWindows%5cwin.ini`)).status, 404);
  assert.equal((await fetch(`${origin}/%2e%2e/%2e%2e/secret`)).status, 404);
  assert.equal((await fetch(`${origin}/api/snapshot`)).status, 401);
  const noOrigin = await fetch(`${origin}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "a strong test password 12345" }),
  });
  assert.equal(noOrigin.status, 403);
  const wrongType = await fetch(`${origin}/api/login`, {
    method: "POST",
    headers: { origin, "content-type": "text/plain" },
    body: "hello",
  });
  assert.equal(wrongType.status, 415);
  const wrong = await fetch(`${origin}/api/login`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ password: "wrong" }),
  });
  assert.equal(wrong.status, 401);
  assert.ok(!(await wrong.text()).includes("12345"));
  for (let i = 0; i < 5; i++)
    await fetch(`${origin}/api/login`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ password: "wrong" }),
    });
  assert.equal(
    (
      await fetch(`${origin}/api/login`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ password: "wrong" }),
      })
    ).status,
    429,
  );
  const login = await fetch(`${origin}/api/login`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ password: "a strong test password 12345" }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);
  assert.match(
    login.headers.get("set-cookie") ?? "",
    /HttpOnly; SameSite=Strict/,
  );
  const snapshot = await fetch(`${origin}/api/snapshot`, {
    headers: { cookie },
  });
  assert.equal(snapshot.status, 200);
  const data = (await snapshot.json()) as {
    brand: unknown;
    readiness: { ready: boolean };
    runtime: { paused: boolean };
  };
  assert.equal(data.brand, null);
  assert.equal(data.readiness.ready, false);
  assert.equal(data.runtime.paused, true);
  const denied = await fetch(`${origin}/api/pause`, {
    method: "POST",
    headers: {
      cookie,
      origin: "https://evil.example",
      "content-type": "application/json",
    },
    body: JSON.stringify({ paused: false }),
  });
  assert.equal(denied.status, 403);
  const run = await fetch(`${origin}/api/run`, {
    method: "POST",
    headers: { cookie, origin, "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(run.status, 409);
  const logout = await fetch(`${origin}/api/logout`, {
    method: "POST",
    headers: { cookie, origin, "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(logout.status, 200);
  assert.equal(
    (await fetch(`${origin}/api/snapshot`, { headers: { cookie } })).status,
    401,
  );
});

void test("pause persists across restart and a real tick creates one draft then syncs it", async (t) => {
  const { dbPath, config, store } = await fixture(t);
  const text =
    "Release notes describe this developer tool and link to its documentation.";
  const post =
    "Release notes explain this developer tool. https://example.com/release";
  let creates = 0;
  let calls = 0;
  const model: ContentModel = {
    async invoke(request) {
      calls++;
      if (request.task === "selection") {
        const candidate = (
          JSON.parse(request.user) as { candidates: { candidateId: string }[] }
        ).candidates[0];
        return JSON.stringify({
          decisions: [
            {
              candidateId: candidate.candidateId,
              scores: { relevance: 90, evidence: 90, developerValue: 90 },
              certainty: "confirmed",
              reason: "Useful documentation",
              identity: {
                entity: "Example",
                product: "Developer tool",
                version: null,
                eventType: "tutorial",
                eventDate: null,
                primaryUrl: "https://example.com/release",
              },
              identityEvidence: text,
            },
          ],
        });
      }
      if (request.task === "relevance")
        return JSON.stringify({
          relevant: true,
          reasoning: "Useful developer guidance",
        });
      if (request.task === "report")
        return "<report>The release notes explain a developer tool and its documentation.</report>";
      if (request.task === "post") return `<post>${post}</post>`;
      return JSON.stringify({ approved: true, reasons: [] });
    },
  };
  const client = {
    async listIntegrations() {
      return [
        {
          id: "x-test",
          name: "Test",
          identifier: "x",
          disabled: false,
          profile: null,
        },
      ];
    },
    async createPost(input: { mode: string }) {
      assert.equal(input.mode, "draft");
      creates++;
      return { postId: "draft-1", integrationId: "x-test" };
    },
    async listPosts() {
      return creates
        ? [
            {
              id: "draft-1",
              content: post,
              publishDate: new Date().toISOString(),
              state: "DRAFT",
              releaseId: null,
              releaseURL: null,
              integrationId: "x-test",
              providerIdentifier: "x",
            },
          ]
        : [];
    },
  } as unknown as PostizClient;
  const workbench = new Workbench({
    store,
    config,
    brand,
    postizUrl: "https://postiz.example",
    model: () => model,
    client: () => client,
  });
  assert.equal(workbench.runtime.paused, true);
  store.bindBrandIntegration(brand.id, config.postiz.integrationId);
  store.upsertCandidates({
    brandId: brand.id,
    origin: "manual",
    inputs: [{ url: "https://example.com/release", text }],
  });
  workbench.pause(false);
  await runWorkbenchTick({
    store,
    config,
    brand,
    model: () => model,
    client: () => client,
  });
  assert.equal(store.list({ brandId: brand.id, limit: 10 }).length, 0);
  const [pending] = store.listTopics({ brandId: brand.id });
  assert.equal(pending.status, "awaiting_approval");
  assert.equal(creates, 0);
  await workbench.mutate(`/api/topics/${pending.id}/review`, {
    decision: "approve",
    reason: "Evidence checked",
  });
  await runWorkbenchTick({
    store,
    config,
    brand,
    model: () => model,
    client: () => client,
  });
  const jobs = store.list({ brandId: brand.id, limit: 10 });
  assert.equal(
    jobs.length,
    1,
    JSON.stringify({
      candidates: store.listCandidates({ brandId: brand.id, limit: 10 }),
      topics: store.listTopics({ brandId: brand.id }),
    }),
  );
  assert.equal(jobs[0].state, "submitted");
  assert.equal(jobs[0].postizState, "DRAFT");
  assert.equal(creates, 1);
  assert.equal(calls, 5);
  assert.equal(
    store.getGenerationQuota({
      brandId: brand.id,
      limit: 3,
      timeZone: config.dailyTimeZone,
    }).used,
    1,
  );
  await assert.rejects(
    workbench.mutate(`/api/jobs/${jobs[0].id}/retry`, { reason: "try again" }),
  );
  await assert.rejects(workbench.mutate(`/api/jobs/${jobs[0].id}/submit`, {}));
  assert.equal(creates, 1);
  await runWorkbenchTick({
    store,
    config,
    brand,
    model: () => model,
    client: () => client,
  });
  assert.equal(creates, 1);
  assert.equal(calls, 5);
  workbench.pause(true);
  const second = new ContentJobStore(dbPath);
  assert.equal(second.getWorkbenchPaused(), true);
  second.close();
});
