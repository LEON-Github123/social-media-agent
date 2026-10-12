import assert from "node:assert/strict";
import test from "node:test";
import {
  discoverSourceBatch,
  fetchTwitterApiTweetsByIds,
  type SourceInput,
  type SourceOptions,
} from "../sources.js";
import type { XPostSnapshot } from "../social-types.js";

const lookup: NonNullable<SourceOptions["lookup"]> = async () => [
  { address: "8.8.8.8", family: 4 },
];
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status });
const mockFetch = (
  handler: (url: URL, init: RequestInit) => Response,
): typeof fetch =>
  (async (url, init) =>
    handler(new URL(String(url)), init ?? {})) as typeof fetch;
const now = () => new Date("2026-09-24T12:00:00Z");

void test("TwitterAPI observations preserve own metrics through a bounded page replay", async () => {
  const observed: Array<{ input: SourceInput; snapshot: XPostSnapshot }> = [];
  let requests = 0;
  let reservations = 0;
  const source = {
    type: "twitterapi-user" as const,
    userName: "Example",
    maxPages: 1,
  };
  const options: SourceOptions & { batchSize: number } = {
    lookup,
    now,
    batchSize: 1,
    twitterApiIoApiKey: "test-key",
    beforeProviderRequest: () => {
      reservations += 1;
    },
    onSocialSnapshot: (input, snapshot) => {
      observed.push({ input, snapshot });
    },
    fetch: mockFetch((url) => {
      requests += 1;
      assert.equal(url.pathname, "/twitter/user/last_tweets");
      return json({
        tweets: [
          {
            id: "101",
            text: "Quote",
            createdAt: "2026-09-24T11:00:00Z",
            author: { id: "501", userName: "Example", name: "Alice" },
            viewCount: 100,
            likeCount: 4,
            replyCount: 2,
            retweetCount: 1,
            quoteCount: 0,
            bookmarkCount: 3,
            quoted_tweet: { id: "901", viewCount: 999_999, likeCount: 999 },
          },
          {
            id: "102",
            text: "Unknown counts",
            author: { userName: "Example" },
            isReply: true,
            viewCount: "30",
            likeCount: -1,
            replyCount: 1.5,
            retweetCount: Number.MAX_SAFE_INTEGER + 1,
          },
          { id: "103", text: "Repost", retweeted_tweet: { id: "902" } },
        ],
        has_next_page: false,
      });
    }),
  };
  const first = await discoverSourceBatch(source, options);
  assert.equal(requests, 1);
  assert.equal(reservations, 1);
  assert.equal(observed.length, 3);
  assert.deepEqual(observed[0].snapshot, {
    tweetId: "101",
    authorId: "501",
    authorHandle: "Example",
    authorName: "Alice",
    postType: "quote",
    quotedTweetId: "901",
    publishedAt: "2026-09-24T11:00:00.000Z",
    observedAt: now().getTime(),
    views: 100,
    likes: 4,
    replies: 2,
    reposts: 1,
    quotes: 0,
    bookmarks: 3,
  });
  assert.equal(observed[1].snapshot.postType, "reply");
  for (const field of [
    "views",
    "likes",
    "replies",
    "reposts",
    "quotes",
    "bookmarks",
  ] as const)
    assert.equal(observed[1].snapshot[field], null);
  assert.equal(observed[2].snapshot.postType, "repost");
  const second = await discoverSourceBatch(source, {
    ...options,
    checkpoint: JSON.parse(JSON.stringify(first.checkpoint)),
    fetch: mockFetch(() => {
      throw new Error("Paid page fetched twice");
    }),
  });
  assert.equal(second.inputs[0].url, "https://x.com/Example/status/102");
  assert.equal(observed.length, 4);
  assert.deepEqual(observed[3].snapshot, observed[1].snapshot);
  const third = await discoverSourceBatch(source, {
    ...options,
    checkpoint: JSON.parse(JSON.stringify(second.checkpoint)),
    fetch: mockFetch(() => {
      throw new Error("Paid page fetched twice");
    }),
  });
  assert.equal(third.complete, true);
  assert.equal(requests, 1);
  assert.equal(reservations, 1);
});

void test("tweet ID refresh accepts top-level and nested envelopes and rejects unrequested IDs", async () => {
  let reservations = 0;
  let requests = 0;
  const options: SourceOptions = {
    lookup,
    now,
    twitterApiIoApiKey: "test-key",
    beforeProviderRequest: () => {
      reservations += 1;
    },
    fetch: mockFetch((url, init) => {
      requests += 1;
      assert.equal(url.pathname, "/twitter/tweets");
      assert.equal(url.searchParams.get("tweet_ids"), "101,102");
      assert.equal(new Headers(init.headers).get("x-api-key"), "test-key");
      assert.equal(init.redirect, "manual");
      return json({
        data: { tweets: [{ id: "101", text: "One", likeCount: 0 }] },
        status: "success",
      });
    }),
  };
  const items = await fetchTwitterApiTweetsByIds(["101", "102"], options);
  assert.deepEqual(
    items.map(({ snapshot }) => snapshot.tweetId),
    ["101"],
  );
  assert.equal(items[0].snapshot.likes, 0);
  assert.equal(items[0].snapshot.views, null);
  assert.equal(reservations, 1);
  assert.equal(requests, 1);
  const topLevel = await fetchTwitterApiTweetsByIds(["103"], {
    ...options,
    fetch: mockFetch(() =>
      json({ tweets: [{ id: "103", text: "Three", viewCount: 7 }] }),
    ),
  });
  assert.equal(topLevel[0].snapshot.views, 7);
  assert.equal(reservations, 2);
  assert.deepEqual(await fetchTwitterApiTweetsByIds([], options), []);
  assert.equal(reservations, 2);
  await assert.rejects(
    fetchTwitterApiTweetsByIds(["101", "bad"], options),
    /tweet IDs/,
  );
  await assert.rejects(
    fetchTwitterApiTweetsByIds(
      Array.from({ length: 21 }, (_, i) => String(i + 1)),
      options,
    ),
    /tweet IDs/,
  );
  assert.equal(reservations, 2);
  await assert.rejects(
    fetchTwitterApiTweetsByIds(["101"], {
      ...options,
      fetch: mockFetch(() =>
        json({ tweets: [{ id: "999", text: "Foreign" }] }),
      ),
    }),
    /unrequested/,
  );
  for (const response of [
    json({ tweets: "bad" }),
    json({ tweets: [], status: "error" }),
    json({ error: "provider secret" }, 401),
  ]) {
    await assert.rejects(
      fetchTwitterApiTweetsByIds(["101"], {
        ...options,
        fetch: mockFetch(() => response),
      }),
      (error: unknown) =>
        error instanceof Error && !error.message.includes("provider secret"),
    );
  }
  let fetched = false;
  await assert.rejects(
    fetchTwitterApiTweetsByIds(["101"], {
      ...options,
      beforeProviderRequest: () => {
        throw new Error("Quota exhausted");
      },
      fetch: mockFetch(() => {
        fetched = true;
        return json({ tweets: [] });
      }),
    }),
    /Quota exhausted/,
  );
  assert.equal(fetched, false);
});
