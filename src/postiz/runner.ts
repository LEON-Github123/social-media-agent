import { createHash, randomUUID } from "node:crypto";
import {
  validatePost,
  type BrandConfig,
  type ContentResult,
} from "./content.js";
import { safeError } from "./config.js";
import { validateJobInput, validateSourceDocuments } from "./validation.js";
import {
  ContentJobStore,
  type ContentJob,
  type ClaimedContentJob,
} from "./store.js";
import {
  PostizClient,
  PostizApiError,
  PostizOutcomeUnknownError,
  isoDate,
  type PostizPost,
} from "./postiz-client.js";
import type { SourceInput } from "./sources.js";
import { normalizeSourceUrl } from "./identity.js";
export { normalizeSourceUrl } from "./identity.js";

export interface JobInput {
  brand: BrandConfig;
  sources: SourceInput[];
  integrationId: string;
  mediaPaths: string[];
}

export function enqueueContent(
  store: ContentJobStore,
  input: JobInput,
  scheduledAt?: string,
  options: { allowScheduling?: boolean } = {},
): ContentJob {
  input = validateJobInput(input);
  assertSchedulingAllowed(
    scheduledAt ? "schedule" : "draft",
    options.allowScheduling,
  );
  const normalizedSources = input.sources.map((source) => ({
    ...source,
    url: normalizeSourceUrl(source.url),
  }));
  const urls = [
    ...new Set(
      normalizedSources.map((source) => {
        const url = new URL(source.url);
        const host = url.hostname.replace(/^(?:www|mobile)\./, "");
        const status =
          /^(?:\/[^/]+\/status|\/i\/web\/status)\/(\d+)(?:\/.*)?$/.exec(
            url.pathname,
          )?.[1];
        return ["x.com", "twitter.com"].includes(host) && status
          ? `x-status:${status}`
          : source.url;
      }),
    ),
  ].sort();
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        brand: input.brand.id,
        integration: input.integrationId,
        urls,
      }),
    )
    .digest("hex");
  const schedule = scheduledAt ? isoDate(scheduledAt) : undefined;
  if (schedule && Date.parse(schedule) <= Date.now())
    throw new Error("Schedule must be a future ISO timestamp with a timezone");
  const existing = store.get(fingerprint);
  if (existing) {
    if (
      existing.mode !== (schedule ? "schedule" : "draft") ||
      existing.scheduledAt !== (schedule ?? null)
    )
      throw new Error(
        "This source already has a job with a different schedule; change its schedule in Postiz instead of creating a duplicate",
      );
    return existing;
  }
  return store.enqueue({
    id: fingerprint,
    brandId: input.brand.id,
    contentFingerprint: fingerprint,
    input: { ...input, sources: normalizedSources },
    mode: scheduledAt ? "schedule" : "draft",
    ...(schedule ? { scheduledAt: schedule } : {}),
  });
}

export function assertSchedulingAllowed(
  mode: string,
  allowScheduling = false,
): void {
  if (mode === "schedule" && !allowScheduling) {
    throw new Error(
      "Scheduling is disabled. Explicitly repair this task with retry --to-draft --reason REASON, then review and schedule the draft in Postiz.",
    );
  }
}

function jobInput(job: ContentJob): JobInput {
  const input = validateJobInput(job.input);
  if (input.brand.id !== job.brandId)
    throw new Error("Job brand does not match its content snapshot");
  return input;
}

function jobOutput(job: ContentJob): ContentResult {
  const output = job.output as ContentResult;
  if (
    !output ||
    !output.relevant ||
    !output.quality?.approved ||
    typeof output.post !== "string" ||
    !output.post.trim()
  )
    throw new Error(
      "Job has no approved content; generate and review it again before submission",
    );
  return output;
}

async function withHeartbeat<T>(
  store: ContentJobStore,
  job: ClaimedContentJob,
  leaseMs: number,
  action: () => Promise<T>,
): Promise<T> {
  let heartbeatError: unknown;
  const timer = setInterval(
    () => {
      try {
        store.renewLease(job.id, job.leaseToken, leaseMs);
      } catch (error) {
        heartbeatError = error;
      }
    },
    Math.max(1000, Math.floor(leaseMs / 3)),
  );
  timer.unref();
  try {
    const result = await action();
    if (heartbeatError) throw heartbeatError;
    return result;
  } finally {
    clearInterval(timer);
  }
}

export async function generateNext(options: {
  store: ContentJobStore;
  brandId: string;
  leaseMs: number;
  jobId?: string;
  allowScheduling?: boolean;
  quota?: { limit: number; timeZone: string };
  generate: (input: JobInput) => Promise<ContentResult>;
}): Promise<ContentJob | null> {
  const { store, leaseMs } = options;
  const claimed = store.claimGeneration({
    workerId: randomUUID(),
    leaseMs,
    brandId: options.brandId,
    ...(options.quota ? { quota: options.quota } : {}),
    ...(options.jobId ? { jobId: options.jobId } : {}),
  });
  if (!claimed) return null;
  try {
    assertSchedulingAllowed(claimed.mode, options.allowScheduling);
    const result = await withHeartbeat(store, claimed, leaseMs, () =>
      options.generate(jobInput(claimed)),
    );
    return store.completeGeneration(
      claimed.id,
      claimed.leaseToken,
      result,
      result.relevant && result.quality.approved ? "ready" : "rejected",
    );
  } catch (error) {
    try {
      return store.failGeneration(
        claimed.id,
        claimed.leaseToken,
        safeError(error),
      );
    } catch {
      store.recoverExpired();
      return store.get(claimed.id) ?? null;
    }
  }
}

export async function submitNext(options: {
  store: ContentJobStore;
  client: PostizClient;
  brandId: string;
  leaseMs: number;
  jobId?: string;
  allowScheduling?: boolean;
}): Promise<ContentJob | null> {
  const { store, client, leaseMs } = options;
  const claimed = store.claimSubmit({
    workerId: randomUUID(),
    leaseMs,
    brandId: options.brandId,
    ...(options.jobId ? { jobId: options.jobId } : {}),
  });
  if (!claimed) return null;
  let createStarted = false;
  try {
    assertSchedulingAllowed(claimed.mode, options.allowScheduling);
    const receipt = await withHeartbeat(store, claimed, leaseMs, async () => {
      const input = jobInput(claimed);
      const output = jobOutput(claimed);
      const reasons = validatePost(output.post, {
        brand: input.brand,
        sources: validateSourceDocuments(output.sources),
      });
      if (reasons.length)
        throw new Error(
          `Current submission checks failed: ${reasons.join("; ")}. Use retry --refresh-brand --reason TEXT to regenerate.`,
        );
      const integration = (await client.listIntegrations()).find(
        (item) => item.id === input.integrationId,
      );
      if (
        !integration ||
        integration.disabled ||
        integration.identifier !== "x"
      )
        throw new Error(
          "The job's X integration is missing, disabled, or is a different platform",
        );
      const media = [];
      for (const path of input.mediaPaths)
        media.push(await client.uploadFile(path));
      // Fence again immediately before the side effect. An expired worker must not send.
      store.renewLease(claimed.id, claimed.leaseToken, leaseMs);
      createStarted = true;
      return client.createPost({
        integrationId: input.integrationId,
        content: output.post,
        mode: claimed.mode,
        ...(claimed.scheduledAt ? { scheduledAt: claimed.scheduledAt } : {}),
        media,
      });
    });
    return store.recordSubmitted(claimed.id, claimed.leaseToken, {
      postizId: receipt.postId,
    });
  } catch (error) {
    // A lost lease or DB write after acceptance is also unknown, even if HTTP succeeded.
    const uncertain =
      error instanceof PostizOutcomeUnknownError ||
      (createStarted && !(error instanceof PostizApiError));
    try {
      return uncertain
        ? store.markUnknown(claimed.id, claimed.leaseToken, safeError(error))
        : store.failSubmission(
            claimed.id,
            claimed.leaseToken,
            safeError(error),
          );
    } catch {
      store.recoverExpired();
      return store.get(claimed.id) ?? null;
    }
  }
}

function queryWindow(jobs: ContentJob[]): {
  startDate: string;
  endDate: string;
} {
  const times = jobs.flatMap((job) => [
    job.createdAt,
    job.updatedAt,
    ...(job.scheduledAt ? [Date.parse(job.scheduledAt)] : []),
  ]);
  return {
    startDate: new Date(Math.min(...times) - 86_400_000).toISOString(),
    endDate: new Date(
      Math.max(Date.now(), ...times) + 86_400_000,
    ).toISOString(),
  };
}

function platformReceipt(post: PostizPost) {
  return {
    postizId: post.id,
    platformPostId:
      post.releaseId && /^\d+$/.test(post.releaseId)
        ? post.releaseId
        : undefined,
    platformUrl: post.releaseURL || undefined,
    postizState: post.state,
  };
}

export async function syncJob(
  store: ContentJobStore,
  client: PostizClient,
  job: ContentJob,
  bindPostizId?: string,
): Promise<ContentJob> {
  if (bindPostizId && job.state !== "unknown")
    throw new Error("Manual binding is only for an unknown submission");
  const postizId = bindPostizId || job.postizId;
  if (!postizId)
    throw new Error(
      "No Postiz ID is known; inspect Postiz and pass --postiz-id to bind an existing record",
    );
  const post = (await client.listPosts(queryWindow([job]))).find(
    (candidate) => candidate.id === postizId,
  );
  if (!post)
    throw new Error(
      "Postiz record was not found in the job date range; absence does not prove the submission failed",
    );
  if (post.integrationId !== jobInput(job).integrationId)
    throw new Error("Postiz record belongs to a different integration");
  if (bindPostizId) {
    const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
    if (normalize(post.content) !== normalize(jobOutput(job).post))
      throw new Error(
        "Postiz record content differs; verify the record manually before binding",
      );
    return store.bindUnknown(job.id, platformReceipt(post));
  }
  return store.recordPlatformResult(job.id, platformReceipt(post));
}

export async function syncSubmitted(
  store: ContentJobStore,
  client: PostizClient,
  brandId: string,
): Promise<number> {
  const jobs = store.list({
    brandId,
    state: "submitted",
    limit: 100,
    orderBy: "updatedAt",
  });
  if (!jobs.length) return 0;
  const posts = await client.listPosts(queryWindow(jobs));
  let updated = 0;
  for (const job of jobs) {
    const post = posts.find(
      (item) =>
        item.id === job.postizId &&
        item.integrationId === jobInput(job).integrationId,
    );
    if (post) {
      store.recordPlatformResult(job.id, platformReceipt(post));
      updated++;
    } else {
      store.markSyncChecked(job.id);
    }
  }
  return updated;
}
