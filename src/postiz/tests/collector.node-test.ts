import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ContentJobStore } from "../store.js";
import {
  collectSources,
  sourceBackoffMs,
  type CollectorOptions,
  type SourceCheckClaim,
  type SourceCollectorStore,
} from "../collector.js";
import {
  sourceIdentity,
  sourceReadKey,
  type SourceConfig,
  type SourceInput,
} from "../sources.js";

type CheckState = Omit<SourceCheckClaim, "leaseToken" | "leaseUntil"> & {
  configHash?: string;
  checkedAt: number | null;
  nextCheckAt: number;
  lastFailure: string | null;
  leaseToken: string | null;
  leaseUntil: number | null;
};

/** In-memory port tests exercise the collector; the store tests cover SQL atomicity. */
class MemorySourceStore implements SourceCollectorStore {
  readonly states = new Map<string, CheckState>();
  readonly candidates = new Map<string, SourceInput>();
  readonly metadata = new Map<string, { origin: string; primary: boolean }>();
  private leaseSequence = 0;

  constructor(readonly now: () => number) {}

  ensureSources(
    input: Parameters<SourceCollectorStore["ensureSources"]>[0],
  ): void {
    for (const source of input.sources) {
      const key = `${input.brandId}/${source.id}`;
      const existing = this.states.get(key);
      if (!existing) {
        this.states.set(key, {
          brandId: input.brandId,
          sourceId: source.id,
          configHash: source.configHash,
          checkedAt: null,
          nextCheckAt: 0,
          lastFailure: null,
          checkpoint: null,
          failureCount: 0,
          leaseToken: null,
          leaseUntil: null,
        });
      } else if (existing.configHash !== source.configHash) {
        existing.configHash = source.configHash;
        existing.checkpoint = null;
        existing.nextCheckAt = 0;
      }
    }
  }

  claimDueSource(
    input: Parameters<SourceCollectorStore["claimDueSource"]>[0],
  ): SourceCheckClaim | null {
    const state = [...this.states.values()]
      .filter(
        (item) =>
          item.brandId === input.brandId &&
          input.sourceIds.includes(item.sourceId) &&
          !input.excludeSourceIds?.includes(item.sourceId) &&
          item.nextCheckAt <= this.now() &&
          (!item.leaseUntil || item.leaseUntil <= this.now()),
      )
      .sort(
        (a, b) =>
          (a.checkedAt ?? -1) - (b.checkedAt ?? -1) ||
          a.sourceId.localeCompare(b.sourceId),
      )[0];
    if (!state) return null;
    state.leaseToken = `lease-${++this.leaseSequence}`;
    state.leaseUntil = this.now() + input.leaseMs;
    return {
      ...state,
      checkpoint: structuredClone(state.checkpoint),
      leaseToken: state.leaseToken,
      leaseUntil: state.leaseUntil,
    };
  }

  private leased(claim: SourceCheckClaim): CheckState {
    const state = this.states.get(`${claim.brandId}/${claim.sourceId}`);
    if (
      !state ||
      state.leaseToken !== claim.leaseToken ||
      !state.leaseUntil ||
      state.leaseUntil <= this.now()
    ) {
      const error = new Error("Source lease expired");
      error.name = "LeaseLostError";
      throw error;
    }
    return state;
  }

  completeSourceCheck(
    claim: SourceCheckClaim,
    input: Parameters<SourceCollectorStore["completeSourceCheck"]>[1],
  ): { inserted: number; duplicates: number } {
    const state = this.leased(claim);
    let inserted = 0;
    let duplicates = 0;
    for (const item of input.inputs) {
      const key = `${claim.brandId}/${item.url}`;
      if (this.candidates.has(key)) duplicates += 1;
      else {
        this.candidates.set(key, structuredClone(item));
        inserted += 1;
      }
    }
    this.metadata.set(claim.sourceId, {
      origin: input.origin,
      primary: input.primary === true,
    });
    Object.assign(state, {
      checkedAt: input.checkedAt,
      nextCheckAt: input.nextCheckAt,
      checkpoint: structuredClone(input.checkpoint),
      failureCount: 0,
      lastFailure: null,
      leaseToken: null,
      leaseUntil: null,
    });
    return { inserted, duplicates };
  }

  failSourceCheck(
    claim: SourceCheckClaim,
    input: Parameters<SourceCollectorStore["failSourceCheck"]>[1],
  ): void {
    const state = this.leased(claim);
    Object.assign(state, {
      ...input,
      failureCount: state.failureCount + 1,
      leaseToken: null,
      leaseUntil: null,
    });
  }
}

const source = (id: string) => ({
  type: "url" as const,
  id,
  url: `https://example.com/${id}`,
  text: `Original ${id}`,
});
const done: NonNullable<CollectorOptions["discover"]> = async (config) => ({
  inputs: [
    { url: `https://example.com/${config.id}`, text: `Original ${config.id}` },
  ],
  checkpoint: null,
  complete: true,
});

void test("one source failure records independent backoff and does not block healthy sources", async () => {
  let time = 1_000_000;
  const store = new MemorySourceStore(() => time);
  const options = {
    store,
    brandId: "tokenhot",
    workerId: "worker",
    now: () => time,
    sources: [source("bad"), { ...source("good"), primary: true }],
    maxSourcesPerTick: 2,
    retryBaseMs: 1000,
    sourceOptions: { getxApiKey: "secret-key" },
    discover: async (
      config: Parameters<NonNullable<CollectorOptions["discover"]>>[0],
    ) => {
      if (config.id === "bad") throw new Error("Provider rejected secret-key");
      return done(config, {});
    },
  };
  const result = await collectSources(options);
  assert.equal(result.checked, 2);
  assert.equal(result.failed, 1);
  assert.equal(result.inserted, 1);
  const bad = store.states.get("tokenhot/bad")!;
  const good = store.states.get("tokenhot/good")!;
  assert.equal(bad.checkedAt, time);
  assert.equal(bad.nextCheckAt, time + 1000);
  assert.equal(bad.failureCount, 1);
  assert.doesNotMatch(bad.lastFailure!, /secret-key/);
  assert.equal(good.lastFailure, null);
  assert.deepEqual(store.metadata.get("good"), {
    origin: "url",
    primary: true,
  });
  time += 1000;
  const retry = await collectSources(options);
  assert.equal(retry.checked, 1);
  assert.equal(bad.failureCount, 2);
  assert.equal(bad.nextCheckAt, time + 2000);
});

void test("malformed individual configs persist their own backoff while real RSS and manual discovery continue", async () => {
  let time = 1_000_000;
  let networkCalls = 0;
  const store = new MemorySourceStore(() => time);
  const invalid: unknown[] = [
    { type: "json-file" },
    { id: "bad-path", type: "json-file", path: 42 },
    { id: "missing-type", url: "https://example.com/missing" },
    {
      id: "bad id",
      type: "url",
      url: "https://example.com/bad-id",
      text: "Material",
    },
    { type: "unsupported" },
    { type: "url" },
    { id: "invalid-url", type: "url", url: "not a URL" },
    { type: "getx-user", userName: 42 },
    { type: "getx-search", query: "" },
    null,
    ["not", "an", "object"],
  ];
  const options: CollectorOptions = {
    store,
    brandId: "tokenhot",
    workerId: "first",
    now: () => time,
    retryBaseMs: 1000,
    maxSourcesPerTick: 20,
    maxCandidatesPerTick: 40,
    sources: [
      ...invalid,
      source("manual"),
      { id: "feed", type: "rss", url: "https://example.com/feed.xml" },
    ] as SourceConfig[],
    sourceOptions: {
      getxApiKey: "test-only-no-paid-calls",
      lookup: async () => [{ address: "8.8.8.8", family: 4 }],
      fetch: async (input) => {
        networkCalls++;
        assert.equal(String(input), "https://example.com/feed.xml");
        return new Response(
          "<rss><channel><item><title>Source announcement</title><link>https://example.com/announcement</link><description>Source summary</description></item></channel></rss>",
          {
            headers: { "content-type": "application/rss+xml" },
          },
        );
      },
    },
  };
  const first = await collectSources(options);
  assert.equal(first.failed, invalid.length);
  assert.equal(first.inserted, 2);
  assert.equal(first.checked, invalid.length + 2);
  assert.equal(networkCalls, 1);
  for (const input of invalid) {
    const id = sourceIdentity(input);
    const state = store.states.get(`tokenhot/${id}`)!;
    assert.equal(state.failureCount, 1);
    assert.equal(state.checkedAt, time);
    assert.equal(state.nextCheckAt, time + 1000);
    assert.match(state.lastFailure!, /Source|source|GetXAPI/);
    assert.doesNotMatch(
      state.lastFailure!,
      /startsWith|Received undefined|Cannot read properties/,
    );
    assert.equal(sourceReadKey(input), state.configHash);
  }
  const afterRestart = await collectSources({
    ...options,
    workerId: "restarted",
  });
  assert.equal(afterRestart.checked, 0);
  assert.equal(networkCalls, 1);
  time += 1000;
  const retry = await collectSources({ ...options, workerId: "restarted" });
  assert.equal(retry.checked, invalid.length);
  assert.equal(retry.failed, invalid.length);
  assert.equal(networkCalls, 1);
  for (const input of invalid) {
    const state = store.states.get(`tokenhot/${sourceIdentity(input)}`)!;
    assert.equal(state.failureCount, 2);
    assert.equal(state.nextCheckAt, time + 2000);
  }
  // An explicit ID preserves the checkpoint identity when its operator fixes it.
  const repaired = await collectSources({
    ...options,
    sources: [source("bad-path")],
  });
  assert.equal(repaired.failed, 0);
  assert.equal(repaired.inserted, 1);
  assert.equal(store.states.get("tokenhot/bad-path")?.failureCount, 0);
});

void test("synthetic IDs for malformed entries are stable while duplicate explicit IDs remain a configuration error", async () => {
  assert.equal(
    sourceIdentity({ type: "json-file", id: "bad id" }),
    sourceIdentity({ id: "bad id", type: "json-file" }),
  );
  assert.equal(
    sourceReadKey({ unrelated: true }),
    sourceReadKey({ unrelated: true }),
  );
  const store = new MemorySourceStore(() => 1_000_000);
  await assert.rejects(
    () =>
      collectSources({
        store,
        brandId: "tokenhot",
        workerId: "worker",
        sources: [source("same"), source("same")],
      }),
    /Duplicate configured source id/,
  );
  assert.equal(store.states.size, 0);
});

void test("real SQLite persists malformed-source backoff and successful collection across closing and reopening", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "postiz-collector-"));
  const path = join(directory, "content.sqlite");
  let time = 1_000_000;
  let calls = 0;
  let store = new ContentJobStore(path, { now: () => time });
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const malformed = { type: "json-file" };
  const malformedId = sourceIdentity(malformed);
  const options: Omit<CollectorOptions, "store"> = {
    brandId: "tokenhot",
    workerId: "worker",
    now: () => time,
    retryBaseMs: 1000,
    sources: [
      malformed,
      { type: "rss", id: "healthy", url: "https://example.com/feed.xml" },
    ] as SourceConfig[],
    sourceOptions: {
      lookup: async () => [{ address: "8.8.8.8", family: 4 }],
      fetch: async () => {
        calls++;
        return new Response(
          "<rss><channel><item><title>A primary release</title><link>https://example.com/release</link><description>Release notes</description></item></channel></rss>",
          {
            headers: { "content-type": "application/rss+xml" },
          },
        );
      },
    },
  };
  const first = await collectSources({ ...options, store });
  assert.equal(first.failed, 1);
  assert.equal(first.inserted, 1);
  assert.equal(calls, 1);
  store.close();
  store = new ContentJobStore(path, { now: () => time });
  const bad = store
    .listSourceCheckpoints({ brandId: "tokenhot" })
    .find((state) => state.sourceId === malformedId)!;
  assert.equal(bad.failureCount, 1);
  assert.equal(bad.nextCheckAt, time + 1000);
  assert.match(bad.lastFailure!, /JSON source path/);
  assert.equal(store.listCandidates({ brandId: "tokenhot" }).length, 1);
  const restarted = await collectSources({
    ...options,
    store,
    workerId: "after-restart",
  });
  assert.equal(restarted.checked, 0);
  assert.equal(calls, 1);
  time += 1000;
  const retry = await collectSources({ ...options, store });
  assert.equal(retry.checked, 1);
  assert.equal(retry.failed, 1);
  assert.equal(calls, 1);
  const retried = store
    .listSourceCheckpoints({ brandId: "tokenhot" })
    .find((state) => state.sourceId === malformedId)!;
  assert.equal(retried.failureCount, 2);
  assert.equal(retried.nextCheckAt, time + 2000);
});

void test("persisted checkedAt rotates fair source work and restart does not repeat a completed batch", async () => {
  const time = 2_000_000;
  const store = new MemorySourceStore(() => time);
  const options = {
    store,
    brandId: "brand",
    workerId: "first-process",
    now: () => time,
    maxSourcesPerTick: 2,
    sources: [source("a"), source("b"), source("c"), source("d")],
    discover: done,
  };
  const first = await collectSources(options);
  assert.deepEqual(
    first.sources.map((item) => item.sourceId),
    ["a", "b"],
  );
  const afterRestart = await collectSources({
    ...options,
    workerId: "second-process",
  });
  assert.deepEqual(
    afterRestart.sources.map((item) => item.sourceId),
    ["c", "d"],
  );
  assert.equal(store.candidates.size, 4);
  const idle = await collectSources({ ...options, workerId: "third-process" });
  assert.equal(idle.checked, 0);
});

void test("a large source gets only its fair share and its remainder persists until the next tick", async () => {
  let time = 3_000_000;
  const store = new MemorySourceStore(() => time);
  const configs = ["a", "b", "c"].map((id) => ({
    type: "rss" as const,
    id,
    url: `https://example.com/${id}.xml`,
    limit: 10,
  }));
  const calls: string[] = [];
  const options = {
    store,
    brandId: "brand",
    workerId: "worker",
    now: () => time,
    maxSourcesPerTick: 3,
    maxCandidatesPerTick: 6,
    sources: configs,
    sourceOptions: {
      lookup: async () => [{ address: "8.8.8.8", family: 4 }],
      fetch: (async (input: string | URL | Request) => {
        const url = new URL(String(input));
        calls.push(url.href);
        const prefix = url.pathname;
        return new Response(
          `<rss><channel>${[1, 2, 3, 4, 5, 6].map((id) => `<item><link>https://example.com${prefix}/${id}</link></item>`).join("")}</channel></rss>`,
        );
      }) as typeof fetch,
    },
  };
  const first = await collectSources(options);
  assert.equal(first.read, 6);
  assert.deepEqual(
    first.sources.map((item) => item.read),
    [2, 2, 2],
  );
  assert.equal(calls.length, 3);
  assert.equal(
    first.sources.every((item) => item.complete === false),
    true,
  );
  time += 1000;
  const resumed = await collectSources({
    ...options,
    workerId: "restart",
    sourceOptions: {
      ...options.sourceOptions,
      fetch: (async () => {
        throw new Error("Snapshot fetched twice");
      }) as typeof fetch,
    },
  });
  assert.equal(resumed.read, 6);
  assert.equal(resumed.failed, 0);
  assert.equal(calls.length, 3);
  assert.equal(store.candidates.size, 12);
});

void test("a failed continuation retains its old checkpoint for the next attempt", async () => {
  const time = 4_000_000;
  const store = new MemorySourceStore(() => time);
  const config = source("saved");
  store.ensureSources({
    brandId: "brand",
    sources: [
      { id: "saved", origin: "url", configHash: sourceReadKey(config) },
    ],
  });
  const state = store.states.get("brand/saved")!;
  const checkpoint = { marker: "last committed page" };
  state.checkpoint = checkpoint;
  const result = await collectSources({
    store,
    brandId: "brand",
    workerId: "worker",
    sources: [config],
    now: () => time,
    discover: async (_source, options) => {
      assert.deepEqual(options.checkpoint, checkpoint);
      throw new Error("Transient read error");
    },
  });
  assert.equal(result.failed, 1);
  assert.deepEqual(state.checkpoint, checkpoint);
  assert.equal(store.candidates.size, 0);
});

void test("lease loss cannot overwrite source state and does not block other due sources", async () => {
  let time = 5_000_000;
  const store = new MemorySourceStore(() => time);
  const result = await collectSources({
    store,
    brandId: "brand",
    workerId: "worker",
    now: () => time,
    leaseMs: 1000,
    maxSourcesPerTick: 2,
    sources: [source("a"), source("b")],
    discover: async (config) => {
      if (config.id === "a") time += 1001;
      return done(config, {});
    },
  });
  assert.equal(result.sources[0].outcome, "lease_lost");
  assert.equal(result.sources[1].outcome, "collected");
  assert.equal(store.states.get("brand/a")!.checkedAt, null);
  assert.equal(store.candidates.size, 1);
  assert.equal(
    result.read,
    result.sources.reduce((total, item) => total + item.read, 0),
  );
});

void test("disabled paid sources are not registered or discovered and manual text enters the pool", async () => {
  const store = new MemorySourceStore(() => 6_000_000);
  const result = await collectSources({
    store,
    brandId: "brand",
    workerId: "worker",
    now: () => 6_000_000,
    sources: [
      { type: "getx-search", id: "paid-example", query: "API", enabled: false },
      { ...source("manual"), primary: true },
    ],
    sourceOptions: {
      fetch: (async () => {
        throw new Error("No network is needed for supplied material");
      }) as typeof fetch,
    },
  });
  assert.equal(result.skippedDisabled, 1);
  assert.equal(result.inserted, 1);
  assert.equal(store.states.has("brand/paid-example"), false);
  assert.equal([...store.candidates.values()][0].text, "Original manual");
});

void test("backoff is exponential and capped, and invalid configuration fails before work", async () => {
  assert.equal(sourceBackoffMs(1, 1000, 10_000), 1000);
  assert.equal(sourceBackoffMs(3, 1000, 10_000), 4000);
  assert.equal(sourceBackoffMs(30, 1000, 10_000), 10_000);
  assert.throws(() => sourceBackoffMs(0));
  const store = new MemorySourceStore(() => 7_000_000);
  await assert.rejects(
    collectSources({
      store,
      sources: [source("a")],
      brandId: "brand",
      workerId: "worker",
      maxCandidatesPerTick: 101,
    }),
    /maxCandidatesPerTick/,
  );
  assert.equal(store.states.size, 0);
});
