import { collectSources, type CollectorOptions } from "./collector.js";
import {
  discoverSourceBatch,
  fetchTwitterApiTweetsByIds,
  sourceIdentity,
  loadSource,
  type SourceConfig,
  type SourceOptions,
} from "./sources.js";
import { sourceMaterialKey } from "./identity.js";
import { selectSocialCandidates } from "./social-selector.js";
import type { ContentJobStore } from "./store.js";
import type { BrandConfig } from "./validation.js";
import type { ContentModel } from "./models.js";
import type { XPostSnapshot, SocialSelectionInput } from "./social-types.js";
import { enqueueApprovedTopics, selectAndQueue } from "./pipeline.js";
import { safeError } from "./config.js";

const DAY = 86_400_000;
const ACCOUNTS = new Set([
  "ooffooxx",
  "cheaperinfer",
  "wavespeed_ai",
  "openrouter",
  "fal",
]);
export function competitorSources(
  sources: readonly SourceConfig[],
): SourceConfig[] {
  return sources
    .filter(
      (source) =>
        source.type === "twitterapi-user" &&
        source.enabled !== false &&
        ACCOUNTS.has(source.userName.toLowerCase()),
    )
    .map((source) => ({
      ...source,
      maxPages: 1,
      limit: 20,
      maxAgeHours: 168,
      checkIntervalMs: DAY,
    }));
}

/** Beijing 09:00 daily reads with persisted per-request reservations. */
export async function collectCompetitorSources(options: {
  store: ContentJobStore;
  brandId: string;
  sources: readonly SourceConfig[];
  sourceOptions?: SourceOptions;
  workerId: string;
  now?: (() => number) | number;
  discover?: CollectorOptions["discover"];
}) {
  const { store, brandId } = options;
  const now =
    typeof options.now === "function"
      ? options.now
      : () => (options.now as number) ?? Date.now();
  const { day } = store.socialQuotas(brandId);
  const empty = {
    checked: 0,
    read: 0,
    inserted: 0,
    duplicates: 0,
    failed: 0,
    skippedDisabled: 0,
    sources: [],
  };
  if (now() < day.startsAt + 9 * 3_600_000) return { ...empty, refreshed: 0 };
  const sources = competitorSources(options.sources);
  const snapshots = new Map<string, XPostSnapshot>();
  const result = await collectSources({
    sources,
    brandId,
    workerId: options.workerId,
    now,
    maxSourcesPerTick: 5,
    maxCandidatesPerTick: 100,
    maxBatchPerSource: 20,
    sourceOptions: options.sourceOptions,
    store: {
      ensureSources: (input) => store.ensureSources(input),
      claimDueSource: (input) => {
        store.prepareSocialSourceDay(brandId, input.sourceIds);
        return store.claimDueSource(input);
      },
      completeSourceCheck: (claim, input) =>
        store.completeSocialSourceCheck(
          claim,
          {
            ...input,
            nextCheckAt: input.checkpoint
              ? now()
              : day.resetsAt + 9 * 3_600_000,
          },
          snapshots,
        ),
      failSourceCheck: (claim, input) =>
        store.failSourceCheck(claim, {
          ...input,
          nextCheckAt: day.resetsAt + 9 * 3_600_000,
        }),
    },
    discover: (source, readOptions) =>
      (options.discover ?? discoverSourceBatch)(source, {
        ...readOptions,
        now: () => new Date(now()),
        beforeProviderRequest: () =>
          store.reserveSocialProviderCall(
            brandId,
            "timeline",
            sourceIdentity(source, options.sourceOptions),
          ),
        onSocialSnapshot: (input, snapshot) =>
          snapshots.set(sourceMaterialKey(input), snapshot),
      }),
  });
  let refreshed = 0;
  const activeIds = new Set(
    sources.map((source) => sourceIdentity(source, options.sourceOptions)),
  );
  const prior = new Set(
    store
      .providerRequests(brandId)
      .filter((call) => call.kind === "refresh")
      .flatMap((call) => call.tweetIds),
  );
  const pending = store
    .listCandidates({ brandId, limit: 10000 })
    .filter((candidate) => {
      if (
        !activeIds.has(candidate.sourceId ?? "") ||
        store.isSocialProtected(candidate)
      )
        return false;
      const observed = store.latestSocialSnapshot(candidate.id);
      const published =
        observed?.publishedAt ??
        candidate.document?.publishedAt ??
        candidate.input.publishedAt;
      return (
        published &&
        Date.parse(published) >= now() - 7 * DAY &&
        (!observed || observed.observedAt < day.startsAt) &&
        !prior.has(candidate.urlKey.replace("x-status:", ""))
      );
    })
    .sort(
      (a, b) =>
        (store.latestSocialSnapshot(a.id)?.observedAt ?? 0) -
        (store.latestSocialSnapshot(b.id)?.observedAt ?? 0),
    )
    .slice(0, Math.max(0, 100 - prior.size));
  while (pending.length && store.socialQuotas(brandId).provider.used < 10) {
    const batch = pending.splice(0, 20);
    const ids = batch.map((candidate) =>
      candidate.urlKey.replace("x-status:", ""),
    );
    try {
      const data = await fetchTwitterApiTweetsByIds(ids, {
        ...options.sourceOptions,
        now: () => new Date(now()),
        beforeProviderRequest: () =>
          store.reserveSocialProviderCall(
            brandId,
            "refresh",
            ids.join(","),
            ids,
          ),
      });
      const byKey = new Map(
        batch.map((candidate) => [candidate.urlKey, candidate]),
      );
      for (const entry of data) {
        const candidate = byKey.get(sourceMaterialKey(entry.input));
        if (candidate) {
          store.recordSocialObservation(candidate.id, entry.snapshot);
          refreshed++;
        }
      }
      const missing = ids.length - data.length;
      store.recordWorkbenchEvent({
        brandId,
        stage: "social_metrics",
        status: "finish",
        detail: `更新 ${data.length} 条指标；${missing} 条接口未返回，保留原数据`,
      });
    } catch (error) {
      store.recordWorkbenchEvent({
        brandId,
        stage: "social_metrics",
        status: "error",
        detail: safeError(error),
      });
    }
  }
  return { ...result, refreshed };
}

export async function selectSocialAndQueue(options: {
  store: ContentJobStore;
  brand: BrandConfig;
  integrationId: string;
  model: ContentModel;
  sourceOptions?: SourceOptions;
  now?: number;
}) {
  const { store, brand } = options;
  const sourceIds = store
    .listSourceCheckpoints({ brandId: brand.id })
    .filter(
      (source) =>
        source.origin === "twitterapi-user" &&
        /twitterapi-(ooffooxx|cheaperinfer|wavespeed_ai|openrouter|fal)$/i.test(
          source.sourceId,
        ),
    )
    .map((source) => source.sourceId);
  const candidates =
    store.socialQuotas(brand.id).selection.used < 40
      ? store.socialEvaluationCandidates(brand.id, sourceIds)
      : [];
  const material: SocialSelectionInput[] = [];
  let fetchFailed = 0;
  for (const candidate of candidates) {
    try {
      store.beginSocialEvaluation([candidate.id]);
    } catch {
      continue;
    }
    try {
      const document =
        candidate.document ??
        (await loadSource(candidate.input, options.sourceOptions));
      if (!candidate.document)
        store.recordCandidateDocument(candidate.id, document);
      material.push({
        id: candidate.id,
        ...document,
        firstSeenAt: candidate.createdAt,
        primary: candidate.primary,
        sourceType: candidate.origin,
        social: store.latestSocialSnapshot(candidate.id)!,
      });
    } catch {
      fetchFailed++;
      store.saveSocialSelection(brand.id, {
        selection: {
          candidateDecisions: [],
          topics: [],
          modelCalls: 0,
          warnings: [],
        },
        assessments: [],
        failures: [
          {
            candidateId: candidate.id,
            code: "provider",
            message: "素材正文读取失败，等待有界重试",
          },
        ],
      });
    }
  }
  if (material.length) {
    const result = await selectSocialCandidates(
      {
        brand,
        candidates: material,
        history: store.socialHistory(brand.id),
        existingTopics: store.listTopics({ brandId: brand.id }),
        now: options.now,
      },
      {
        model: {
          invoke: (request) => {
            store.reserveSocialSelectionCall({
              brandId: brand.id,
              task: request.task as "selection" | "selection_review",
              candidateIds: material.map((candidate) => candidate.id),
            });
            return options.model.invoke(request);
          },
        },
      },
    );
    store.saveSocialSelection(brand.id, result);
  } else if (store.socialQuotas(brand.id).selection.used < 40) {
    return selectAndQueue({
      ...options,
      candidateOrigins: ["manual"],
      batchSize: 5,
      reserveSelectionCall: (request, candidateIds) =>
        store.reserveSocialSelectionCall({
          brandId: brand.id,
          task: request.task as "selection" | "selection_review",
          candidateIds,
        }),
    });
  }
  return {
    evaluated: material.length,
    fetchFailed,
    ...enqueueApprovedTopics(options),
  };
}
