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
  const candidates = store.listCandidates({
    brandId: brand.id,
    status: "new",
    limit: batchSize,
  });
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
            store.recordSelectionModelCall({
              brandId: brand.id,
              task: request.task as "selection" | "selection_review",
              candidateIds: material.map((candidate) => candidate.id),
            });
            return options.model.invoke(request);
          },
        },
      },
    );
    store.saveSelection({ brandId: brand.id, result });
    warnings.push(...result.warnings);
  }
  let queued = 0;
  if (options.integrationId) {
    for (const topic of store
      .listTopics({ brandId: brand.id })
      .filter((topic) => topic.status === "ready" && !topic.hasContent)) {
      const evidence = topic.sourceCandidateIds.map((id) => {
        const candidate = store.getCandidate(id);
        if (!candidate || candidate.brandId !== brand.id || !candidate.document)
          throw new Error(
            "A selected topic is missing its persisted source document",
          );
        return candidate.document;
      });
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
      const input = validateJobInput({
        brand,
        sources,
        integrationId: options.integrationId,
        mediaPaths: [],
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
  return { evaluated: material.length, fetchFailed, queued, warnings };
}
