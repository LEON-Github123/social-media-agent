import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { readLocalText } from "./files.js";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { config as loadEnv } from "dotenv";
import { loadBrand, readConfig, safeError } from "./config.js";
import { createContentModel, type ContentModel } from "./models.js";
import { generateContent } from "./content.js";
import { validateJobInput, validateSourceInputs } from "./validation.js";
import { collectSources } from "./collector.js";
import { selectAndQueue } from "./pipeline.js";
import { buildOperationsReport, type ReportCollection } from "./reports.js";
import {
  ContentJobStore,
  type ContentJob,
  type ContentJobState,
} from "./store.js";
import { PostizClient } from "./postiz-client.js";
import { loadSource, type SourceInput, type SourceConfig } from "./sources.js";
import {
  generateNext,
  submitNext,
  syncJob,
  syncSubmitted,
  assertSchedulingAllowed,
} from "./runner.js";

const HELP = `Content worker for Postiz (Node.js 24+)

  yarn postiz:cli preview --url URL [--url URL] [--text-file FILE]
  yarn postiz:cli preview --input-json FILE
  yarn postiz:cli enqueue --url URL [--text-file FILE]
  yarn postiz:cli enqueue --input-json FILE
  yarn postiz:cli discover
  yarn postiz:cli candidates [--id CANDIDATE_ID]
  yarn postiz:cli topics [--id TOPIC_ID]
  yarn postiz:cli retry-candidate --id CANDIDATE_ID --reason TEXT [--confirm-new-event]
  yarn postiz:cli review-topic --id TOPIC_ID --decision approve|reject --reason TEXT [--merge-with TOPIC_ID]
  yarn postiz:cli work [--once] [--no-submit]
  yarn postiz:cli show [--id CONTENT_ID]
  yarn postiz:cli retry --id CONTENT_ID [--refresh-brand] [--to-draft] [--reason TEXT]
  yarn postiz:cli history [--id CONTENT_ID]
  yarn postiz:cli status
  yarn postiz:cli feedback --id CONTENT_ID --kind edit|reject|note --reason TEXT [--actor NAME]
  yarn postiz:cli submit --id CONTENT_ID
  yarn postiz:cli sync --id CONTENT_ID [--postiz-id EXISTING_ID [--accept-edited --reason TEXT]]
  yarn postiz:cli integrations

Configuration: .env.postiz or CONTENT_ENV_FILE, plus CONTENT_BRAND_FILE.
preview calls source/model services and consumes the persistent daily writing budget.
enqueue records candidates without API calls; work selects topics before writing.
work processes at most CONTENT_MAX_JOBS_PER_TICK and defaults to Postiz drafts.
Scheduling is disabled by default, including for tasks already in the database.
Use retry --to-draft --reason TEXT to repair a failed scheduled task explicitly.
Use Postiz to edit/promote an existing draft; do not enqueue it again.
Unknown submissions cannot be retried. Inspect Postiz, then sync the existing ID.
`;

function summary(job: ContentJob) {
  return {
    id: job.id,
    brandId: job.brandId,
    state: job.state,
    mode: job.mode,
    scheduledAt: job.scheduledAt,
    postizId: job.postizId,
    postizState: job.postizState,
    platformPostId: job.platformPostId,
    platformUrl: job.platformUrl,
    lastError: job.lastError,
  };
}

async function readJsonFile(path: string): Promise<unknown> {
  const body = await readLocalText(path);
  if (body.length > 1_000_000)
    throw new Error("Configuration/input JSON exceeds 1 MB");
  return JSON.parse(body);
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      url: { type: "string", multiple: true },
      "text-file": { type: "string" },
      "input-json": { type: "string" },
      media: { type: "string", multiple: true },
      schedule: { type: "string" },
      once: { type: "boolean" },
      "no-submit": { type: "boolean" },
      id: { type: "string" },
      "postiz-id": { type: "string" },
      "accept-edited": { type: "boolean" },
      state: { type: "string" },
      "refresh-brand": { type: "boolean" },
      "to-draft": { type: "boolean" },
      reason: { type: "string" },
      decision: { type: "string" },
      "confirm-new-event": { type: "boolean" },
      "merge-with": { type: "string" },
      kind: { type: "string" },
      actor: { type: "string" },
    },
  });
  const command = positionals[0];
  if (values.help || !command) {
    console.log(HELP);
    return;
  }
  const commands = new Set([
    "preview",
    "enqueue",
    "discover",
    "work",
    "show",
    "retry",
    "submit",
    "sync",
    "integrations",
    "history",
    "candidates",
    "topics",
    "retry-candidate",
    "review-topic",
    "status",
    "feedback",
  ]);
  if (!commands.has(command) || positionals.length !== 1)
    throw new Error("Unknown command; use --help");
  const allowedFlags: Record<string, string[]> = {
    preview: ["url", "text-file", "input-json"],
    enqueue: ["url", "text-file", "input-json"],
    discover: [],
    work: ["once", "no-submit"],
    show: ["id", "state"],
    retry: ["id", "refresh-brand", "to-draft", "reason"],
    history: ["id"],
    submit: ["id"],
    sync: ["id", "postiz-id", "accept-edited", "reason"],
    integrations: [],
    candidates: ["id"],
    topics: ["id"],
    "retry-candidate": ["id", "reason", "confirm-new-event"],
    "review-topic": ["id", "reason", "decision", "merge-with"],
    status: [],
    feedback: ["id", "kind", "reason", "actor"],
  };
  for (const [flag, value] of Object.entries(values)) {
    if (
      value !== undefined &&
      flag !== "help" &&
      !allowedFlags[command].includes(flag)
    )
      throw new Error(`--${flag} is not supported by ${command}`);
  }
  if (Number(process.versions.node.split(".")[0]) < 24)
    throw new Error("The Postiz worker requires Node.js 24 or later");
  if (values.schedule && command !== "enqueue")
    throw new Error(
      "--schedule is only accepted by enqueue; use Postiz to reschedule an existing draft",
    );
  if (values["postiz-id"] && command !== "sync")
    throw new Error("--postiz-id is only accepted by sync");
  if (
    command === "sync" &&
    ((values["accept-edited"] &&
      (!values["postiz-id"] || !values.reason?.trim())) ||
      (values.reason !== undefined && !values["accept-edited"]))
  )
    throw new Error(
      "Edited-content reconciliation requires --postiz-id, --accept-edited and --reason together",
    );
  if (values.media && command !== "enqueue")
    throw new Error("--media is only accepted by enqueue");
  loadEnv({ path: process.env.CONTENT_ENV_FILE || ".env.postiz", quiet: true });
  const config = readConfig();
  let publisher: PostizClient | undefined;
  const client = () => {
    if (!config.postiz.apiKey)
      throw new Error("Set POSTIZ_API_KEY for this operation");
    return (publisher ??= new PostizClient({
      ...config.postiz,
      allowScheduling: config.allowScheduling,
    }));
  };
  if (command === "integrations") {
    console.log(JSON.stringify(await client().listIntegrations(), null, 2));
    return;
  }
  const brand = await loadBrand(config.brandFile);
  let selectedModel: ContentModel | undefined;
  const model = () => {
    if (!config.model.apiKey || !config.model.model)
      throw new Error(
        "Set CONTENT_MODEL_API_KEY and CONTENT_MODEL before generating content",
      );
    return (selectedModel ??= createContentModel(config.model));
  };

  const inputSources = async (): Promise<SourceInput[]> => {
    if (values["input-json"]) {
      if (values.url?.length || values["text-file"])
        throw new Error("Use --input-json or --url, not both");
      const input = await readJsonFile(values["input-json"]);
      return validateSourceInputs(input);
    }
    const urls = values.url || [];
    if (!urls.length || urls.length > 8)
      throw new Error("Provide 1–8 --url values, or --input-json FILE");
    if (values["text-file"] && urls.length !== 1)
      throw new Error("--text-file requires exactly one URL");
    const text = values["text-file"]
      ? await readLocalText(values["text-file"])
      : undefined;
    return validateSourceInputs(
      urls.map((url) => ({
        url,
        ...(text === undefined ? {} : { text }),
      })),
    );
  };

  const loadDocuments = async (inputs: SourceInput[]) => {
    const docs = [];
    for (const input of inputs)
      docs.push(await loadSource(input, config.source));
    return docs;
  };
  await mkdir(dirname(config.dbPath), { recursive: true });
  const store = new ContentJobStore(config.dbPath);
  const quota = {
    limit: config.dailyGenerationLimit,
    timeZone: config.dailyTimeZone,
  };
  if (store.migrationBackupPath)
    console.error(`Pre-upgrade database backup: ${store.migrationBackupPath}`);
  const writingModel = (jobId?: string): ContentModel => ({
    invoke(request) {
      if (!["relevance", "report", "post", "quality"].includes(request.task))
        throw new Error("Unexpected task in the writing pipeline");
      store.recordWritingModelCall({
        brandId: brand.id,
        ...(jobId ? { jobId } : {}),
        task: request.task as "relevance" | "report" | "post" | "quality",
      });
      return model().invoke(request);
    },
  });
  const requiredJob = () => {
    if (!values.id) throw new Error("This command requires --id CONTENT_ID");
    const job = store.get(values.id);
    if (!job || job.brandId !== brand.id)
      throw new Error("Job does not exist for the selected brand");
    if (
      !["show", "history"].includes(command) &&
      (job.input as { integrationId?: unknown } | null)?.integrationId !==
        config.postiz.integrationId
    )
      throw new Error("Job belongs to a different configured X integration");
    return job;
  };
  const requireAccount = () =>
    store.bindBrandIntegration(brand.id, config.postiz.integrationId);
  const discover = async () => {
    if (!config.sourcesFile) return null;
    const sourceConfigs = await readJsonFile(config.sourcesFile);
    if (!Array.isArray(sourceConfigs))
      throw new Error("CONTENT_SOURCES_FILE must be a JSON array");
    if (sourceConfigs.length) requireAccount();
    return collectSources({
      store,
      brandId: brand.id,
      workerId: randomUUID(),
      sources: sourceConfigs as SourceConfig[],
      sourceOptions: { ...config.source, baseDir: dirname(config.sourcesFile) },
      maxSourcesPerTick: config.maxSourcesPerTick,
      checkIntervalMs: config.discoveryIntervalMs,
      leaseMs: config.leaseMs,
    });
  };
  try {
    if (
      [
        "enqueue",
        "retry-candidate",
        "review-topic",
        "retry",
        "feedback",
        "submit",
        "sync",
      ].includes(command)
    )
      requireAccount();
    if (command === "preview") {
      const sources = await inputSources();
      // Validate settings before reserving a full attempt, but persist before any
      // source fetch or model request. Failures and process crashes are not refunded.
      model();
      if (
        !store.reserveGenerationAttempt({
          brandId: brand.id,
          kind: "preview",
          ...quota,
        })
      )
        throw new Error(
          "The daily writing limit has been reached; preview and retries share this budget",
        );
      const result = await generateContent(
        { brand, sources: await loadDocuments(sources) },
        { model: writingModel() },
      );
      console.log(JSON.stringify(result, null, 2));
    } else if (command === "enqueue") {
      const input = validateJobInput({
        brand,
        sources: await inputSources(),
        integrationId: config.postiz.integrationId,
        mediaPaths: [],
      });
      const candidates = store.upsertCandidates({
        brandId: brand.id,
        origin: "manual",
        inputs: input.sources,
      });
      console.log(
        JSON.stringify(
          {
            candidateIds: candidates.map((candidate) => candidate.id),
            candidates,
          },
          null,
          2,
        ),
      );
    } else if (command === "candidates") {
      const candidates = store.listCandidates({
        brandId: brand.id,
        limit: 10000,
      });
      const result = values.id ? store.getCandidate(values.id) : candidates;
      if (!result || (!Array.isArray(result) && result.brandId !== brand.id))
        throw new Error("Candidate does not exist for the selected brand");
      console.log(JSON.stringify(result, null, 2));
    } else if (command === "topics") {
      const topics = store.listTopics({ brandId: brand.id });
      const result = values.id ? store.getTopic(values.id) : topics;
      if (!result || (!Array.isArray(result) && result.brandId !== brand.id))
        throw new Error("Topic does not exist for the selected brand");
      console.log(JSON.stringify(result, null, 2));
    } else if (command === "retry-candidate") {
      if (!values.id || !values.reason?.trim())
        throw new Error("Candidate retry requires --id and --reason");
      const candidate = store.getCandidate(values.id);
      if (!candidate || candidate.brandId !== brand.id)
        throw new Error("Candidate does not exist for the selected brand");
      const result = values["confirm-new-event"]
        ? store.resolveCandidateLegacy(candidate.id, {
            brandId: brand.id,
            reason: values.reason,
          })
        : store.retryCandidate(candidate.id, {
            brandId: brand.id,
            reason: values.reason,
          });
      console.log(JSON.stringify(result, null, 2));
    } else if (command === "review-topic") {
      if (
        !values.id ||
        !values.reason?.trim() ||
        !["approve", "reject"].includes(values.decision ?? "")
      )
        throw new Error(
          "Topic review requires --id, --decision approve|reject and --reason",
        );
      console.log(
        JSON.stringify(
          store.reviewTopic(values.id, {
            brandId: brand.id,
            decision: values.decision as "approve" | "reject",
            reason: values.reason,
            ...(values["merge-with"]
              ? { mergeWith: values["merge-with"] }
              : {}),
          }),
          null,
          2,
        ),
      );
    } else if (command === "show") {
      const validStates: ContentJobState[] = [
        "queued",
        "processing",
        "ready",
        "rejected",
        "submitting",
        "submitted",
        "unknown",
        "failed",
      ];
      if (
        values.state &&
        !validStates.includes(values.state as ContentJobState)
      )
        throw new Error("Invalid job state");
      console.log(
        JSON.stringify(
          values.id
            ? requiredJob()
            : store
                .list({
                  brandId: brand.id,
                  ...(values.state
                    ? { state: values.state as ContentJobState }
                    : {}),
                  limit: 100,
                })
                .map(summary),
          null,
          2,
        ),
      );
    } else if (command === "retry") {
      const job = requiredJob();
      const repairing = values["refresh-brand"] || values["to-draft"];
      if (repairing && !values.reason?.trim())
        throw new Error("Explicit task repairs require --reason TEXT");
      assertSchedulingAllowed(
        values["to-draft"] ? "draft" : job.mode,
        config.allowScheduling,
      );
      const result = repairing
        ? store.repairFailed(job.id, {
            reason: values.reason!,
            ...(values["refresh-brand"] ? { brandSnapshot: brand } : {}),
            toDraft: values["to-draft"] === true,
          })
        : store.retry(job.id, { reason: values.reason });
      console.log(JSON.stringify(summary(result), null, 2));
    } else if (command === "history") {
      console.log(
        JSON.stringify(
          store.listAuditEvents({
            ...(values.id ? { jobId: requiredJob().id } : {}),
            brandId: brand.id,
          }),
          null,
          2,
        ),
      );
    } else if (command === "feedback") {
      const job = requiredJob();
      if (
        !values.reason?.trim() ||
        !["edit", "reject", "note"].includes(values.kind ?? "")
      )
        throw new Error(
          "Feedback requires --kind edit|reject|note and --reason TEXT",
        );
      console.log(
        JSON.stringify(
          store.recordFeedback({
            brandId: brand.id,
            jobId: job.id,
            kind: values.kind as "edit" | "reject" | "note",
            reason: values.reason,
            ...(values.actor ? { actor: values.actor } : {}),
          }),
          null,
          2,
        ),
      );
    } else if (command === "status") {
      const jobs = store.list({ brandId: brand.id, limit: 10000 });
      const candidates = store.listCandidates({
        brandId: brand.id,
        limit: 10000,
      });
      const incompleteCollections: ReportCollection[] = [];
      if (jobs.length === 10000) incompleteCollections.push("jobs");
      if (candidates.length === 10000) incompleteCollections.push("candidates");
      const budget = store.getGenerationQuota({ brandId: brand.id, ...quota });
      const report = buildOperationsReport({
        brandId: brand.id,
        generatedAt: Date.now(),
        dayWindow: budget,
        jobs,
        candidates,
        incompleteCollections,
        generationAttempts: store.listGenerationAttempts({ brandId: brand.id }),
        selectionCalls: store.listSelectionModelCalls({ brandId: brand.id }),
        writingCalls: store.listWritingModelCalls({ brandId: brand.id }),
        feedback: store.listFeedback({ brandId: brand.id }),
        observations: store.listObservations({ brandId: brand.id }),
      });
      console.log(
        JSON.stringify(
          {
            quota: budget,
            ...report,
            sources: store.listSourceCheckpoints({ brandId: brand.id }),
          },
          null,
          2,
        ),
      );
    } else if (command === "discover") {
      if (!config.sourcesFile)
        throw new Error("Set CONTENT_SOURCES_FILE before discover");
      console.log(JSON.stringify(await discover(), null, 2));
    } else if (command === "submit") {
      const job = requiredJob();
      if (job.state !== "ready")
        throw new Error(
          `Job is ${job.state}; only ready content can be submitted`,
        );
      const result = await submitNext({
        store,
        client: client(),
        brandId: brand.id,
        leaseMs: config.leaseMs,
        jobId: job.id,
        allowScheduling: config.allowScheduling,
      });
      if (!result) throw new Error("Another worker already claimed this job");
      console.log(JSON.stringify(summary(result), null, 2));
      if (result.state === "failed" || result.state === "unknown")
        process.exitCode = 1;
    } else if (command === "sync") {
      store.recoverExpired();
      console.log(
        JSON.stringify(
          summary(
            await syncJob(store, client(), requiredJob(), values["postiz-id"], {
              acceptEdited: values["accept-edited"],
              reason: values.reason,
            }),
          ),
          null,
          2,
        ),
      );
    } else if (command === "work") {
      const autoSubmit = config.autoSubmit && !values["no-submit"];
      const controller = new AbortController();
      const stop = () => controller.abort();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      try {
        do {
          try {
            if (
              config.postiz.integrationId ||
              store.list({ brandId: brand.id, limit: 1 }).length ||
              store.listCandidates({ brandId: brand.id, limit: 1 }).length
            )
              requireAccount();
            store.recoverExpired();
            try {
              const collection = await discover();
              if (collection?.checked)
                console.log(JSON.stringify({ collection }));
              if (collection?.failed && values.once) process.exitCode = 1;
            } catch (error) {
              console.error(safeError(error));
              if (values.once) process.exitCode = 1;
            }
            try {
              if (
                store.listCandidates({
                  brandId: brand.id,
                  status: "new",
                  limit: 1,
                }).length
              )
                model();
              const selection = await selectAndQueue({
                store,
                brand,
                integrationId: config.postiz.integrationId,
                batchSize: config.selectionBatchSize,
                sourceOptions: config.source,
                model: { invoke: (request) => model().invoke(request) },
              });
              if (
                selection.evaluated ||
                selection.queued ||
                selection.fetchFailed
              )
                console.log(JSON.stringify({ selection }));
            } catch (error) {
              console.error(safeError(error));
              if (values.once) process.exitCode = 1;
            }
            try {
              if (
                store.list({ brandId: brand.id, state: "queued", limit: 1 })
                  .length
              )
                model();
              for (
                let i = 0;
                i < config.maxJobsPerTick && !controller.signal.aborted;
                i++
              ) {
                const result = await generateNext({
                  store,
                  brandId: brand.id,
                  leaseMs: config.leaseMs,
                  allowScheduling: config.allowScheduling,
                  quota,
                  generate: async (input, job) =>
                    generateContent(
                      {
                        brand: input.brand,
                        sources: await loadDocuments(input.sources),
                      },
                      { model: writingModel(job.id) },
                    ),
                });
                if (!result) break;
                console.log(JSON.stringify(summary(result)));
                if (values.once && result.state === "failed")
                  process.exitCode = 1;
              }
            } catch (error) {
              console.error(safeError(error));
              if (values.once) process.exitCode = 1;
            }
            if (
              autoSubmit &&
              store.list({ brandId: brand.id, state: "ready", limit: 1 }).length
            ) {
              for (
                let i = 0;
                i < config.maxJobsPerTick && !controller.signal.aborted;
                i++
              ) {
                const result = await submitNext({
                  store,
                  client: client(),
                  brandId: brand.id,
                  leaseMs: config.leaseMs,
                  allowScheduling: config.allowScheduling,
                });
                if (!result) break;
                console.log(JSON.stringify(summary(result)));
                if (values.once && ["failed", "unknown"].includes(result.state))
                  process.exitCode = 1;
              }
            }
            if (
              config.postiz.apiKey &&
              store.list({ brandId: brand.id, state: "submitted", limit: 1 })
                .length
            )
              await syncSubmitted(store, client(), brand.id);
          } catch (error) {
            console.error(safeError(error));
            if (values.once) process.exitCode = 1;
          }
          if (values.once || controller.signal.aborted) break;
          try {
            await delay(config.pollIntervalMs, undefined, {
              signal: controller.signal,
            });
          } catch {
            break;
          }
        } while (!controller.signal.aborted);
      } finally {
        process.removeListener("SIGINT", stop);
        process.removeListener("SIGTERM", stop);
      }
    }
  } finally {
    store.close();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  void main().catch((error: unknown) => {
    console.error(safeError(error));
    process.exitCode = 1;
  });
}
