import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { ContentModelError, createContentModel } from "../models.js";

void test("OpenAI-compatible adapter forwards an explicit thinking switch without streaming or tools", async (t) => {
  const requests: Record<string, unknown>[] = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify({
        id: "fixture-completion",
        object: "chat.completion",
        created: 1,
        model: "deepseek-flash",
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: { role: "assistant", content: "OK" },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const settings = {
    provider: "openai" as const,
    model: "deepseek-flash",
    apiKey: "test-key",
    baseURL: `http://127.0.0.1:${address.port}/v1`,
  };
  const request = { task: "post" as const, system: "Test", user: "Reply OK" };
  assert.equal(
    await createContentModel({ ...settings, thinking: "disabled" }).invoke(
      request,
    ),
    "OK",
  );
  assert.deepEqual(requests[0].thinking, { type: "disabled" });
  assert.equal(requests[0].stream, false);
  assert.equal(requests[0].tools, undefined);
  await createContentModel(settings).invoke(request);
  assert.equal(
    requests[1].thinking,
    undefined,
    "Other compatible models keep their existing request format",
  );
  assert.throws(
    () =>
      createContentModel({
        ...settings,
        provider: "anthropic",
        thinking: "disabled",
      }),
    /OpenAI-compatible/,
  );
});

void test("truncated model output is classified without exposing provider text", async (t) => {
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify({
        id: "truncated",
        object: "chat.completion",
        created: 1,
        model: "fixture",
        choices: [
          {
            index: 0,
            finish_reason: "length",
            message: {
              role: "assistant",
              content: "partial secret-like content",
            },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await assert.rejects(
    createContentModel({
      provider: "openai",
      model: "fixture",
      apiKey: "test-key",
      baseURL: `http://127.0.0.1:${address.port}/v1`,
    }).invoke({ task: "selection", system: "x", user: "x" }),
    (error: unknown) =>
      error instanceof ContentModelError &&
      error.code === "truncated" &&
      !error.message.includes("secret-like"),
  );
});

void test("rate limiting is classified with a safe message", async (t) => {
  const server = createServer((_request, response) => {
    response.statusCode = 429;
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify({ error: { message: "private upstream request" } }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await assert.rejects(
    createContentModel({
      provider: "openai",
      model: "fixture",
      apiKey: "test-key",
      baseURL: `http://127.0.0.1:${address.port}/v1`,
    }).invoke({ task: "selection", system: "x", user: "x" }),
    (error: unknown) =>
      error instanceof ContentModelError &&
      error.code === "rate_limit" &&
      !error.message.includes("private upstream"),
  );
});
