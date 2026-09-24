import {
  assertSourceConfig,
  discoverSourceBatch,
  sourceIdentity,
  sourceReadKey,
  type SourceConfig,
  type SourceDiscoveryBatch,
  type SourceInput,
  type SourceOptions,
} from "./sources.js";
import { boundedInteger } from "./network.js";

/** A narrow persistence port keeps source collection separate from publishing. */
export interface SourceCheckClaim {
  brandId: string;
  sourceId: string;
  checkpoint: unknown;
  failureCount: number;
  leaseToken: string;
  leaseUntil: number;
}

type MaybePromise<T> = T | Promise<T>;

export interface SourceCollectorStore {
  /** Config changes invalidate the unfinished read and make the source due. */
  ensureSources(input: {
    brandId: string;
    sources: {
      id: string;
      origin: string;
      primary?: boolean;
      configHash?: string;
    }[];
  }): MaybePromise<unknown>;
  /** Atomically claim a due, unleased source, oldest checkedAt first (NULL first). */
  claimDueSource(input: {
    brandId: string;
    sourceIds: string[];
    workerId: string;
    leaseMs: number;
    excludeSourceIds?: string[];
  }): MaybePromise<SourceCheckClaim | null>;
  /** Candidate upserts and checkpoint progress MUST commit in one transaction. */
  completeSourceCheck(
    claim: SourceCheckClaim,
    input: {
      checkedAt: number;
      nextCheckAt: number;
      checkpoint: unknown;
      inputs: SourceInput[];
      origin: string;
      primary?: boolean;
    },
  ): MaybePromise<{ inserted: number; duplicates: number }>;
  /** Preserve checkpoint, increment failureCount, release only this lease. */
  failSourceCheck(
    claim: SourceCheckClaim,
    input: {
      checkedAt: number;
      nextCheckAt: number;
      lastFailure: string;
    },
  ): MaybePromise<unknown>;
}

export interface CollectorOptions {
  store: SourceCollectorStore;
  sources: readonly SourceConfig[];
  brandId: string;
  workerId: string;
  sourceOptions?: SourceOptions;
  now?: () => number;
  /** Source work budget, independent from the selector's model-evaluation cap. */
  maxSourcesPerTick?: number;
  /** Includes duplicates returned by providers, so repeated data is still bounded. */
  maxCandidatesPerTick?: number;
  maxBatchPerSource?: number;
  checkIntervalMs?: number;
  continuationDelayMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  leaseMs?: number;
  discover?: (
    source: SourceConfig,
    options: SourceOptions & { checkpoint?: unknown; batchSize?: number },
  ) => Promise<SourceDiscoveryBatch>;
}

export interface SourceCollectionResult {
  sourceId: string;
  outcome: "collected" | "failed" | "lease_lost";
  read: number;
  inserted: number;
  duplicates: number;
  complete?: boolean;
  nextCheckAt?: number;
  error?: string;
}

export interface CollectionResult {
  checked: number;
  read: number;
  inserted: number;
  duplicates: number;
  failed: number;
  skippedDisabled: number;
  sources: SourceCollectionResult[];
}

export function sourceBackoffMs(
  consecutiveFailures: number,
  baseMs = 60_000,
  maximumMs = 86_400_000,
): number {
  if (!Number.isSafeInteger(consecutiveFailures) || consecutiveFailures < 1)
    throw new Error("Source failure count must be a positive integer");
  boundedInteger(baseMs, 60_000, 86_400_000, "retryBaseMs");
  boundedInteger(maximumMs, 86_400_000, 604_800_000, "retryMaxMs");
  if (maximumMs < baseMs)
    throw new Error("retryMaxMs must be at least retryBaseMs");
  return Math.min(
    maximumMs,
    baseMs * 2 ** Math.min(consecutiveFailures - 1, 30),
  );
}

function sourceError(error: unknown, options: SourceOptions): string {
  let message =
    error instanceof Error ? error.message : "Source collection failed";
  for (const secret of [
    options.firecrawlApiKey,
    options.getxApiKey,
    options.getxApiToken,
  ]) {
    if (secret) message = message.split(secret).join("[redacted]");
  }
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .slice(0, 1500);
}

function leaseLost(error: unknown): boolean {
  return error instanceof Error && error.name === "LeaseLostError";
}

/**
 * Every source advances independently. A failed check records its own backoff;
 * it does not prevent the remaining due sources from filling the candidate pool.
 * The selector separately limits model evaluations; no model or publisher is
 * called here. Existing text is ingested as evidence, not certified as fact.
 */
export async function collectSources(
  options: CollectorOptions,
): Promise<CollectionResult> {
  if (!options.brandId?.trim() || !options.workerId?.trim())
    throw new Error("Collector brandId and workerId are required");
  if (!Array.isArray(options.sources) || options.sources.length > 50)
    throw new Error("Collector accepts at most 50 configured sources");
  const maxSources = boundedInteger(
    options.maxSourcesPerTick,
    5,
    50,
    "maxSourcesPerTick",
  );
  const maxCandidates = boundedInteger(
    options.maxCandidatesPerTick,
    50,
    100,
    "maxCandidatesPerTick",
  );
  const batchCap = boundedInteger(
    options.maxBatchPerSource,
    10,
    50,
    "maxBatchPerSource",
  );
  const fairShare = Math.min(
    batchCap,
    Math.max(1, Math.floor(maxCandidates / maxSources)),
  );
  const interval = boundedInteger(
    options.checkIntervalMs,
    86_400_000,
    604_800_000,
    "checkIntervalMs",
  );
  const continuationDelay = boundedInteger(
    options.continuationDelayMs,
    1000,
    60_000,
    "continuationDelayMs",
  );
  const leaseMs = boundedInteger(
    options.leaseMs,
    300_000,
    3_600_000,
    "leaseMs",
  );
  // Validate backoff settings before taking any leases.
  sourceBackoffMs(1, options.retryBaseMs, options.retryMaxMs);
  const clock = options.now ?? Date.now;
  const now = () => {
    const timestamp = clock();
    if (!Number.isSafeInteger(timestamp) || timestamp < 0)
      throw new Error(
        "Collector clock must return a nonnegative millisecond timestamp",
      );
    return timestamp;
  };
  now();
  const sourceOptions = options.sourceOptions ?? {};
  const sources = new Map<
    string,
    { input: unknown; origin: string; primary: boolean; configHash: string }
  >();
  let skippedDisabled = 0;
  for (const source of options.sources) {
    const record =
      source !== null && typeof source === "object" && !Array.isArray(source)
        ? source
        : null;
    if (record?.enabled === false) {
      skippedDisabled += 1;
      continue;
    }
    const id = sourceIdentity(source, sourceOptions);
    if (sources.has(id))
      throw new Error(`Duplicate configured source id: ${id}`);
    sources.set(id, {
      input: source,
      origin:
        typeof record?.type === "string" &&
        ["url", "rss", "json-file", "getx-search", "getx-user"].includes(
          record.type,
        )
          ? record.type
          : "invalid",
      primary: record?.primary === true,
      configHash: sourceReadKey(source, sourceOptions),
    });
  }
  const result: CollectionResult = {
    checked: 0,
    read: 0,
    inserted: 0,
    duplicates: 0,
    failed: 0,
    skippedDisabled,
    sources: [],
  };
  if (!sources.size) return result;
  await options.store.ensureSources({
    brandId: options.brandId,
    sources: [...sources].map(([id, source]) => ({
      id,
      origin: source.origin,
      primary: source.primary,
      configHash: source.configHash,
    })),
  });
  const checkedIds = new Set<string>();
  const discover = options.discover ?? discoverSourceBatch;
  while (checkedIds.size < maxSources && result.read < maxCandidates) {
    const claim = await options.store.claimDueSource({
      brandId: options.brandId,
      sourceIds: [...sources.keys()],
      workerId: options.workerId,
      leaseMs,
      excludeSourceIds: [...checkedIds],
    });
    if (!claim) break;
    const entry = sources.get(claim.sourceId);
    if (
      !entry ||
      claim.brandId !== options.brandId ||
      checkedIds.has(claim.sourceId)
    )
      throw new Error("Source store returned an invalid or repeated claim");
    checkedIds.add(claim.sourceId);
    result.checked += 1;
    const batchSize = Math.min(fairShare, maxCandidates - result.read);
    let sourceRead = 0;
    try {
      // Malformed entries are registered and leased before validation, so an
      // absent path/type or invalid ID receives its own persistent backoff.
      assertSourceConfig(entry.input);
      const source = entry.input;
      const checkIntervalMs = boundedInteger(
        source.checkIntervalMs,
        interval,
        604_800_000,
        "Source checkIntervalMs",
      );
      const batch = await discover(source, {
        ...sourceOptions,
        now: () => new Date(now()),
        checkpoint: claim.checkpoint,
        batchSize,
      });
      if (
        !Array.isArray(batch.inputs) ||
        batch.inputs.length > batchSize ||
        typeof batch.complete !== "boolean" ||
        batch.complete !== (batch.checkpoint === null)
      )
        throw new Error("Source discovery returned an invalid bounded batch");
      // The acquisition budget measures provider data even if every URL is an
      // existing candidate, or if the lease expires before the local commit.
      result.read += batch.inputs.length;
      sourceRead = batch.inputs.length;
      const checkedAt = now();
      const nextCheckAt =
        checkedAt + (batch.complete ? checkIntervalMs : continuationDelay);
      const saved = await options.store.completeSourceCheck(claim, {
        checkedAt,
        nextCheckAt,
        checkpoint: batch.checkpoint,
        inputs: batch.inputs,
        origin: source.type,
        primary: source.primary === true,
      });
      result.inserted += saved.inserted;
      result.duplicates += saved.duplicates;
      result.sources.push({
        sourceId: claim.sourceId,
        outcome: "collected",
        read: batch.inputs.length,
        inserted: saved.inserted,
        duplicates: saved.duplicates,
        complete: batch.complete,
        nextCheckAt,
      });
    } catch (error) {
      result.failed += 1;
      let errorMessage = sourceError(error, sourceOptions);
      if (leaseLost(error)) {
        result.sources.push({
          sourceId: claim.sourceId,
          outcome: "lease_lost",
          read: sourceRead,
          inserted: 0,
          duplicates: 0,
          error: errorMessage,
        });
        continue;
      }
      const checkedAt = now();
      const nextCheckAt =
        checkedAt +
        sourceBackoffMs(
          claim.failureCount + 1,
          options.retryBaseMs,
          options.retryMaxMs,
        );
      let outcome: SourceCollectionResult["outcome"] = "failed";
      try {
        await options.store.failSourceCheck(claim, {
          checkedAt,
          nextCheckAt,
          lastFailure: errorMessage,
        });
      } catch (stateError) {
        if (leaseLost(stateError)) outcome = "lease_lost";
        errorMessage =
          `${errorMessage}; checkpoint update failed: ${sourceError(stateError, sourceOptions)}`.slice(
            0,
            1500,
          );
      }
      result.sources.push({
        sourceId: claim.sourceId,
        outcome,
        read: sourceRead,
        inserted: 0,
        duplicates: 0,
        nextCheckAt,
        error: errorMessage,
      });
    }
  }
  return result;
}
