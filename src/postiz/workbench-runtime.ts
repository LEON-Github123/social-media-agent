import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { readLocalText } from "./files.js";
import { safeError, type WorkerConfig } from "./config.js";
import type { BrandConfig } from "./content.js";
import { generateContent } from "./content.js";
import type { ContentModel } from "./models.js";
import {
  loadSource,
  type SourceConfig,
  type SourceInput,
  type SourceDocument,
} from "./sources.js";
import { collectSources } from "./collector.js";
import { selectAndQueue } from "./pipeline.js";
import { generateNext, submitNext, syncSubmitted } from "./runner.js";
import type { ContentJobStore } from "./store.js";
import type { PostizClient } from "./postiz-client.js";

export interface TickDependencies {
  store: ContentJobStore;
  config: WorkerConfig;
  brand: BrandConfig;
  model: () => ContentModel;
  client: () => PostizClient;
  signal?: AbortSignal;
  autoSubmit?: boolean;
  allowScheduling?: boolean;
  onEvent?: (event: {
    stage: string;
    status: "start" | "finish" | "error";
    jobId?: string;
    detail?: string;
  }) => void;
}

/** A single bounded pass shared by the CLI and workbench. It never retries unknown submissions. */
export async function runWorkbenchTick(
  options: TickDependencies,
): Promise<void> {
  const { store, config, brand } = options;
  const emit = (
    stage: string,
    status: "start" | "finish" | "error",
    detail?: string,
    jobId?: string,
  ) =>
    options.onEvent?.({
      stage,
      status,
      ...(detail ? { detail } : {}),
      ...(jobId ? { jobId } : {}),
    });
  const stage = async (name: string, action: () => Promise<void>) => {
    emit(name, "start");
    try {
      await action();
      emit(name, "finish");
    } catch (error) {
      emit(name, "error", safeError(error));
    }
  };
  const loadDocuments = async (
    sources: SourceInput[],
  ): Promise<SourceDocument[]> => {
    const documents: SourceDocument[] = [];
    for (const source of sources)
      documents.push(await loadSource(source, config.source));
    return documents;
  };
  store.recoverExpired();
  if (
    config.postiz.integrationId ||
    store.list({ brandId: brand.id, limit: 1 }).length ||
    store.listCandidates({ brandId: brand.id, limit: 1 }).length
  )
    store.bindBrandIntegration(brand.id, config.postiz.integrationId);
  await stage("discovery", async () => {
    if (!config.sourcesFile || options.signal?.aborted) return;
    const sources = JSON.parse(
      await readLocalText(config.sourcesFile),
    ) as unknown;
    if (!Array.isArray(sources))
      throw new Error("CONTENT_SOURCES_FILE must be a JSON array");
    if (sources.length)
      store.bindBrandIntegration(brand.id, config.postiz.integrationId);
    const collection = await collectSources({
      store,
      brandId: brand.id,
      workerId: randomUUID(),
      sources: sources as SourceConfig[],
      sourceOptions: { ...config.source, baseDir: dirname(config.sourcesFile) },
      maxSourcesPerTick: config.maxSourcesPerTick,
      checkIntervalMs: config.discoveryIntervalMs,
      leaseMs: config.leaseMs,
    });
    if (collection.failed)
      throw new Error(`${collection.failed} source checks failed`);
  });
  await stage("selection", async () => {
    if (options.signal?.aborted) return;
    if (
      store.listCandidates({ brandId: brand.id, status: "new", limit: 1 })
        .length
    )
      options.model();
    await selectAndQueue({
      store,
      brand,
      integrationId: config.postiz.integrationId,
      batchSize: config.selectionBatchSize,
      sourceOptions: config.source,
      model: { invoke: (request) => options.model().invoke(request) },
    });
  });
  await stage("writing", async () => {
    if (store.list({ brandId: brand.id, state: "queued", limit: 1 }).length)
      options.model();
    for (
      let i = 0;
      i < config.maxJobsPerTick && !options.signal?.aborted;
      i++
    ) {
      const result = await generateNext({
        store,
        brandId: brand.id,
        leaseMs: config.leaseMs,
        allowScheduling: options.allowScheduling ?? config.allowScheduling,
        quota: {
          limit: config.dailyGenerationLimit,
          timeZone: config.dailyTimeZone,
        },
        generate: async (input, job) =>
          generateContent(
            { brand: input.brand, sources: await loadDocuments(input.sources) },
            {
              model: {
                invoke: async (request) => {
                  const task = request.task as
                    "relevance" | "report" | "post" | "quality";
                  store.recordWritingModelCall({
                    brandId: brand.id,
                    jobId: job.id,
                    task,
                  });
                  emit(task, "start", undefined, job.id);
                  try {
                    const result = await options.model().invoke(request);
                    emit(task, "finish", undefined, job.id);
                    return result;
                  } catch (error) {
                    emit(task, "error", safeError(error), job.id);
                    throw error;
                  }
                },
              },
            },
          ),
      });
      if (!result) break;
      emit(
        "writing.job",
        result.state === "failed" ? "error" : "finish",
        result.state,
        result.id,
      );
    }
  });
  if (options.autoSubmit ?? config.autoSubmit)
    await stage("submission", async () => {
      if (options.signal?.aborted) return;
      if (!store.list({ brandId: brand.id, state: "ready", limit: 1 }).length)
        return;
      for (
        let i = 0;
        i < config.maxJobsPerTick && !options.signal?.aborted;
        i++
      ) {
        const result = await submitNext({
          store,
          client: options.client(),
          brandId: brand.id,
          leaseMs: config.leaseMs,
          allowScheduling: options.allowScheduling ?? config.allowScheduling,
        });
        if (!result) break;
        emit(
          "submission.job",
          ["failed", "unknown"].includes(result.state) ? "error" : "finish",
          result.state,
          result.id,
        );
      }
    });
  await stage("sync", async () => {
    if (
      config.postiz.apiKey &&
      store.list({ brandId: brand.id, state: "submitted", limit: 1 }).length
    )
      await syncSubmitted(store, options.client(), brand.id);
  });
}
