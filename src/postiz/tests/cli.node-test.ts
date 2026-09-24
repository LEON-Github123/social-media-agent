import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { readConfig, safeError } from "../config.js";

const execute = promisify(execFile);

void test("configuration rejects invalid automation controls and strips known credentials from errors", () => {
  assert.equal(readConfig({}).discoveryIntervalMs, 86_400_000);
  assert.equal(readConfig({ CONTENT_AUTO_SUBMIT: "false" }).autoSubmit, false);
  assert.equal(readConfig({}).allowScheduling, false);
  assert.equal(
    readConfig({ CONTENT_ALLOW_SCHEDULING: "true" }).allowScheduling,
    true,
  );
  assert.throws(() => readConfig({ CONTENT_ALLOW_SCHEDULING: "yes" }));
  assert.equal(readConfig({}).dailyGenerationLimit, 3);
  assert.equal(readConfig({}).dailyTimeZone, "Asia/Shanghai");
  assert.throws(() => readConfig({ CONTENT_DAILY_GENERATION_LIMIT: "4" }));
  assert.throws(() => readConfig({ CONTENT_DAILY_TIMEZONE: "invalid-zone" }));
  assert.throws(() => readConfig({ CONTENT_SELECTION_BATCH_SIZE: "21" }));
  assert.throws(() => readConfig({ CONTENT_AUTO_SUBMIT: "yes" }));
  assert.throws(() => readConfig({ CONTENT_MAX_JOBS_PER_TICK: "NaN" }));
  assert.throws(() => readConfig({ CONTENT_MODEL_PROVIDER: "unknown" }));
  assert.equal(
    safeError(new Error("failed using super-secret"), {
      CONTENT_MODEL_API_KEY: "super-secret",
    }),
    "failed using [redacted]",
  );
});

void test("CLI completes candidate -> topic -> model workflow -> Postiz draft -> sync, and a restart sends nothing", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "postiz-cli-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let modelCalls = 0;
  let postCalls = 0;
  let receivedContent = "";
  const postizDate = new Date().toISOString();
  const postText =
    "Release notes explain this developer tool. https://example.com/release";
  const modelResponses = [
    JSON.stringify({
      relevant: true,
      reasoning: "The source explains an actionable developer tool.",
    }),
    "<report>The source describes a developer tool release and its documentation. No brand benchmark is supplied.</report>",
    `<post>${postText}</post>`,
    JSON.stringify({ approved: true, reasons: [] }),
  ];
  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString("utf8");
      response.setHeader("Content-Type", "application/json");
      if (request.url === "/v1/chat/completions") {
        assert.equal(request.headers.authorization, "Bearer fake-model-key");
        const stage = modelCalls++;
        const ledger = new DatabaseSync(join(directory, "jobs.sqlite"), {
          readOnly: true,
        });
        try {
          const recorded = ledger
            .prepare(
              "SELECT (SELECT COUNT(*) FROM writing_model_calls) + (SELECT COUNT(*) FROM selection_model_calls) AS n",
            )
            .get();
          assert.equal(
            Number(recorded!.n),
            modelCalls,
            "Every model request must be recorded before the HTTP request starts",
          );
        } finally {
          ledger.close();
        }
        const payload = JSON.parse(body);
        const supplied =
          stage === 0
            ? JSON.parse(payload.messages[payload.messages.length - 1].content)
                .candidates[0]
            : null;
        const content =
          stage === 0
            ? JSON.stringify({
                decisions: [
                  {
                    candidateId: supplied.candidateId,
                    scores: { relevance: 90, evidence: 90, developerValue: 90 },
                    certainty: "confirmed",
                    reason: "Practical developer documentation",
                    identity: {
                      entity: "Example",
                      product: "Developer tool",
                      version: null,
                      eventType: "tutorial",
                      eventDate: null,
                      primaryUrl: "https://example.com/release",
                    },
                    identityEvidence:
                      "Release notes describe the developer tool and link to its documentation.",
                  },
                ],
              })
            : modelResponses[stage - 1];
        assert.ok(content, "One selection call and at most four writing calls");
        response.end(
          JSON.stringify({
            id: "test-completion",
            object: "chat.completion",
            created: 1,
            model: "mock-model",
            choices: [
              {
                index: 0,
                finish_reason: "stop",
                message: { role: "assistant", content },
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        );
      } else if (request.url === "/api/public/v1/integrations") {
        assert.equal(request.headers.authorization, "fake-postiz-key");
        response.end(
          JSON.stringify([
            {
              id: "x-test",
              name: "Test",
              identifier: "x",
              disabled: false,
              profile: null,
            },
          ]),
        );
      } else if (
        request.url === "/api/public/v1/posts" &&
        request.method === "POST"
      ) {
        assert.equal(request.headers.authorization, "fake-postiz-key");
        const payload = JSON.parse(body);
        assert.equal(payload.type, "draft");
        assert.equal(payload.posts[0].integration.id, "x-test");
        receivedContent = payload.posts[0].value[0].content;
        postCalls++;
        response.end(
          JSON.stringify([{ postId: "draft-1", integration: "x-test" }]),
        );
      } else if (request.url?.startsWith("/api/public/v1/posts?")) {
        response.end(
          JSON.stringify({
            posts: postCalls
              ? [
                  {
                    id: "draft-1",
                    content: receivedContent,
                    state: "DRAFT",
                    publishDate: postizDate,
                    releaseId: null,
                    releaseURL: null,
                    integration: { id: "x-test", providerIdentifier: "x" },
                  },
                ]
              : [],
          }),
        );
      } else {
        response.statusCode = 404;
        response.end(JSON.stringify({ error: "Unexpected test path" }));
      }
    } catch (error) {
      response.statusCode = 500;
      response.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : "test server error",
        }),
      );
    }
  });
  await new Promise<void>((resolveListen) =>
    server.listen(0, "127.0.0.1", resolveListen),
  );
  t.after(
    () =>
      new Promise<void>((resolveClose) => server.close(() => resolveClose())),
  );
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const brandPath = join(directory, "brand.json");
  const inputPath = join(directory, "input.json");
  await writeFile(
    brandPath,
    JSON.stringify({
      id: "test",
      name: "Test",
      audience: "Developers",
      businessContext: "Developer tools",
      contentRules: [],
      examples: [],
      language: "English",
      verifiedFacts: [],
      maxPostLength: 280,
    }),
  );
  await writeFile(
    inputPath,
    JSON.stringify([
      {
        url: "https://example.com/release",
        text: "Release notes describe the developer tool and link to its documentation.",
      },
    ]),
  );
  const env = {
    PATH: process.env.PATH,
    CONTENT_ENV_FILE: join(directory, "unused.env"),
    CONTENT_DB_PATH: join(directory, "jobs.sqlite"),
    CONTENT_BRAND_FILE: brandPath,
    CONTENT_MODEL_PROVIDER: "openai",
    CONTENT_MODEL: "mock-model",
    CONTENT_MODEL_API_KEY: "fake-model-key",
    CONTENT_MODEL_BASE_URL: `${origin}/v1`,
    POSTIZ_BASE_URL: `${origin}/api/public/v1`,
    POSTIZ_API_KEY: "fake-postiz-key",
    POSTIZ_INTEGRATION_ID: "x-test",
    LANGSMITH_TRACING: "false",
    LANGCHAIN_TRACING_V2: "false",
    NO_PROXY: "127.0.0.1,localhost",
  };
  const run = (args: string[]) =>
    execute(
      process.execPath,
      ["--import", "tsx", resolve("src/postiz/cli.ts"), ...args],
      { env, timeout: 45_000, maxBuffer: 1_000_000 },
    );
  const enqueued = JSON.parse(
    (await run(["enqueue", "--input-json", inputPath])).stdout,
  );
  assert.equal(enqueued.candidates[0].status, "new");
  assert.equal(modelCalls, 0);
  assert.equal(postCalls, 0);
  await assert.rejects(
    execute(
      process.execPath,
      ["--import", "tsx", resolve("src/postiz/cli.ts"), "work", "--once"],
      {
        env: { ...env, CONTENT_MODEL_API_KEY: "" },
        timeout: 15000,
      },
    ),
    /Set CONTENT_MODEL_API_KEY/,
  );
  assert.equal(
    JSON.parse((await run(["candidates"])).stdout)[0].status,
    "new",
    "Missing credentials must not poison candidates or consume selection calls",
  );
  assert.equal(modelCalls, 0);
  await run(["work", "--once"]);
  const jobs = JSON.parse((await run(["show"])).stdout);
  assert.equal(jobs.length, 1);
  const stored = JSON.parse((await run(["show", "--id", jobs[0].id])).stdout);
  assert.equal(stored.state, "submitted");
  assert.equal(stored.postizState, "DRAFT");
  assert.equal(stored.platformPostId, null);
  assert.equal(receivedContent, postText);
  assert.equal(modelCalls, 5);
  assert.equal(postCalls, 1);
  const duplicate = JSON.parse(
    (await run(["enqueue", "--input-json", inputPath])).stdout,
  );
  assert.deepEqual(duplicate.candidateIds, enqueued.candidateIds);
  await run(["work", "--once"]);
  assert.equal(modelCalls, 5);
  assert.equal(postCalls, 1);
  await assert.rejects(
    run(["submit", "--id", jobs[0].id]),
    /only ready content/,
  );
  await assert.rejects(
    run(["work", "--url", "https://example.com/unexpected"]),
    /not supported/,
  );
  modelResponses.push(
    JSON.stringify({ relevant: false, reasoning: "No useful new material" }),
    JSON.stringify({ relevant: false, reasoning: "No useful new material" }),
  );
  for (let i = 0; i < 2; i++) {
    const preview = JSON.parse(
      (await run(["preview", "--input-json", inputPath])).stdout,
    );
    assert.equal(preview.relevant, false);
  }
  await assert.rejects(
    run(["preview", "--input-json", inputPath]),
    /daily writing limit/,
  );
  assert.equal(
    modelCalls,
    7,
    "One generation and two rejected previews exhaust the persistent daily quota",
  );
  assert.equal(postCalls, 1);
  receivedContent =
    "A practical developer note, edited in Postiz. https://example.com/release";
  await run(["sync", "--id", jobs[0].id]);
  await run([
    "feedback",
    "--id",
    jobs[0].id,
    "--kind",
    "edit",
    "--reason",
    "Made the benefit specific",
  ]);
  const status = JSON.parse((await run(["status"])).stdout);
  assert.equal(status.quota.used, 3);
  assert.equal(status.today.todayGenerationStarts, 3);
  assert.equal(status.generationAttempts.total, 3);
  assert.equal(status.modelCalls.total, 7);
  assert.equal(status.modelCalls.writing.total, 6);
  assert.equal(status.modelCalls.selection.total, 1);
  assert.equal(status.jobs.items[0].originalPost, postText);
  assert.equal(status.jobs.items[0].latestObservedContent, receivedContent);
  assert.equal(status.jobs.items[0].edited, true);
  assert.equal(
    status.jobs.items[0].feedback[0].reason,
    "Made the benefit specific",
  );
  assert.equal(status.candidates.failureItems.length, 0);
  assert.equal(
    modelCalls,
    7,
    "Status and feedback perform no external model calls",
  );
  await execute(
    process.execPath,
    ["--import", "tsx", resolve("src/postiz/cli.ts"), "work", "--once"],
    {
      env: {
        ...env,
        CONTENT_DB_PATH: join(directory, "empty.sqlite"),
        CONTENT_MODEL_API_KEY: "",
        POSTIZ_API_KEY: "",
        POSTIZ_INTEGRATION_ID: "",
      },
      timeout: 15000,
    },
  );
  assert.equal(
    modelCalls,
    7,
    "Empty workers start without model or social credentials",
  );
});
