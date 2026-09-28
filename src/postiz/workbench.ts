import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, mkdir } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import {
  loadBrand,
  readConfig,
  safeError,
  type WorkerConfig,
} from "./config.js";
import type { BrandConfig } from "./content.js";
import { createContentModel, type ContentModel } from "./models.js";
import { PostizClient } from "./postiz-client.js";
import { ContentJobStore } from "./store.js";
import { validateSourceInputs } from "./validation.js";
import { buildOperationsReport, type ReportCollection } from "./reports.js";
import { runWorkbenchTick } from "./workbench-runtime.js";
import {
  submitNext,
  syncJob,
  syncSubmitted,
  assertSchedulingAllowed,
} from "./runner.js";
import { JobConflictError } from "./store-errors.js";

type Json = Record<string, unknown>;
type RuntimeView = {
  paused: boolean;
  running: boolean;
  stage: string | null;
  lastHeartbeatAt: number | null;
  lastRunAt: number | null;
  lastError: string | null;
};
const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "web");

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class Workbench {
  readonly store: ContentJobStore;
  readonly config: WorkerConfig;
  readonly brand: BrandConfig | null;
  readonly postizUrl: string;
  readonly runtime: RuntimeView;
  private readonly modelFactory: () => ContentModel;
  private readonly clientFactory: () => PostizClient;
  private active: Promise<void> | null = null;
  private tickController: AbortController | null = null;
  private stopping = false;

  constructor(options: {
    store: ContentJobStore;
    config: WorkerConfig;
    brand: BrandConfig | null;
    postizUrl: string;
    model?: () => ContentModel;
    client?: () => PostizClient;
  }) {
    this.store = options.store;
    this.config = options.config;
    this.brand = options.brand;
    this.postizUrl = options.postizUrl;
    this.modelFactory =
      options.model ?? (() => createContentModel(this.config.model));
    this.clientFactory =
      options.client ??
      (() =>
        new PostizClient({ ...this.config.postiz, allowScheduling: false }));
    this.runtime = {
      paused: this.store.getWorkbenchPaused(),
      running: false,
      stage: null,
      lastHeartbeatAt: Date.now(),
      lastRunAt: null,
      lastError: null,
    };
    this.store.recoverExpired();
  }

  readiness() {
    const checks = [
      {
        key: "brand",
        label: "Brand configuration",
        ready: this.brand !== null,
        detail: this.brand
          ? "Loaded"
          : "Brand configuration is missing or invalid",
      },
      {
        key: "model",
        label: "Writing model",
        ready: Boolean(this.config.model.apiKey && this.config.model.model),
        detail:
          this.config.model.apiKey && this.config.model.model
            ? "Configured"
            : "Model credentials or model name are missing",
      },
      {
        key: "integration",
        label: "X integration",
        ready: Boolean(this.config.postiz.integrationId),
        detail: this.config.postiz.integrationId
          ? "Configured"
          : "Integration ID is missing",
      },
      {
        key: "postiz",
        label: "Postiz API",
        ready: Boolean(this.config.postiz.apiKey),
        detail: this.config.postiz.apiKey
          ? "Configured"
          : "Postiz API key is missing",
      },
    ];
    return { ready: checks.every((check) => check.ready), checks };
  }

  private requireBrand(): BrandConfig {
    if (!this.brand)
      throw new HttpError(503, "Brand configuration is unavailable");
    return this.brand;
  }

  requireReady(): BrandConfig {
    const brand = this.requireBrand();
    if (!this.readiness().ready)
      throw new HttpError(503, "Workbench configuration is incomplete");
    this.store.bindBrandIntegration(brand.id, this.config.postiz.integrationId);
    return brand;
  }

  snapshot() {
    const brand = this.brand;
    const quota = brand
      ? this.store.getGenerationQuota({
          brandId: brand.id,
          limit: this.config.dailyGenerationLimit,
          timeZone: this.config.dailyTimeZone,
        })
      : null;
    const jobs = brand
      ? this.store.list({ brandId: brand.id, limit: 10000 })
      : [];
    const candidates = brand
      ? this.store.listCandidates({ brandId: brand.id, limit: 10000 })
      : [];
    const incompleteCollections: ReportCollection[] = [];
    if (jobs.length === 10000) incompleteCollections.push("jobs");
    if (candidates.length === 10000) incompleteCollections.push("candidates");
    const report =
      brand && quota
        ? buildOperationsReport({
            brandId: brand.id,
            generatedAt: Date.now(),
            dayWindow: quota,
            jobs,
            candidates,
            incompleteCollections,
            generationAttempts: this.store.listGenerationAttempts({
              brandId: brand.id,
            }),
            selectionCalls: this.store.listSelectionModelCalls({
              brandId: brand.id,
            }),
            writingCalls: this.store.listWritingModelCalls({
              brandId: brand.id,
            }),
            feedback: this.store.listFeedback({ brandId: brand.id }),
            observations: this.store.listObservations({ brandId: brand.id }),
          })
        : null;
    return {
      brand: brand ? { id: brand.id, name: brand.name } : null,
      readiness: this.readiness(),
      runtime: { ...this.runtime },
      quota,
      report,
      candidates,
      topics: brand ? this.store.listTopics({ brandId: brand.id }) : [],
      sources: brand
        ? this.store.listSourceCheckpoints({ brandId: brand.id })
        : [],
      events: brand
        ? this.store.listWorkbenchEvents({ brandId: brand.id })
        : [],
      postizUrl: this.postizUrl,
    };
  }

  job(id: string) {
    const brand = this.requireBrand();
    const job = this.store.get(id);
    if (!job || job.brandId !== brand.id)
      throw new HttpError(404, "Job was not found");
    return {
      job,
      history: this.store.listAuditEvents({ brandId: brand.id, jobId: id }),
      feedback: this.store
        .listFeedback({ brandId: brand.id })
        .filter((item) => item.jobId === id),
      observations: this.store
        .listObservations({ brandId: brand.id })
        .filter((item) => item.jobId === id),
      events: this.store.listWorkbenchEvents({ brandId: brand.id, jobId: id }),
      postizUrl: this.postizUrl,
    };
  }

  private checkedJob(id: string, needsIntegration = true) {
    const brand = needsIntegration ? this.requireReady() : this.requireBrand();
    const job = this.store.get(id);
    if (!job || job.brandId !== brand.id)
      throw new HttpError(404, "Job was not found");
    if (
      (job.input as { integrationId?: unknown } | null)?.integrationId !==
      this.config.postiz.integrationId
    )
      throw new HttpError(
        409,
        "Job belongs to a different configured integration",
      );
    return job;
  }

  startTick(): boolean {
    if (this.stopping || this.active || this.runtime.paused) return false;
    const brand = this.requireReady();
    this.runtime.running = true;
    this.runtime.lastHeartbeatAt = Date.now();
    this.runtime.lastError = null;
    this.tickController = new AbortController();
    this.active = runWorkbenchTick({
      store: this.store,
      config: this.config,
      brand,
      model: this.modelFactory,
      client: this.clientFactory,
      autoSubmit: this.config.autoSubmit,
      allowScheduling: false,
      signal: this.tickController.signal,
      onEvent: (event) => {
        this.runtime.stage = event.status === "start" ? event.stage : null;
        this.runtime.lastHeartbeatAt = Date.now();
        if (event.status === "error")
          this.runtime.lastError = event.detail ?? "Operation failed";
        this.store.recordWorkbenchEvent({ brandId: brand.id, ...event });
      },
    })
      .catch((error) => {
        this.runtime.lastError = safeError(error);
        this.store.recordWorkbenchEvent({
          brandId: brand.id,
          stage: "tick",
          status: "error",
          detail: this.runtime.lastError,
        });
      })
      .finally(() => {
        this.runtime.running = false;
        this.runtime.stage = null;
        this.runtime.lastRunAt = Date.now();
        this.runtime.lastHeartbeatAt = Date.now();
        this.active = null;
        this.tickController = null;
      });
    return true;
  }

  /** Reconciliation of known receipts continues while new work is paused. */
  startSync(): boolean {
    if (
      this.stopping ||
      this.active ||
      !this.brand ||
      !this.config.postiz.apiKey ||
      !this.config.postiz.integrationId ||
      !this.store.list({ brandId: this.brand.id, state: "submitted", limit: 1 })
        .length
    )
      return false;
    const brand = this.brand;
    try {
      this.store.bindBrandIntegration(
        brand.id,
        this.config.postiz.integrationId,
      );
    } catch (error) {
      this.runtime.lastError = safeError(error);
      this.store.recordWorkbenchEvent({
        brandId: brand.id,
        stage: "sync",
        status: "error",
        detail: this.runtime.lastError,
      });
      return false;
    }
    this.runtime.running = true;
    this.runtime.stage = "sync";
    this.runtime.lastHeartbeatAt = Date.now();
    this.store.recordWorkbenchEvent({
      brandId: brand.id,
      stage: "sync",
      status: "start",
    });
    this.active = syncSubmitted(this.store, this.clientFactory(), brand.id)
      .then(() => {
        this.store.recordWorkbenchEvent({
          brandId: brand.id,
          stage: "sync",
          status: "finish",
        });
      })
      .catch((error) => {
        this.runtime.lastError = safeError(error);
        this.store.recordWorkbenchEvent({
          brandId: brand.id,
          stage: "sync",
          status: "error",
          detail: this.runtime.lastError,
        });
      })
      .finally(() => {
        this.runtime.running = false;
        this.runtime.stage = null;
        this.runtime.lastRunAt = Date.now();
        this.runtime.lastHeartbeatAt = Date.now();
        this.active = null;
      });
    return true;
  }

  pause(paused: boolean) {
    this.runtime.paused = this.store.setWorkbenchPaused(paused);
    if (paused) this.tickController?.abort();
    this.store.recordWorkbenchEvent({
      brandId: this.brand?.id,
      stage: "pause",
      status: "finish",
      detail: paused ? "paused" : "resumed",
    });
    return { paused: this.runtime.paused };
  }

  async stop() {
    this.stopping = true;
    this.tickController?.abort();
    if (this.active) await this.active;
  }

  async mutate(path: string, body: Json): Promise<unknown> {
    if (path === "/api/run") {
      if (!this.startTick())
        throw new HttpError(
          409,
          this.runtime.paused
            ? "Worker is paused"
            : "Worker is already running",
        );
      return { accepted: true };
    }
    if (path === "/api/pause") {
      if (typeof body.paused !== "boolean")
        throw new HttpError(400, "paused must be a boolean");
      return this.pause(body.paused);
    }
    if (path === "/api/materials") {
      const brand = this.requireReady();
      const sources = validateSourceInputs(body.sources);
      const candidates = this.store.upsertCandidates({
        brandId: brand.id,
        origin: "manual",
        inputs: sources,
      });
      return {
        candidateIds: candidates.map((candidate) => candidate.id),
        candidates,
      };
    }
    const topic = /^\/api\/topics\/([^/]+)\/review$/.exec(path);
    if (topic) {
      const brand = this.requireReady();
      if (
        !validReason(body.reason) ||
        !["approve", "reject"].includes(String(body.decision))
      )
        throw new HttpError(400, "Decision and reason are required");
      return this.store.reviewTopic(decodeURIComponent(topic[1]), {
        brandId: brand.id,
        decision: body.decision as "approve" | "reject",
        reason: body.reason as string,
        ...(typeof body.mergeWith === "string"
          ? { mergeWith: body.mergeWith }
          : {}),
      });
    }
    const candidate = /^\/api\/candidates\/([^/]+)\/retry$/.exec(path);
    if (candidate) {
      const brand = this.requireReady();
      if (
        !validReason(body.reason) ||
        (body.confirmNewEvent !== undefined &&
          typeof body.confirmNewEvent !== "boolean")
      )
        throw new HttpError(400, "A valid reason is required");
      const id = decodeURIComponent(candidate[1]);
      const current = this.store.getCandidate(id);
      if (!current || current.brandId !== brand.id)
        throw new HttpError(404, "Candidate was not found");
      return body.confirmNewEvent
        ? this.store.resolveCandidateLegacy(id, {
            brandId: brand.id,
            reason: body.reason as string,
          })
        : this.store.retryCandidate(id, {
            brandId: brand.id,
            reason: body.reason as string,
          });
    }
    const jobRoute =
      /^\/api\/jobs\/([^/]+)\/(retry|feedback|submit|sync)$/.exec(path);
    if (!jobRoute) throw new HttpError(404, "Route was not found");
    const id = decodeURIComponent(jobRoute[1]);
    const action = jobRoute[2];
    const job = this.checkedJob(id);
    if (action === "retry") {
      if (
        (body.refreshBrand !== undefined &&
          typeof body.refreshBrand !== "boolean") ||
        (body.toDraft !== undefined && typeof body.toDraft !== "boolean") ||
        (body.reason !== undefined && !validReason(body.reason))
      )
        throw new HttpError(400, "Invalid retry options");
      const repairing = body.refreshBrand === true || body.toDraft === true;
      if (repairing && !validReason(body.reason))
        throw new HttpError(400, "Explicit repairs require a reason");
      assertSchedulingAllowed(body.toDraft ? "draft" : job.mode, false);
      return repairing
        ? this.store.repairFailed(id, {
            reason: body.reason as string,
            ...(body.refreshBrand
              ? { brandSnapshot: this.requireBrand() }
              : {}),
            toDraft: body.toDraft === true,
          })
        : this.store.retry(id, { reason: body.reason as string | undefined });
    }
    if (action === "feedback") {
      if (
        !validReason(body.reason) ||
        !["edit", "reject", "note"].includes(String(body.kind))
      )
        throw new HttpError(400, "Kind and reason are required");
      return this.store.recordFeedback({
        brandId: job.brandId,
        jobId: id,
        kind: body.kind as "edit" | "reject" | "note",
        reason: body.reason as string,
        actor: "workbench",
      });
    }
    if (action === "submit") {
      if (job.state !== "ready" || job.mode !== "draft")
        throw new HttpError(409, "Only ready drafts can be submitted");
      const result = await submitNext({
        store: this.store,
        client: this.clientFactory(),
        brandId: job.brandId,
        leaseMs: this.config.leaseMs,
        jobId: id,
        allowScheduling: false,
      });
      if (!result) throw new HttpError(409, "Job is already claimed");
      this.store.recordWorkbenchEvent({
        brandId: job.brandId,
        jobId: id,
        stage: "submission.manual",
        status: ["failed", "unknown"].includes(result.state)
          ? "error"
          : "finish",
        detail: result.state,
      });
      return result;
    }
    if (
      (body.postizId !== undefined &&
        (typeof body.postizId !== "string" || !body.postizId.trim())) ||
      (body.acceptEdited !== undefined &&
        typeof body.acceptEdited !== "boolean") ||
      (body.reason !== undefined && !validReason(body.reason)) ||
      (body.acceptEdited && (!body.postizId || !body.reason))
    )
      throw new HttpError(400, "Invalid reconciliation options");
    this.store.recoverExpired();
    const result = await syncJob(
      this.store,
      this.clientFactory(),
      this.checkedJob(id),
      body.postizId as string | undefined,
      {
        acceptEdited: body.acceptEdited as boolean | undefined,
        reason: body.reason as string | undefined,
      },
    );
    this.store.recordWorkbenchEvent({
      brandId: job.brandId,
      jobId: id,
      stage: "sync.manual",
      status: "finish",
      detail: result.state,
    });
    return result;
  }
}

function validReason(value: unknown): value is string {
  return (
    typeof value === "string" && value.trim().length > 0 && value.length <= 2000
  );
}
function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-security-policy":
      "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
  });
  response.end(JSON.stringify(value));
}
async function bodyJson(request: IncomingMessage): Promise<Json> {
  if (!/^application\/json(?:;|$)/i.test(request.headers["content-type"] ?? ""))
    throw new HttpError(415, "JSON content type is required");
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > 256_000) throw new HttpError(413, "Request body is too large");
    chunks.push(chunk as Buffer);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new HttpError(400, "JSON object is required");
  return parsed as Json;
}

export function createWorkbenchHttp(
  workbench: Workbench,
  options: { password: string; origin: string; webRoot?: string },
) {
  if (options.password.length < 20)
    throw new Error(
      "CONTENT_WORKBENCH_PASSWORD must contain at least 20 characters",
    );
  const origin = new URL(options.origin);
  if (
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    !["https:", "http:"].includes(origin.protocol)
  )
    throw new Error("CONTENT_WORKBENCH_URL must be a public origin");
  if (
    origin.protocol !== "https:" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)
  )
    throw new Error("CONTENT_WORKBENCH_URL must use HTTPS");
  const sessions = new Map<string, number>();
  const attempts = new Map<string, { count: number; until: number }>();
  const webRoot = resolve(options.webRoot ?? WEB_ROOT);
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", origin);
      const path = url.pathname;
      if (
        path === "/healthz" &&
        (request.method === "GET" || request.method === "HEAD")
      )
        return json(response, 200, { ok: true });
      if (request.headers.host !== origin.host)
        throw new HttpError(403, "Host is not allowed");
      if (!path.startsWith("/api/")) {
        if (request.method !== "GET" && request.method !== "HEAD")
          throw new HttpError(405, "Method is not allowed");
        const filename = path === "/" ? "index.html" : path.slice(1);
        if (!["index.html", "app.js", "styles.css"].includes(filename))
          throw new HttpError(404, "File was not found");
        const file = resolve(webRoot, filename);
        let content: Buffer;
        try {
          content = await readFile(file);
        } catch {
          throw new HttpError(404, "File was not found");
        }
        const types: Record<string, string> = {
          ".html": "text/html",
          ".js": "text/javascript",
          ".css": "text/css",
          ".svg": "image/svg+xml",
          ".png": "image/png",
          ".ico": "image/x-icon",
        };
        response.writeHead(200, {
          "content-type": `${types[extname(file)] ?? "application/octet-stream"}; charset=utf-8`,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
          "content-security-policy":
            "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
        });
        return response.end(request.method === "HEAD" ? undefined : content);
      }
      const method = request.method ?? "GET";
      if (method === "POST" && request.headers.origin !== origin.origin)
        throw new HttpError(403, "Origin is not allowed");
      if (path === "/api/login" && method === "POST") {
        const ip = request.socket.remoteAddress ?? "unknown";
        const entry = attempts.get(ip);
        const body = await bodyJson(request);
        const password = typeof body.password === "string" ? body.password : "";
        const left = Buffer.from(password);
        const right = Buffer.from(options.password);
        if (left.length !== right.length || !timingSafeEqual(left, right)) {
          attempts.set(ip, {
            count: entry && entry.until > Date.now() ? entry.count + 1 : 1,
            until: Date.now() + 15 * 60_000,
          });
          throw new HttpError(
            entry && entry.until > Date.now() && entry.count >= 5 ? 429 : 401,
            entry && entry.until > Date.now() && entry.count >= 5
              ? "Too many login attempts"
              : "Invalid credentials",
          );
        }
        attempts.delete(ip);
        const token = randomBytes(32).toString("base64url");
        sessions.set(token, Date.now() + 12 * 60 * 60_000);
        response.setHeader(
          "set-cookie",
          `workbench_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${origin.protocol === "https:" ? "; Secure" : ""}`,
        );
        return json(response, 200, { authenticated: true });
      }
      const token = /(?:^|;\s*)workbench_session=([^;]+)/.exec(
        request.headers.cookie ?? "",
      )?.[1];
      if (!token || !sessions.has(token) || sessions.get(token)! < Date.now())
        throw new HttpError(401, "Authentication required");
      if (path === "/api/session" && method === "GET")
        return json(response, 200, { authenticated: true });
      if (path === "/api/logout" && method === "POST") {
        await bodyJson(request);
        sessions.delete(token);
        response.setHeader(
          "set-cookie",
          `workbench_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${origin.protocol === "https:" ? "; Secure" : ""}`,
        );
        return json(response, 200, { authenticated: false });
      }
      if (path === "/api/snapshot" && method === "GET")
        return json(response, 200, workbench.snapshot());
      const job = /^\/api\/jobs\/([^/]+)$/.exec(path);
      if (job && method === "GET")
        return json(response, 200, workbench.job(decodeURIComponent(job[1])));
      if (method === "POST") {
        const body = await bodyJson(request);
        const result = await workbench.mutate(path, body);
        return json(response, path === "/api/run" ? 202 : 200, result);
      }
      throw new HttpError(404, "Route was not found");
    } catch (error) {
      const status =
        error instanceof HttpError
          ? error.status
          : error instanceof JobConflictError
            ? 409
            : error instanceof TypeError
              ? 400
              : 500;
      json(response, status, {
        error:
          error instanceof HttpError
            ? error.message
            : status === 409
              ? "Operation conflicts with current state"
              : status === 400
                ? "Invalid request"
                : "Operation failed",
      });
    }
  });
  return server;
}

export async function serveWorkbench(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  loadEnv({ path: env.CONTENT_ENV_FILE || ".env.postiz", quiet: true });
  const config = readConfig(env);
  const password = env.CONTENT_WORKBENCH_PASSWORD ?? "";
  const publicUrl = env.CONTENT_WORKBENCH_URL ?? "";
  if (!publicUrl) throw new Error("CONTENT_WORKBENCH_URL is required");
  await mkdir(dirname(config.dbPath), { recursive: true });
  const store = new ContentJobStore(config.dbPath);
  if (store.migrationBackupPath)
    console.error(`Pre-upgrade database backup: ${store.migrationBackupPath}`);
  try {
    let brand: BrandConfig | null = null;
    try {
      brand = await loadBrand(config.brandFile);
    } catch {
      /* The setup page remains available. */
    }
    const postizUrl = env.POSTIZ_PUBLIC_URL
      ? new URL(env.POSTIZ_PUBLIC_URL).origin
      : env.POSTIZ_WEB_URL
        ? new URL(env.POSTIZ_WEB_URL).origin
        : new URL(config.postiz.baseUrl).origin;
    const workbench = new Workbench({ store, config, brand, postizUrl });
    const server: Server = createWorkbenchHttp(workbench, {
      password,
      origin: publicUrl,
    });
    const port = Number(env.PORT || "8080");
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error("PORT must be a valid TCP port");
    await new Promise<void>((done, reject) => {
      function onError(error: Error) {
        server.off("listening", onListen);
        reject(error);
      }
      function onListen() {
        server.off("error", onError);
        done();
      }
      server.once("error", onError);
      server.once("listening", onListen);
      server.listen(port, "0.0.0.0");
    });
    const timer = setInterval(() => {
      workbench.runtime.lastHeartbeatAt = Date.now();
      if (workbench.runtime.paused) workbench.startSync();
      else if (workbench.readiness().ready) workbench.startTick();
    }, config.pollIntervalMs);
    if (workbench.runtime.paused) workbench.startSync();
    else if (workbench.readiness().ready) workbench.startTick();
    await new Promise<void>((done) => {
      const stop = () => {
        clearInterval(timer);
        void workbench.stop().then(() => server.close(() => done()));
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
  } finally {
    store.close();
  }
}
