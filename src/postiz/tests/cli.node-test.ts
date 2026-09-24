import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
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

void test("CLI completes enqueue -> model workflow -> Postiz draft -> sync, and a rerun sends nothing", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "postiz-cli-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let modelCalls = 0;
  let postCalls = 0;
  let receivedContent = "";
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
        const content = modelResponses[modelCalls++];
        assert.ok(content, "No more than four content model calls");
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
                    publishDate: new Date().toISOString(),
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
  assert.equal(enqueued.state, "queued");
  assert.equal(modelCalls, 0);
  assert.equal(postCalls, 0);
  await run(["work", "--once"]);
  const stored = JSON.parse((await run(["show", "--id", enqueued.id])).stdout);
  assert.equal(stored.state, "submitted");
  assert.equal(stored.postizState, "DRAFT");
  assert.equal(stored.platformPostId, null);
  assert.equal(receivedContent, postText);
  assert.equal(modelCalls, 4);
  assert.equal(postCalls, 1);
  const duplicate = JSON.parse(
    (await run(["enqueue", "--input-json", inputPath])).stdout,
  );
  assert.equal(duplicate.id, enqueued.id);
  await run(["work", "--once"]);
  assert.equal(modelCalls, 4);
  assert.equal(postCalls, 1);
  await assert.rejects(
    run(["submit", "--id", enqueued.id]),
    /only ready content/,
  );
  await assert.rejects(
    run(["work", "--url", "https://example.com/unexpected"]),
    /not supported/,
  );
});
