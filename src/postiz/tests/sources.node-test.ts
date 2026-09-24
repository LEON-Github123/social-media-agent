import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  discoverSourceBatch,
  discoverSources,
  loadSource,
  sourceIdentity,
  sourceReadKey,
  type SourceOptions,
} from "../sources.js";
import { fetchPublicText, isPublicAddress, publicUrl } from "../network.js";

const lookup: NonNullable<SourceOptions["lookup"]> = async () => [
  { address: "8.8.8.8", family: 4 },
];
const mockFetch = (
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): typeof fetch =>
  (async (url, init) => handler(String(url), init ?? {})) as typeof fetch;
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
const now = () => new Date("2026-09-24T12:00:00Z");

void test("supplied source text bypasses all network work and respects maxChars", async () => {
  const source = await loadSource(
    {
      url: "https://example.com/post#heading",
      text: "  Hello world  ",
      title: " Example ",
    },
    {
      maxChars: 5,
      lookup: async () => {
        throw new Error("Unexpected DNS");
      },
      fetch: mockFetch(() => {
        throw new Error("Unexpected request");
      }),
    },
  );
  assert.deepEqual(source, {
    url: "https://example.com/post",
    text: "Hello",
    title: "Example",
  });
  await assert.rejects(
    loadSource({ url: "https://example.com", text: "  " }),
    /non-empty/,
  );
});

void test("direct HTML extraction isolates main content and excludes navigation/scripts", async () => {
  const source = await loadSource(
    { url: "https://example.com/post" },
    {
      lookup,
      fetch: mockFetch((_url, init) => {
        assert.equal(init.redirect, "manual");
        return new Response(
          "<html><head><title>Release</title></head><body><nav>Navigation</nav><main><h1>New release</h1><p>Useful facts.</p><script>secret()</script></main><footer>Footer</footer></body></html>",
          { headers: { "content-type": "text/html" } },
        );
      }),
    },
  );
  assert.equal(source.title, "Release");
  assert.match(source.text, /New release/);
  assert.match(source.text, /Useful facts/);
  assert.doesNotMatch(source.text, /Navigation|Footer|secret/);
});

void test("HTTP errors, unsupported payloads and empty extraction cannot become documents", async () => {
  for (const response of [
    new Response("failure", { status: 500 }),
    new Response("", { status: 200 }),
    new Response("{}", { headers: { "content-type": "application/json" } }),
  ]) {
    await assert.rejects(
      loadSource(
        { url: "https://example.com/post" },
        { lookup, fetch: mockFetch(() => response) },
      ),
    );
  }
});

void test("Firecrawl uses its REST contract and rejects failed or empty results", async () => {
  let calls = 0;
  const source = await loadSource(
    { url: "https://example.com/post" },
    {
      lookup,
      firecrawlApiKey: "test-key",
      fetch: mockFetch((url, init) => {
        calls += 1;
        assert.equal(url, "https://api.firecrawl.dev/v2/scrape");
        assert.equal(
          new Headers(init.headers).get("authorization"),
          "Bearer test-key",
        );
        assert.equal(init.method, "POST");
        const payload = JSON.parse(String(init.body));
        assert.equal(payload.url, "https://example.com/post");
        assert.deepEqual(payload.formats, ["markdown"]);
        assert.equal(payload.onlyMainContent, true);
        return json({
          success: true,
          data: {
            markdown: "# Verified release\nDetails.",
            metadata: { title: "Release", statusCode: 200 },
          },
        });
      }),
    },
  );
  assert.equal(calls, 1);
  assert.equal(source.title, "Release");
  assert.match(source.text, /Verified release/);
  for (const payload of [
    { success: false, error: "Upstream failed" },
    { success: true, data: { markdown: "" } },
    {
      success: true,
      data: { markdown: "Error page", metadata: { statusCode: 404 } },
    },
    {
      success: true,
      data: { markdown: "Private", metadata: { url: "http://127.0.0.1" } },
    },
  ]) {
    await assert.rejects(
      loadSource(
        { url: "https://example.com/post" },
        {
          lookup,
          firecrawlApiKey: "test-key",
          fetch: mockFetch(() => json(payload)),
        },
      ),
    );
  }
});

void test("URL normalization blocks private, encoded, local and metadata destinations", async () => {
  for (const url of [
    "http://127.0.0.1",
    "http://2130706433",
    "http://0x7f000001",
    "http://0177.0.0.1",
    "http://169.254.169.254/latest/meta-data",
    "http://10.0.0.1",
    "http://172.16.0.1",
    "http://192.168.1.1",
    "http://100.64.0.1",
    "http://[::1]",
    "http://[::ffff:127.0.0.1]",
    "http://[fc00::1]",
    "http://[fe80::1]",
    "http://localhost.",
    "http://metadata.google.internal",
    "http://user:password@example.com",
    "file:///etc/passwd",
    "http://printer",
  ])
    assert.throws(() => publicUrl(url), undefined, url);
  assert.equal(isPublicAddress("8.8.8.8"), true);
  assert.equal(isPublicAddress("2606:4700:4700::1111"), true);
  assert.equal(isPublicAddress("2001:db8::1"), false);
  assert.equal(isPublicAddress("2002:7f00:1::"), false);
  let requested = false;
  await assert.rejects(
    fetchPublicText("https://example.com", {
      lookup: async () => [
        { address: "8.8.8.8", family: 4 },
        { address: "10.0.0.1", family: 4 },
      ],
      fetch: mockFetch(() => {
        requested = true;
        return new Response("private");
      }),
    }),
    /exclusively to public/,
  );
  assert.equal(requested, false);
});

void test("each redirect is validated and credentials never follow another origin", async () => {
  const visited: string[] = [];
  await assert.rejects(
    fetchPublicText("https://example.com", {
      lookup,
      fetch: mockFetch((url) => {
        visited.push(url);
        return new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254" },
        });
      }),
    }),
    /Private|public/,
  );
  assert.equal(visited.length, 1);
  await assert.rejects(
    fetchPublicText("https://example.com", {
      lookup,
      headers: { Authorization: "Bearer test-key" },
      fetch: mockFetch(
        () =>
          new Response(null, {
            status: 302,
            headers: { location: "https://another.example.com" },
          }),
      ),
    }),
    /Authenticated/,
  );
  let dnsCalls = 0;
  await assert.rejects(
    fetchPublicText("https://example.com", {
      lookup: async () => [
        { address: ++dnsCalls === 1 ? "8.8.8.8" : "127.0.0.1", family: 4 },
      ],
      fetch: mockFetch(
        () =>
          new Response(null, { status: 302, headers: { location: "/next" } }),
      ),
    }),
    /exclusively to public/,
  );
  assert.equal(dnsCalls, 2);
});

void test("redirects are bounded and safe redirect final URLs are retained", async () => {
  const source = await loadSource(
    { url: "https://example.com/old" },
    {
      lookup,
      fetch: mockFetch((url) =>
        url.endsWith("/old")
          ? new Response(null, { status: 301, headers: { location: "/new" } })
          : new Response("Public article", {
              headers: { "content-type": "text/plain" },
            }),
      ),
    },
  );
  assert.equal(source.url, "https://example.com/new");
  let calls = 0;
  await assert.rejects(
    fetchPublicText("https://example.com", {
      lookup,
      maxRedirects: 1,
      fetch: mockFetch(() => {
        calls += 1;
        return new Response(null, {
          status: 302,
          headers: { location: "/again" },
        });
      }),
    }),
    /redirect limit/,
  );
  assert.equal(calls, 2);
});

void test("deadline includes unresolved DNS, slow headers and stalled response bodies", async () => {
  for (const options of [
    {
      lookup: async () => new Promise<never>(() => undefined),
      fetch: mockFetch(() => new Response("unused")),
    },
    {
      lookup,
      fetch: mockFetch(async () => new Promise<never>(() => undefined)),
    },
    {
      lookup,
      fetch: mockFetch(
        () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start() {
                /* intentionally stalled */
              },
            }),
          ),
      ),
    },
  ]) {
    await assert.rejects(
      fetchPublicText("https://example.com", { ...options, timeoutMs: 20 }),
      /timed out/,
    );
  }
});

void test("response size limits apply even without Content-Length", async () => {
  for (const response of [
    new Response("123456", { headers: { "content-length": "6" } }),
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("1234"));
          controller.enqueue(new TextEncoder().encode("56"));
          controller.close();
        },
      }),
    ),
  ]) {
    await assert.rejects(
      fetchPublicText("https://example.com", {
        lookup,
        maxBytes: 5,
        fetch: mockFetch(() => response),
      }),
      /byte limit/,
    );
  }
});

void test("RSS discovers full content, dates and relative links; summary-only items need extraction", async () => {
  const rss = `<rss xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel>
    <item><title>Release</title><link>/release</link><pubDate>Thu, 24 Sep 2026 11:00:00 GMT</pubDate><content:encoded><![CDATA[<p>Full release content.</p>]]></content:encoded></item>
    <item><title>Summary</title><link>https://example.com/summary</link><pubDate>Thu, 24 Sep 2026 10:00:00 GMT</pubDate><description>Short summary</description></item>
    <item><link>https://example.com/old</link><pubDate>Tue, 01 Sep 2026 11:00:00 GMT</pubDate></item>
    <item><link>http://127.0.0.1/private</link></item>
  </channel></rss>`;
  const values = await discoverSources(
    [{ type: "rss", url: "https://example.com/feed.xml", maxAgeHours: 24 }],
    { lookup, now, fetch: mockFetch(() => new Response(rss)) },
  );
  assert.equal(values.length, 2);
  assert.equal(values[0].url, "https://example.com/release");
  assert.equal(values[0].text, "Full release content.");
  assert.equal(values[0].publishedAt, "2026-09-24T11:00:00.000Z");
  assert.equal(values[1].text, undefined);
});

void test("Atom links and content are normalized; malformed or entity-bearing feeds fail", async () => {
  const atom =
    '<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Update</title><link rel="self" href="https://example.com/api"/><link rel="alternate" href="https://example.com/update"/><updated>2026-09-24T11:00:00Z</updated><content type="html">&lt;p&gt;Atom content.&lt;/p&gt;</content></entry></feed>';
  const values = await discoverSources(
    [{ type: "rss", url: "https://example.com/atom" }],
    { lookup, fetch: mockFetch(() => new Response(atom)) },
  );
  assert.equal(values[0].url, "https://example.com/update");
  assert.equal(values[0].text, "Atom content.");
  for (const feed of [
    "<html>Error page</html>",
    '<!DOCTYPE rss [<!ENTITY external SYSTEM "file:///etc/passwd">]><rss><channel/></rss>',
  ]) {
    await assert.rejects(
      discoverSources([{ type: "rss", url: "https://example.com/feed" }], {
        lookup,
        fetch: mockFetch(() => new Response(feed)),
      }),
    );
  }
});

void test("JSON file sources use the configured directory and enforce structure and size", async () => {
  const directory = await mkdtemp(join(tmpdir(), "postiz-sources-"));
  try {
    await writeFile(
      join(directory, "sources.json"),
      JSON.stringify([
        { url: "https://example.com/a", text: "Original material" },
        { url: "https://example.com/b", text: "Second" },
      ]),
    );
    const values = await discoverSources(
      [{ type: "json-file", path: "sources.json", limit: 1 }],
      { baseDir: directory },
    );
    assert.equal(values.length, 1);
    assert.equal(values[0].text, "Original material");
    await assert.rejects(
      discoverSources([{ type: "json-file", path: "sources.json" }], {
        baseDir: directory,
        maxBytes: 5,
      }),
      /byte limit/,
    );
    await writeFile(join(directory, "invalid.json"), "{}");
    await assert.rejects(
      discoverSources([{ type: "json-file", path: "invalid.json" }], {
        baseDir: directory,
      }),
      /SourceInput array/,
    );
    await writeFile(
      join(directory, "empty-text.json"),
      '[{"url":"https://example.com","text":""}]',
    );
    await assert.rejects(
      discoverSources([{ type: "json-file", path: "empty-text.json" }], {
        baseDir: directory,
      }),
      /non-empty/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("GetXAPI search uses Bearer auth, exact fields, pagination and filtering", async () => {
  const calls: URL[] = [];
  const values = await discoverSources(
    [
      {
        type: "getx-search",
        query: '"AI API" min_faves:5',
        maxPages: 3,
        limit: 2,
        minLikes: 5,
        maxAgeHours: 24,
      },
    ],
    {
      lookup,
      now,
      getxApiKey: "test-token",
      fetch: mockFetch((input, init) => {
        const url = new URL(input);
        calls.push(url);
        assert.equal(url.origin, "https://api.getxapi.com");
        assert.equal(url.pathname, "/twitter/tweet/advanced_search");
        assert.equal(url.searchParams.get("q"), '"AI API" min_faves:5');
        assert.equal(url.searchParams.get("product"), "Latest");
        assert.equal(
          new Headers(init.headers).get("authorization"),
          "Bearer test-token",
        );
        return json({
          has_more: true,
          next_cursor: `cursor-${calls.length}`,
          tweets: [
            {
              id: String(calls.length),
              text: `Evidence ${calls.length}`,
              createdAt: "Thu Sep 24 11:00:00 +0000 2026",
              likeCount: 20,
              author: { userName: "Author" },
            },
          ],
        });
      }),
    },
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[0].searchParams.has("cursor"), false);
  assert.equal(calls[1].searchParams.get("cursor"), "cursor-1");
  assert.equal(values[0].url, "https://x.com/Author/status/1");
  assert.equal(values[0].publishedAt, "2026-09-24T11:00:00.000Z");
});

void test("GetXAPI user reads userName; empty tweets succeed and page caps stop billing", async () => {
  let calls = 0;
  const empty = await discoverSources(
    [{ type: "getx-user", userName: "@Example", maxPages: 5 }],
    {
      lookup,
      getxApiKey: "token",
      fetch: mockFetch((input) => {
        calls += 1;
        const url = new URL(input);
        assert.equal(url.pathname, "/twitter/user/tweets");
        assert.equal(url.searchParams.get("userName"), "Example");
        return json({ tweets: [], has_more: false, next_cursor: "" });
      }),
    },
  );
  assert.deepEqual(empty, []);
  assert.equal(calls, 1);
  calls = 0;
  await discoverSources(
    [{ type: "getx-search", query: "AI", maxPages: 5, minLikes: 100 }],
    {
      lookup,
      getxApiKey: "token",
      maxPages: 2,
      fetch: mockFetch(() => {
        calls += 1;
        return json({
          tweets: [{ id: String(calls), text: "Low engagement", likeCount: 1 }],
          has_more: true,
          next_cursor: `page-${calls}`,
        });
      }),
    },
  );
  assert.equal(calls, 2);
});

void test("GetXAPI errors and repeated cursors are surfaced instead of content", async () => {
  for (const response of [
    json({ error: "balance exhausted" }, 402),
    json({ tweets: "invalid", has_more: false }),
    json({ tweets: [], has_more: false, error: "upstream failed" }),
  ]) {
    await assert.rejects(
      discoverSources([{ type: "getx-search", query: "AI" }], {
        lookup,
        getxApiKey: "token",
        fetch: mockFetch(() => response),
      }),
    );
  }
  await assert.rejects(
    discoverSources([{ type: "getx-search", query: "AI", maxPages: 5 }], {
      lookup,
      getxApiKey: "token",
      fetch: mockFetch(() =>
        json({
          tweets: [{ id: "1", text: "Content" }],
          has_more: true,
          next_cursor: "same-cursor",
        }),
      ),
    }),
    /repeated.*cursor/,
  );
});

void test("discovery deduplicates X URL aliases and enforces global limits without extra calls", async () => {
  const values = await discoverSources(
    [
      {
        type: "url",
        url: "https://twitter.com/Example/status/123",
        text: "First",
      },
      {
        type: "url",
        url: "https://x.com/Example/status/123",
        text: "Duplicate",
      },
      { type: "url", url: "https://example.com/second", text: "Second" },
      { type: "getx-search", query: "should not execute" },
    ],
    {
      maxItems: 2,
      fetch: mockFetch(() => {
        throw new Error("Extra call");
      }),
    },
  );
  assert.equal(values.length, 2);
  assert.equal(values[0].text, "First");
  assert.equal(values[1].text, "Second");
  await assert.rejects(discoverSources([], { maxItems: 101 }), /maxItems/);
  await assert.rejects(
    discoverSources([
      { type: "rss", url: "https://example.com/feed", limit: 51 },
    ]),
    /Source limit/,
  );
});

void test("a small source batch preserves the rest of a feed across process restarts", async () => {
  let requests = 0;
  const source = {
    type: "rss" as const,
    url: "https://example.com/feed",
    limit: 4,
  };
  const first = await discoverSourceBatch(source, {
    lookup,
    batchSize: 2,
    fetch: mockFetch(() => {
      requests += 1;
      return new Response(
        `<rss><channel>${[1, 2, 3, 4].map((id) => `<item><title>Story ${id}</title><link>https://example.com/${id}</link></item>`).join("")}</channel></rss>`,
      );
    }),
  });
  assert.equal(first.complete, false);
  assert.equal(first.inputs.length, 2);
  const second = await discoverSourceBatch(source, {
    batchSize: 2,
    checkpoint: JSON.parse(JSON.stringify(first.checkpoint)),
    fetch: mockFetch(() => {
      throw new Error("An existing snapshot must not be fetched again");
    }),
  });
  assert.equal(requests, 1);
  assert.equal(second.complete, true);
  assert.equal(second.checkpoint, null);
  assert.deepEqual(
    [...first.inputs, ...second.inputs].map((input) => input.url),
    [1, 2, 3, 4].map((id) => `https://example.com/${id}`),
  );
});

void test("GetX checkpoints drain a paid page before requesting its continuation", async () => {
  const source = {
    type: "getx-user" as const,
    userName: "Example",
    limit: 5,
    maxPages: 2,
  };
  const requests: URL[] = [];
  const options = {
    lookup,
    getxApiKey: "token",
    batchSize: 2,
    fetch: mockFetch((input) => {
      const url = new URL(input);
      requests.push(url);
      return json({
        tweets: (url.searchParams.has("cursor") ? [4, 5] : [1, 2, 3]).map(
          (id) => ({
            id: String(id),
            text: `Evidence ${id}`,
            author: { userName: "Example" },
          }),
        ),
        has_more: !url.searchParams.has("cursor"),
        next_cursor: "next-page",
      });
    }),
  };
  const first = await discoverSourceBatch(source, options);
  assert.equal(first.inputs.length, 2);
  const second = await discoverSourceBatch(source, {
    ...options,
    checkpoint: JSON.parse(JSON.stringify(first.checkpoint)),
  });
  assert.equal(second.inputs.length, 1);
  assert.equal(requests.length, 1);
  assert.equal(second.complete, false);
  const third = await discoverSourceBatch(source, {
    ...options,
    checkpoint: JSON.parse(JSON.stringify(second.checkpoint)),
  });
  assert.equal(requests.length, 2);
  assert.equal(requests[1].searchParams.get("cursor"), "next-page");
  assert.equal(third.complete, true);
  assert.deepEqual(
    [...first.inputs, ...second.inputs, ...third.inputs].map(
      (input) => input.url,
    ),
    [1, 2, 3, 4, 5].map((id) => `https://x.com/Example/status/${id}`),
  );
});

void test("one GetX source check never chains paid requests when a page is filtered out", async () => {
  let requests = 0;
  const source = {
    type: "getx-search" as const,
    query: "AI",
    minLikes: 100,
    maxPages: 3,
  };
  const options = {
    lookup,
    getxApiKey: "token",
    fetch: mockFetch(() => {
      requests += 1;
      return json({
        tweets: [{ id: String(requests), text: "Low score", likeCount: 1 }],
        has_more: true,
        next_cursor: `page-${requests}`,
      });
    }),
  };
  const first = await discoverSourceBatch(source, options);
  assert.deepEqual(first.inputs, []);
  assert.equal(first.complete, false);
  assert.equal(requests, 1);
  const second = await discoverSourceBatch(source, {
    ...options,
    checkpoint: first.checkpoint,
  });
  assert.equal(requests, 2);
  const third = await discoverSourceBatch(source, {
    ...options,
    checkpoint: second.checkpoint,
  });
  assert.equal(requests, 3);
  assert.equal(third.complete, true);
});

void test("configuration changes invalidate stale pending work while schedule changes preserve it", async () => {
  const source = {
    type: "rss" as const,
    id: "release-feed",
    url: "https://example.com/feed",
    limit: 2,
  };
  const options = {
    lookup,
    batchSize: 1,
    fetch: mockFetch(
      () =>
        new Response(
          "<rss><channel><item><link>https://example.com/a</link></item><item><link>https://example.com/b</link></item></channel></rss>",
        ),
    ),
  };
  const first = await discoverSourceBatch(source, options);
  assert.equal(
    sourceIdentity(source),
    sourceIdentity({ ...source, checkIntervalMs: 30_000 }),
  );
  assert.equal(
    sourceReadKey(source),
    sourceReadKey({ ...source, checkIntervalMs: 30_000, primary: true }),
  );
  assert.notEqual(
    sourceReadKey(source),
    sourceReadKey({ ...source, url: "https://example.com/new-feed" }),
  );
  const continued = await discoverSourceBatch(
    { ...source, checkIntervalMs: 30_000 },
    {
      ...options,
      checkpoint: first.checkpoint,
      fetch: mockFetch(() => {
        throw new Error("Unexpected re-fetch");
      }),
    },
  );
  assert.equal(continued.inputs[0].url, "https://example.com/b");
  let refreshed = false;
  const changed = await discoverSourceBatch(
    { ...source, url: "https://example.com/new-feed" },
    {
      ...options,
      checkpoint: first.checkpoint,
      fetch: mockFetch(() => {
        refreshed = true;
        return new Response(
          "<rss><channel><item><link>https://example.com/c</link></item></channel></rss>",
        );
      }),
    },
  );
  assert.equal(refreshed, true);
  assert.equal(changed.inputs[0].url, "https://example.com/c");
});

void test("disabled paid examples make no calls through either discovery API", async () => {
  const source = { type: "getx-search" as const, query: "AI", enabled: false };
  const options = {
    fetch: mockFetch(() => {
      throw new Error("Paid example should not execute");
    }),
  };
  assert.deepEqual(await discoverSources([source], options), []);
  assert.deepEqual(await discoverSourceBatch(source, options), {
    inputs: [],
    checkpoint: null,
    complete: true,
  });
});

void test("invalid persisted checkpoint data cannot bypass input validation", async () => {
  const source = { type: "rss" as const, url: "https://example.com/feed" };
  await assert.rejects(
    discoverSourceBatch(source, {
      checkpoint: {
        version: 1,
        sourceKey: sourceReadKey(source),
        kind: "snapshot",
        pending: [{ url: "http://127.0.0.1/private", text: "Untrusted" }],
      },
    }),
    /Private|public/,
  );
});
