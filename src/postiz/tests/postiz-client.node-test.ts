import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  PostizApiError,
  PostizClient,
  PostizOutcomeUnknownError,
  type CreatePostizPost,
} from "../postiz-client.js";

// Fixtures match Postiz PublicIntegrationsController + PostsRepository, not a
// fabricated GET /posts/:id endpoint or the UI's internal API.
const API_URL = "http://localhost:4007/api/public/v1";
const API_KEY = "private-postiz-test-key";
const FUTURE = "2099-07-01T15:00:00.000Z";

interface RecordedRequest {
  url: string;
  options: RequestInit;
}

function setup(responses: Array<Response | Error>) {
  const calls: RecordedRequest[] = [];
  const fetchImpl: typeof globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    const response = responses.shift();
    assert.ok(response, "Unexpected extra request (possibly an unsafe retry)");
    if (response instanceof Error) throw response;
    return response;
  };
  return {
    client: new PostizClient({
      baseUrl: `${API_URL}/`,
      apiKey: API_KEY,
      fetch: fetchImpl,
    }),
    calls,
  };
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

test("lists integrations using the configured Docker prefix and raw Authorization", async () => {
  const { client, calls } = setup([
    json([
      {
        id: "x-123",
        name: "Tokenhot",
        identifier: "x",
        disabled: false,
        profile: "tokenhot",
      },
      { id: "x-disabled", name: "Old", identifier: "x", disabled: true },
    ]),
  ]);
  assert.deepEqual(await client.listIntegrations(), [
    {
      id: "x-123",
      name: "Tokenhot",
      identifier: "x",
      disabled: false,
      profile: "tokenhot",
    },
    {
      id: "x-disabled",
      name: "Old",
      identifier: "x",
      disabled: true,
      profile: null,
    },
  ]);
  assert.equal(calls[0].url, `${API_URL}/integrations`);
  assert.equal(
    new Headers(calls[0].options.headers).get("Authorization"),
    API_KEY,
  );
  assert.equal(calls[0].options.redirect, "error");
});

test("creates a draft with the real X schema and normalizes the array receipt", async () => {
  const { client, calls } = setup([
    json([{ postId: "post-1", integration: "x-123" }]),
  ]);
  assert.deepEqual(
    await client.createPost({
      integrationId: "x-123",
      content: "A verified product update.",
      mode: "draft",
    }),
    { postId: "post-1", integrationId: "x-123" },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${API_URL}/posts`);
  assert.equal(calls[0].options.method, "POST");
  const payload = JSON.parse(String(calls[0].options.body));
  assert.equal(payload.type, "draft");
  assert.ok(Number.isFinite(Date.parse(payload.date)));
  assert.equal(payload.shortLink, false);
  assert.deepEqual(payload.tags, []);
  assert.deepEqual(payload.posts, [
    {
      integration: { id: "x-123" },
      value: [{ content: "A verified product update.", image: [] }],
      settings: { __type: "x", who_can_reply_post: "everyone" },
    },
  ]);
});

test("schedules a thread in UTC and associates upload receipts with its first part", async () => {
  const media = [
    { id: "media-1", path: "https://postiz.example.com/uploads/image.png" },
  ];
  const { client, calls } = setup([
    json([{ postId: "thread-1", integration: "x-123" }]),
  ]);
  await client.createPost({
    integrationId: "x-123",
    content: ["First part", "Second part"],
    mode: "schedule",
    scheduledAt: "2099-07-01T23:00:00+08:00",
    media,
  });
  const payload = JSON.parse(String(calls[0].options.body));
  assert.equal(payload.date, FUTURE);
  assert.equal(payload.type, "schedule");
  assert.deepEqual(payload.posts[0].value, [
    { content: "First part", image: media },
    { content: "Second part", image: [] },
  ]);
});

test("rejects immediate publishing, unsafe dates and empty content before any network call", async () => {
  const { client, calls } = setup([]);
  const inputs = [
    { mode: "now", content: "Hello" },
    { mode: "schedule", content: "Hello" },
    { mode: "schedule", content: "Hello", scheduledAt: "2001-01-01T00:00:00Z" },
    { mode: "schedule", content: "Hello", scheduledAt: "2099-01-01T00:00:00" },
    { mode: "schedule", content: "Hello", scheduledAt: "2099-02-31T00:00:00Z" },
    { mode: "schedule", content: "Hello", scheduledAt: "2099-01-01T24:00:00Z" },
    { mode: "draft", content: [] },
    { mode: "draft", content: ["First", " "] },
    {
      mode: "draft",
      content: "Hello",
      media: [{ path: "/uploads/image.png" }],
    },
  ];
  for (const input of inputs) {
    await assert.rejects(
      client.createPost({
        integrationId: "x-123",
        ...input,
      } as CreatePostizPost),
      (error: unknown) =>
        error instanceof PostizApiError && error.code === "invalid_input",
    );
  }
  assert.equal(calls.length, 0);
});

test("server errors and HTTP request timeout leave the create outcome unknown with no retry", async () => {
  for (const status of [408, 500, 502, 503]) {
    const { client, calls } = setup([json({ error: API_KEY }, status)]);
    await assert.rejects(
      client.createPost({
        integrationId: "x-123",
        content: "Hello",
        mode: "draft",
      }),
      (error: unknown) => {
        assert.ok(error instanceof PostizOutcomeUnknownError);
        assert.equal(error.status, status);
        assert.ok(!error.message.includes(API_KEY));
        return true;
      },
    );
    assert.equal(calls.length, 1);
  }
});

test("known 4xx refusals remain explicit and do not expose upstream response text", async () => {
  for (const status of [400, 401, 403, 404, 409, 429]) {
    const { client, calls } = setup([
      json({ error: `Upstream echoed ${API_KEY}` }, status),
    ]);
    await assert.rejects(
      client.createPost({
        integrationId: "x-123",
        content: "Hello",
        mode: "draft",
      }),
      (error: unknown) => {
        assert.ok(error instanceof PostizApiError);
        assert.ok(!(error instanceof PostizOutcomeUnknownError));
        assert.equal(error.status, status);
        assert.ok(!JSON.stringify(error).includes(API_KEY));
        assert.ok(!error.message.includes(API_KEY));
        return true;
      },
    );
    assert.equal(calls.length, 1);
  }
});

test("network failure after submission is unknown and redacts exception messages", async () => {
  const { client, calls } = setup([
    new Error(`network diagnostics: ${API_KEY}`),
  ]);
  await assert.rejects(
    client.createPost({
      integrationId: "x-123",
      content: "Hello",
      mode: "draft",
    }),
    (error: unknown) =>
      error instanceof PostizOutcomeUnknownError &&
      !String(error).includes(API_KEY),
  );
  assert.equal(calls.length, 1);
});

test("a timed-out create aborts the request and never issues a second POST", async () => {
  let count = 0;
  let observedAbort = false;
  const fetchImpl: typeof globalThis.fetch = async (_url, options) => {
    count++;
    return new Promise<Response>((_resolve, reject) => {
      options?.signal?.addEventListener(
        "abort",
        () => {
          observedAbort = true;
          reject(new Error("aborted"));
        },
        { once: true },
      );
    });
  };
  const client = new PostizClient({
    baseUrl: API_URL,
    apiKey: API_KEY,
    timeoutMs: 10,
    fetch: fetchImpl,
  });
  await assert.rejects(
    client.createPost({
      integrationId: "x-123",
      content: "Hello",
      mode: "draft",
    }),
    PostizOutcomeUnknownError,
  );
  assert.equal(count, 1);
  assert.equal(observedAbort, true);
});

test("unusable success receipts stay unknown rather than becoming false publication success", async () => {
  const receipts: unknown[] = [
    [],
    { postId: "post-1", integration: "x-123" },
    [{ postId: "post-1", integration: "wrong-account" }],
    [{ integration: "x-123" }],
    [{ postId: "", integration: "x-123" }],
    [
      { postId: "one", integration: "x-123" },
      { postId: "two", integration: "x-123" },
    ],
  ];
  for (const receipt of receipts) {
    const { client, calls } = setup([json(receipt)]);
    await assert.rejects(
      client.createPost({
        integrationId: "x-123",
        content: "Hello",
        mode: "draft",
      }),
      PostizOutcomeUnknownError,
    );
    assert.equal(calls.length, 1);
  }
  const { client } = setup([new Response("not JSON", { status: 200 })]);
  await assert.rejects(
    client.createPost({
      integrationId: "x-123",
      content: "Hello",
      mode: "draft",
    }),
    PostizOutcomeUnknownError,
  );
});

test("reads the real list envelope and preserves published state, missing receipts and future states", async () => {
  const row = {
    id: "post-1",
    content: "Hello",
    publishDate: FUTURE,
    state: "PUBLISHED",
    releaseId: "missing",
    releaseURL: null,
    integration: { id: "x-123", providerIdentifier: "x", name: "Tokenhot" },
  };
  const { client, calls } = setup([
    json({
      posts: [
        row,
        { ...row, id: "post-2", state: "NEW_STATE", releaseId: null },
      ],
    }),
  ]);
  const posts = await client.listPosts({
    startDate: "2099-07-01T00:00:00Z",
    endDate: "2099-07-02T00:00:00Z",
  });
  assert.deepEqual(posts[0], {
    id: "post-1",
    content: "Hello",
    publishDate: FUTURE,
    state: "PUBLISHED",
    releaseId: "missing",
    releaseURL: null,
    integrationId: "x-123",
    providerIdentifier: "x",
  });
  assert.equal(posts[1].state, "NEW_STATE");
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, "/api/public/v1/posts");
  assert.equal(url.searchParams.get("startDate"), "2099-07-01T00:00:00.000Z");
  assert.equal(url.searchParams.get("endDate"), "2099-07-02T00:00:00.000Z");
});

test("bad list responses and reversed ranges are not silently treated as empty", async () => {
  for (const payload of [[], {}, { posts: [{ id: "broken" }] }]) {
    const { client } = setup([json(payload)]);
    await assert.rejects(
      client.listPosts({
        startDate: "2099-01-01T00:00:00Z",
        endDate: "2099-02-01T00:00:00Z",
      }),
      (error: unknown) =>
        error instanceof PostizApiError && error.code === "invalid_response",
    );
  }
  const { client, calls } = setup([]);
  await assert.rejects(
    client.listPosts({
      startDate: "2099-02-01T00:00:00Z",
      endDate: "2099-01-01T00:00:00Z",
    }),
    PostizApiError,
  );
  assert.equal(calls.length, 0);
});

test("uploads a local file as multipart and returns only Postiz's media receipt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "postiz-upload-"));
  try {
    const localPath = join(directory, "image.png");
    await writeFile(localPath, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const { client, calls } = setup([
      json({
        id: "media-1",
        path: "/uploads/image.png",
        organizationId: "org-1",
      }),
    ]);
    assert.deepEqual(await client.uploadFile(localPath), {
      id: "media-1",
      path: "/uploads/image.png",
    });
    assert.equal(calls[0].url, `${API_URL}/upload`);
    assert.equal(calls[0].options.method, "POST");
    assert.equal(
      new Headers(calls[0].options.headers).get("Content-Type"),
      null,
    );
    assert.ok(calls[0].options.body instanceof FormData);
    const file = calls[0].options.body.get("file");
    assert.ok(file instanceof Blob);
    assert.equal(file.type, "image/png");
    assert.equal(file.size, 8);
    assert.equal((file as File).name, "image.png");
    assert.deepEqual(
      new Uint8Array(await file.arrayBuffer()),
      new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects non-media paths without reading or sending them", async () => {
  const { client, calls } = setup([]);
  await assert.rejects(
    client.uploadFile(".env"),
    (error: unknown) =>
      error instanceof PostizApiError && error.code === "invalid_input",
  );
  assert.equal(calls.length, 0);
});

test("configuration errors never repeat credentials or accept ambiguous API destinations", () => {
  for (const baseUrl of [
    "not a URL",
    "https://example.com",
    `https://user:${API_KEY}@example.com/public/v1`,
    `https://example.com/public/v1?key=${API_KEY}`,
  ]) {
    assert.throws(
      () => new PostizClient({ baseUrl, apiKey: API_KEY }),
      (error: unknown) =>
        error instanceof PostizApiError && !String(error).includes(API_KEY),
    );
  }
  assert.throws(
    () => new PostizClient({ baseUrl: API_URL, apiKey: "" }),
    PostizApiError,
  );
  assert.throws(
    () => new PostizClient({ baseUrl: API_URL, apiKey: API_KEY, timeoutMs: 0 }),
    PostizApiError,
  );
});
