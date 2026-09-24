import { mkdir } from "node:fs/promises";
import { readLocalText } from "./files.js";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { config as loadEnv } from "dotenv";
import { loadBrand, readConfig, safeError } from "./config.js";
import { createContentModel } from "./models.js";
import { generateContent } from "./content.js";
import {
  ContentJobStore,
  type ContentJob,
  type ContentJobState,
} from "./store.js";
import { PostizClient } from "./postiz-client.js";
import {
  discoverSources,
  loadSource,
  type SourceInput,
  type SourceConfig,
} from "./sources.js";
import {
  enqueueContent,
  generateNext,
  submitNext,
  syncJob,
  syncSubmitted,
} from "./runner.js";

const HELP = `Content worker for Postiz (Node.js 24+)

  yarn postiz:cli preview --url URL [--url URL] [--text-file FILE]
  yarn postiz:cli preview --input-json FILE
  yarn postiz:cli enqueue --url URL [--schedule ISO_TIME] [--media FILE]
  yarn postiz:cli enqueue --input-json FILE
  yarn postiz:cli discover
  yarn postiz:cli work [--once] [--no-submit]
  yarn postiz:cli show [--id CONTENT_ID]
  yarn postiz:cli retry --id CONTENT_ID
  yarn postiz:cli submit --id CONTENT_ID
  yarn postiz:cli sync --id CONTENT_ID [--postiz-id EXISTING_ID]
  yarn postiz:cli integrations

Configuration: .env.postiz or CONTENT_ENV_FILE, plus CONTENT_BRAND_FILE.
preview calls only source/model services. enqueue records a job, without API calls.
work processes at most CONTENT_MAX_JOBS_PER_TICK and defaults to Postiz drafts.
--schedule is only valid at enqueue time and must include a timezone.
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
      state: { type: "string" },
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
  ]);
  if (!commands.has(command) || positionals.length !== 1)
    throw new Error("Unknown command; use --help");
  const allowedFlags: Record<string, string[]> = {
    preview: ["url", "text-file", "input-json"],
    enqueue: ["url", "text-file", "input-json", "media", "schedule"],
    discover: [],
    work: ["once", "no-submit"],
    show: ["id", "state"],
    retry: ["id"],
    submit: ["id"],
    sync: ["id", "postiz-id"],
    integrations: [],
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
  if (values.media && command !== "enqueue")
    throw new Error("--media is only accepted by enqueue");
  loadEnv({ path: process.env.CONTENT_ENV_FILE || ".env.postiz", quiet: true });
  const config = readConfig();
  const client = () => {
    if (!config.postiz.apiKey)
      throw new Error("Set POSTIZ_API_KEY for this operation");
    return new PostizClient(config.postiz);
  };
  if (command === "integrations") {
    console.log(JSON.stringify(await client().listIntegrations(), null, 2));
    return;
  }
  const brand = await loadBrand(config.brandFile);
  const model = () => {
    if (!config.model.apiKey || !config.model.model)
      throw new Error(
        "Set CONTENT_MODEL_API_KEY and CONTENT_MODEL before generating content",
      );
    return createContentModel(config.model);
  };

  const inputSources = async (): Promise<SourceInput[]> => {
    if (values["input-json"]) {
      if (values.url?.length || values["text-file"])
        throw new Error("Use --input-json or --url, not both");
      const input = await readJsonFile(values["input-json"]);
      if (!Array.isArray(input) || !input.length || input.length > 8)
        throw new Error(
          "--input-json must contain an array of 1–8 source objects",
        );
      return input as SourceInput[];
    }
    const urls = values.url || [];
    if (!urls.length || urls.length > 8)
      throw new Error("Provide 1–8 --url values, or --input-json FILE");
    if (values["text-file"] && urls.length !== 1)
      throw new Error("--text-file requires exactly one URL");
    const text = values["text-file"]
      ? await readLocalText(values["text-file"])
      : undefined;
    return urls.map((url) => ({
      url,
      ...(text === undefined ? {} : { text }),
    }));
  };

  const loadDocuments = async (inputs: SourceInput[]) => {
    const docs = [];
    for (const input of inputs)
      docs.push(await loadSource(input, config.source));
    return docs;
  };
  if (command === "preview") {
    const selectedModel = model();
    const result = await generateContent(
      { brand, sources: await loadDocuments(await inputSources()) },
      { model: selectedModel },
    );
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  await mkdir(dirname(config.dbPath), { recursive: true });
  const store = new ContentJobStore(config.dbPath);
  const requiredJob = () => {
    if (!values.id) throw new Error("This command requires --id CONTENT_ID");
    const job = store.get(values.id);
    if (!job || job.brandId !== brand.id)
      throw new Error("Job does not exist for the selected brand");
    return job;
  };
  const discover = async () => {
    if (!config.sourcesFile) return 0;
    if (!config.postiz.integrationId)
      throw new Error("Set POSTIZ_INTEGRATION_ID before source discovery");
    const sourceConfigs = await readJsonFile(config.sourcesFile);
    if (!Array.isArray(sourceConfigs))
      throw new Error("CONTENT_SOURCES_FILE must be a JSON array");
    const inputs = await discoverSources(sourceConfigs as SourceConfig[], {
      ...config.source,
      baseDir: dirname(config.sourcesFile),
    });
    let queued = 0;
    for (const source of inputs) {
      const job = enqueueContent(store, {
        brand,
        sources: [source],
        integrationId: config.postiz.integrationId,
        mediaPaths: [],
      });
      // Returned state is authoritative; existing sources never get a second job.
      if (job.state === "queued") queued++;
    }
    return queued;
  };
  try {
    if (command === "enqueue") {
      const job = enqueueContent(
        store,
        {
          brand,
          sources: await inputSources(),
          integrationId: config.postiz.integrationId,
          mediaPaths: (values.media || []).map((path) => resolve(path)),
        },
        values.schedule,
      );
      console.log(JSON.stringify(summary(job), null, 2));
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
      console.log(
        JSON.stringify(summary(store.retry(requiredJob().id)), null, 2),
      );
    } else if (command === "discover") {
      if (!config.sourcesFile)
        throw new Error("Set CONTENT_SOURCES_FILE before discover");
      console.log(JSON.stringify({ queuedOrAlreadyQueued: await discover() }));
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
            await syncJob(store, client(), requiredJob(), values["postiz-id"]),
          ),
          null,
          2,
        ),
      );
    } else if (command === "work") {
      const selectedModel = model();
      const autoSubmit = config.autoSubmit && !values["no-submit"];
      const publisher = autoSubmit ? client() : undefined;
      let nextDiscovery = 0;
      const controller = new AbortController();
      const stop = () => controller.abort();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      try {
        do {
          try {
            store.recoverExpired();
            if (Date.now() >= nextDiscovery) {
              try {
                await discover();
                nextDiscovery = Date.now() + config.discoveryIntervalMs;
              } catch (error) {
                nextDiscovery =
                  Date.now() + Math.min(config.discoveryIntervalMs, 900_000);
                console.error(safeError(error));
                if (values.once) process.exitCode = 1;
              }
            }
            for (
              let i = 0;
              i < config.maxJobsPerTick && !controller.signal.aborted;
              i++
            ) {
              const result = await generateNext({
                store,
                brandId: brand.id,
                leaseMs: config.leaseMs,
                generate: async (input) =>
                  generateContent(
                    {
                      brand: input.brand,
                      sources: await loadDocuments(input.sources),
                    },
                    { model: selectedModel },
                  ),
              });
              if (!result) break;
              console.log(JSON.stringify(summary(result)));
              if (values.once && result.state === "failed")
                process.exitCode = 1;
            }
            if (publisher) {
              for (
                let i = 0;
                i < config.maxJobsPerTick && !controller.signal.aborted;
                i++
              ) {
                const result = await submitNext({
                  store,
                  client: publisher,
                  brandId: brand.id,
                  leaseMs: config.leaseMs,
                });
                if (!result) break;
                console.log(JSON.stringify(summary(result)));
                if (values.once && ["failed", "unknown"].includes(result.state))
                  process.exitCode = 1;
              }
              await syncSubmitted(store, publisher, brand.id);
            }
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
