import { readLocalText } from "./files.js";
import { resolve } from "node:path";
import { z } from "zod";
import type { BrandConfig } from "./content.js";

const nonEmpty = z.string().trim().min(1);
export const brandSchema = z.object({
  id: nonEmpty.regex(/^[a-zA-Z0-9_-]+$/),
  name: nonEmpty,
  audience: nonEmpty,
  businessContext: nonEmpty,
  contentRules: z.array(nonEmpty).default([]),
  examples: z.array(nonEmpty).default([]),
  language: nonEmpty.default("English"),
  verifiedFacts: z
    .array(z.object({ claim: nonEmpty, url: z.string().url() }))
    .default([]),
  maxPostLength: z.number().int().min(30).max(280).default(280),
});

export async function loadBrand(path: string): Promise<BrandConfig> {
  return brandSchema.parse(JSON.parse(await readLocalText(path)));
}

export interface WorkerConfig {
  brandFile: string;
  sourcesFile?: string;
  dbPath: string;
  model: {
    provider: "openai" | "anthropic";
    model: string;
    apiKey: string;
    baseURL?: string;
  };
  postiz: {
    baseUrl: string;
    apiKey: string;
    integrationId: string;
    timeoutMs: number;
  };
  source: {
    firecrawlApiKey?: string;
    getxApiKey?: string;
    maxChars: number;
    timeoutMs: number;
  };
  pollIntervalMs: number;
  discoveryIntervalMs: number;
  maxJobsPerTick: number;
  autoSubmit: boolean;
  leaseMs: number;
}

function positiveInt(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const provider = env.CONTENT_MODEL_PROVIDER || "openai";
  if (provider !== "openai" && provider !== "anthropic")
    throw new Error("CONTENT_MODEL_PROVIDER must be openai or anthropic");
  const autoSubmit = env.CONTENT_AUTO_SUBMIT || "true";
  if (autoSubmit !== "true" && autoSubmit !== "false")
    throw new Error("CONTENT_AUTO_SUBMIT must be true or false");
  return {
    brandFile: resolve(
      env.CONTENT_BRAND_FILE || "config/postiz/brand.example.json",
    ),
    sourcesFile: env.CONTENT_SOURCES_FILE
      ? resolve(env.CONTENT_SOURCES_FILE)
      : undefined,
    dbPath: resolve(env.CONTENT_DB_PATH || ".content-agent/content.sqlite"),
    model: {
      provider,
      model: env.CONTENT_MODEL || "",
      apiKey: env.CONTENT_MODEL_API_KEY || "",
      ...(env.CONTENT_MODEL_BASE_URL
        ? { baseURL: env.CONTENT_MODEL_BASE_URL }
        : {}),
    },
    postiz: {
      baseUrl: env.POSTIZ_BASE_URL || "http://localhost:4007/api/public/v1",
      apiKey: env.POSTIZ_API_KEY || "",
      integrationId: env.POSTIZ_INTEGRATION_ID || "",
      timeoutMs: positiveInt(env, "POSTIZ_TIMEOUT_MS", 30_000, 1000, 120_000),
    },
    source: {
      firecrawlApiKey: env.FIRECRAWL_API_KEY || undefined,
      getxApiKey: env.GETXAPI_TOKEN || undefined,
      maxChars: positiveInt(
        env,
        "CONTENT_SOURCE_MAX_CHARS",
        40_000,
        1000,
        100_000,
      ),
      timeoutMs: positiveInt(
        env,
        "CONTENT_SOURCE_TIMEOUT_MS",
        30_000,
        1000,
        120_000,
      ),
    },
    discoveryIntervalMs: positiveInt(
      env,
      "CONTENT_DISCOVERY_INTERVAL_MS",
      86_400_000,
      60_000,
      604_800_000,
    ),
    pollIntervalMs: positiveInt(
      env,
      "CONTENT_POLL_INTERVAL_MS",
      60_000,
      1000,
      86_400_000,
    ),
    maxJobsPerTick: positiveInt(env, "CONTENT_MAX_JOBS_PER_TICK", 3, 1, 100),
    autoSubmit: autoSubmit === "true",
    leaseMs: positiveInt(env, "CONTENT_LEASE_MS", 300_000, 30_000, 3_600_000),
  };
}

/** Errors may contain SDK details; remove configured credentials before storing/logging. */
export function safeError(
  error: unknown,
  env: NodeJS.ProcessEnv = process.env,
): string {
  let message = error instanceof Error ? error.message : "Unknown error";
  for (const [name, value] of Object.entries(env)) {
    if (value && value.length >= 4 && /KEY|TOKEN|SECRET|PASSWORD/i.test(name))
      message = message.split(value).join("[redacted]");
  }
  return message.slice(0, 1500);
}
