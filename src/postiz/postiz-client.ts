import { openAsBlob } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, extname } from "node:path";

/** The complete API prefix, e.g. http://localhost:4007/api/public/v1. */
export interface PostizClientOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

export interface PostizIntegration {
  id: string;
  name: string;
  identifier: string;
  disabled: boolean;
  profile: string | null;
}

export interface PostizMedia {
  id: string;
  path: string;
}

export interface CreatePostizPost {
  integrationId: string;
  /** Multiple strings form an X thread; media is attached to the first part. */
  content: string | string[];
  mode: "draft" | "schedule";
  scheduledAt?: string;
  media?: PostizMedia[];
}

export interface PostizPostReceipt {
  postId: string;
  integrationId: string;
}

export interface PostizPost {
  id: string;
  content: string;
  publishDate: string;
  /** Preserve the platform's state, including future states, without guessing. */
  state: string;
  releaseId: string | null;
  releaseURL: string | null;
  integrationId: string;
  providerIdentifier: string;
}

export interface PostizPostRange {
  startDate: string;
  endDate: string;
}

/** Error details are deliberately local: upstream response bodies can echo secrets. */
export class PostizApiError extends Error {
  readonly code: string;
  readonly status: number | undefined;

  constructor(message: string, code: string, status?: number) {
    super(message);
    this.name = "PostizApiError";
    this.code = code;
    this.status = status;
  }
}

/** A create may have succeeded. Reconcile it; do not blindly create it again. */
export class PostizOutcomeUnknownError extends PostizApiError {
  constructor(status?: number) {
    super(
      "Postiz may have created the post, but its result could not be confirmed. Reconcile before submitting again.",
      "outcome_unknown",
      status,
    );
    this.name = "PostizOutcomeUnknownError";
  }
}

const MIME_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".mp4": "video/mp4",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function optionalString(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value;
  throw new PostizApiError(
    "Postiz returned an invalid response.",
    "invalid_response",
  );
}

function invalidInput(message: string): never {
  throw new PostizApiError(message, "invalid_input");
}

export function isoDate(value: string): string {
  // Reject timezone-less strings so the scheduler cannot silently use local time.
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    ) ||
    !Number.isFinite(Date.parse(value))
  ) {
    invalidInput("Use a valid ISO timestamp with an explicit timezone.");
  }
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  const [hour, minute, second] = value.slice(11, 19).split(":").map(Number);
  // Date.parse normalizes February 31 and 24:00 instead of rejecting them.
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    invalidInput("Use a valid ISO timestamp with an explicit timezone.");
  }
  return new Date(value).toISOString();
}

/**
 * A deliberately small X publishing adapter for Postiz's Public API.
 * No operation retries automatically, and redirects never receive the API key.
 * Contract: Postiz public.integrations.controller.ts and posts.service.ts.
 */
export class PostizClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: PostizClientOptions) {
    let url: URL;
    try {
      url = new URL(options.baseUrl);
    } catch {
      invalidInput("Postiz base URL must be a valid HTTP or HTTPS API URL.");
    }
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !url.pathname.replace(/\/+$/, "").endsWith("/public/v1")
    ) {
      invalidInput(
        "Postiz base URL must end in /public/v1 and contain no credentials, query, or fragment.",
      );
    }
    if (!isNonEmptyString(options.apiKey) || /[\r\n]/.test(options.apiKey)) {
      invalidInput("A valid Postiz API key is required.");
    }
    const timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
      invalidInput("Postiz timeout must be between 1 and 300000 milliseconds.");
    }
    this.baseUrl = url.toString().replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  private async request(
    path: string,
    method: "GET" | "POST",
    body?: BodyInit,
    json = false,
    createsPost = false,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          // The REST API uses the raw key. MCP's Bearer transport is different.
          Authorization: this.apiKey,
          Accept: "application/json",
          ...(json ? { "Content-Type": "application/json" } : {}),
        },
        body,
        signal: controller.signal,
        redirect: "error",
      });
      if (!response.ok) {
        // A server error or request timeout can happen after the write commits.
        if (
          createsPost &&
          (response.status >= 500 || response.status === 408)
        ) {
          throw new PostizOutcomeUnknownError(response.status);
        }
        throw new PostizApiError(
          `Postiz rejected the request (HTTP ${response.status}).`,
          "http_error",
          response.status,
        );
      }
      try {
        return await response.json();
      } catch {
        if (createsPost) throw new PostizOutcomeUnknownError(response.status);
        throw new PostizApiError(
          "Postiz returned an invalid JSON response.",
          "invalid_response",
          response.status,
        );
      }
    } catch (error) {
      if (error instanceof PostizApiError) throw error;
      if (createsPost) throw new PostizOutcomeUnknownError();
      throw new PostizApiError(
        controller.signal.aborted
          ? "Postiz request timed out."
          : "Could not complete the Postiz request.",
        controller.signal.aborted ? "timeout" : "network_error",
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  async listIntegrations(): Promise<PostizIntegration[]> {
    const data = await this.request("/integrations", "GET");
    if (!Array.isArray(data)) {
      throw new PostizApiError(
        "Invalid Postiz integration list.",
        "invalid_response",
      );
    }
    return data.map((item: unknown) => {
      if (
        !isRecord(item) ||
        !isNonEmptyString(item.id) ||
        typeof item.name !== "string" ||
        !isNonEmptyString(item.identifier) ||
        typeof item.disabled !== "boolean"
      ) {
        throw new PostizApiError(
          "Invalid Postiz integration record.",
          "invalid_response",
        );
      }
      return {
        id: item.id,
        name: item.name,
        identifier: item.identifier,
        disabled: item.disabled,
        profile: optionalString(item.profile),
      };
    });
  }

  async uploadFile(localPath: string): Promise<PostizMedia> {
    if (!isNonEmptyString(localPath))
      invalidInput("A local media path is required.");
    const mime = MIME_TYPES[extname(localPath).toLowerCase()];
    if (!mime) invalidInput("This media file type is not supported by Postiz.");
    let file: Blob;
    try {
      const info = await stat(localPath);
      if (!info.isFile() || info.size === 0) {
        invalidInput("Media must be a non-empty regular file.");
      }
      // A file-backed Blob avoids loading an entire video into memory.
      file = await openAsBlob(localPath, { type: mime });
    } catch (error) {
      if (error instanceof PostizApiError) throw error;
      throw new PostizApiError(
        "Could not read the local media file.",
        "media_read_error",
      );
    }
    const form = new FormData();
    form.append("file", file, basename(localPath));
    const data = await this.request("/upload", "POST", form);
    if (
      !isRecord(data) ||
      !isNonEmptyString(data.id) ||
      !isNonEmptyString(data.path)
    ) {
      throw new PostizApiError(
        "Invalid Postiz upload receipt.",
        "invalid_response",
      );
    }
    return { id: data.id, path: data.path };
  }

  async createPost(input: CreatePostizPost): Promise<PostizPostReceipt> {
    if (!isNonEmptyString(input.integrationId))
      invalidInput("A Postiz integration ID is required.");
    if (input.mode !== "draft" && input.mode !== "schedule") {
      invalidInput("Only draft and schedule modes are supported.");
    }
    const parts = Array.isArray(input.content)
      ? input.content
      : [input.content];
    if (parts.length === 0 || parts.some((part) => !isNonEmptyString(part))) {
      invalidInput("Every post or thread part must contain text.");
    }
    if (input.mode === "schedule" && !input.scheduledAt) {
      invalidInput(
        "A future scheduledAt timestamp is required in schedule mode.",
      );
    }
    const date = input.scheduledAt
      ? isoDate(input.scheduledAt)
      : new Date().toISOString();
    if (input.mode === "schedule" && Date.parse(date) <= Date.now()) {
      invalidInput("The scheduledAt timestamp must be in the future.");
    }
    const media = input.media ?? [];
    if (
      !Array.isArray(media) ||
      media.some(
        (item) =>
          !isRecord(item) ||
          !isNonEmptyString(item.id) ||
          !isNonEmptyString(item.path),
      )
    ) {
      invalidInput("Media requires the id and path returned by Postiz upload.");
    }
    const payload = {
      type: input.mode,
      date,
      shortLink: false,
      tags: [],
      posts: [
        {
          integration: { id: input.integrationId },
          value: parts.map((content, index) => ({
            content,
            image:
              index === 0 ? media.map(({ id, path }) => ({ id, path })) : [],
          })),
          settings: { __type: "x", who_can_reply_post: "everyone" },
        },
      ],
    };
    const data = await this.request(
      "/posts",
      "POST",
      JSON.stringify(payload),
      true,
      true,
    );
    // Postiz returns an array, one receipt per requested integration (not {postId}).
    if (
      !Array.isArray(data) ||
      data.length !== 1 ||
      !isRecord(data[0]) ||
      !isNonEmptyString(data[0].postId) ||
      data[0].integration !== input.integrationId
    ) {
      throw new PostizOutcomeUnknownError();
    }
    return { postId: data[0].postId, integrationId: data[0].integration };
  }

  /** Public API lists root posts by publish date; there is no GET /posts/:id. */
  async listPosts(range: PostizPostRange): Promise<PostizPost[]> {
    const startDate = isoDate(range.startDate);
    const endDate = isoDate(range.endDate);
    if (Date.parse(startDate) > Date.parse(endDate))
      invalidInput("startDate must not be after endDate.");
    const query = new URLSearchParams({ startDate, endDate });
    const data = await this.request(`/posts?${query}`, "GET");
    if (!isRecord(data) || !Array.isArray(data.posts)) {
      throw new PostizApiError("Invalid Postiz post list.", "invalid_response");
    }
    return data.posts.map((item: unknown) => {
      if (
        !isRecord(item) ||
        !isNonEmptyString(item.id) ||
        typeof item.content !== "string" ||
        !isNonEmptyString(item.publishDate) ||
        !Number.isFinite(Date.parse(item.publishDate)) ||
        !isNonEmptyString(item.state) ||
        !isRecord(item.integration) ||
        !isNonEmptyString(item.integration.id) ||
        !isNonEmptyString(item.integration.providerIdentifier)
      ) {
        throw new PostizApiError(
          "Invalid Postiz post record.",
          "invalid_response",
        );
      }
      return {
        id: item.id,
        content: item.content,
        publishDate: item.publishDate,
        state: item.state,
        releaseId: optionalString(item.releaseId),
        releaseURL: optionalString(item.releaseURL),
        integrationId: item.integration.id,
        providerIdentifier: item.integration.providerIdentifier,
      };
    });
  }
}
