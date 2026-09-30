import { validateJobInput, type BrandConfig } from "./validation.js";
import { safeError } from "./config.js";
import { loadSource, type SourceOptions } from "./sources.js";
import { selectCandidates } from "./selector.js";
import type { ContentModel } from "./models.js";
import type { CandidateSelectionInput } from "./operations-types.js";
import type { ContentJobStore } from "./store.js";

/** One bounded selection batch. Source failures do not discard healthy candidates. */
export async function selectAndQueue(options: {
  store: ContentJobStore;
  brand: BrandConfig;
  integrationId: string;
  model: ContentModel;
  batchSize?: number;
  sourceOptions?: SourceOptions;
  now?: number;
  /** Restrict a batch without changing the legacy default candidate pool. */
  candidateOrigins?: string[];
  /** Replaces the legacy selection-call ledger for a shared external budget. */
  reserveSelectionCall?: (
    request: Parameters<ContentModel["invoke"]>[0],
    candidateIds: string[],
  ) => void;
}): Promise<{
  evaluated: number;
  fetchFailed: number;
  queued: number;
  warnings: string[];
}> {
  const { store, brand } = options;
  const batchSize = options.batchSize ?? 20;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 20)
    throw new Error("Selection batches must contain at most 20 candidates");
  const candidates = store
    .listCandidates({
      brandId: brand.id,
      status: "new",
      limit: options.candidateOrigins ? 10000 : batchSize,
    })
    .filter(
      (candidate) =>
        !options.candidateOrigins ||
        options.candidateOrigins.includes(candidate.origin),
    )
    .slice(0, batchSize);
  const material: CandidateSelectionInput[] = [];
  let fetchFailed = 0;
  for (const candidate of candidates) {
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
      });
    } catch (error) {
      store.failCandidateFetch(candidate.id, safeError(error));
      fetchFailed++;
    }
  }
  const warnings: string[] = [];
  if (material.length) {
    const result = await selectCandidates(
      {
        brand,
        candidates: material,
        existingTopics: store.listTopics({ brandId: brand.id }),
        now: options.now,
      },
      {
        model: {
          invoke: (request) => {
            // Reserve before invoking: failed calls and interrupted requests still count.
            const candidateIds = material.map((candidate) => candidate.id);
            if (options.reserveSelectionCall)
              options.reserveSelectionCall(request, candidateIds);
            else
              store.recordSelectionModelCall({
                brandId: brand.id,
                task: request.task as "selection" | "selection_review",
                candidateIds,
              });
            return options.model.invoke(request);
          },
        },
      },
    );
    store.saveSelection({ brandId: brand.id, result });
    warnings.push(...result.warnings);
  }
  const enqueued = enqueueApprovedTopics({
    store,
    brand,
    integrationId: options.integrationId,
  });
  return {
    evaluated: material.length,
    fetchFailed,
    ...enqueued,
    warnings: [...warnings, ...enqueued.warnings],
  };
}

/** Queue only approved topics whose brand claims have the required facts. */
export function enqueueApprovedTopics(options: {
  store: ContentJobStore;
  brand: BrandConfig;
  integrationId: string;
}): { queued: number; warnings: string[] } {
  const { store, brand } = options;
  const warnings: string[] = [];
  let queued = 0;
  if (options.integrationId) {
    for (const topic of store
      .listTopics({ brandId: brand.id })
      .filter((topic) => topic.status === "ready" && !topic.hasContent)) {
      const evidence = topic.approvedSources ?? [];
      let characters = 0;
      const sources = evidence.filter((source) => {
        if (characters + source.text.length > 180_000) return false;
        characters += source.text.length;
        return true;
      });
      if (sources.length !== evidence.length)
        warnings.push(
          `Topic ${topic.id}: writing uses ${sources.length} whole sources within the evidence limit; all sources remain in the candidate pool`,
        );
      const intent = store.getTopicIntent(topic.id);
      if (intent) {
        const readiness = store.brandWritingReadiness(brand, sources, intent);
        if (!readiness.ready) {
          warnings.push(`Topic ${topic.id}: ${readiness.missing.join("; ")}`);
          continue;
        }
      }
      const factMatchSources = intent?.writingAngle
        ? sources.map((source) => ({
            ...source,
            text: `${source.text}\n拟写角度：${intent.writingAngle}`,
          }))
        : sources;
      const input = validateJobInput({
        brand: store.brandWithKnowledge(brand, factMatchSources),
        sources,
        integrationId: options.integrationId,
        mediaPaths: [],
        ...(intent ?? {}),
      });
      // The event identity, including product version, is the creation key.
      // Binding the topic and job is atomic, before any remote request.
      store.enqueueForTopic(topic.id, {
        id: topic.id,
        brandId: brand.id,
        contentFingerprint: topic.id,
        input,
        mode: "draft",
      });
      queued++;
    }
  }
  return { queued, warnings };
}
