import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { load } from "cheerio";
import {
  boundedInteger,
  fetchPublicText,
  publicAddresses,
  publicUrl,
  type PublicNetworkOptions,
} from "./network.js";

export interface SourceInput {
  url: string;
  text?: string;
  title?: string;
  publishedAt?: string;
}

export interface SourceDocument extends SourceInput {
  text: string;
}

export type SourceConfig = (
  | ({ type: "url" } & SourceInput)
  | { type: "rss"; url: string; maxAgeHours?: number }
  | { type: "json-file"; path: string }
  | {
      type: "getx-search";
      query: string;
      product?: "Latest" | "Top";
      maxPages?: number;
      minLikes?: number;
      maxAgeHours?: number;
    }
  | {
      type: "getx-user";
      userName: string;
      maxPages?: number;
      minLikes?: number;
      maxAgeHours?: number;
    }
) & {
  limit?: number;
  /** Stable configured name; otherwise the collector derives it from identity. */
  id?: string;
  enabled?: boolean;
  checkIntervalMs?: number;
  /** An operator-provided provenance hint, not an automatic fact check. */
  primary?: boolean;
};

/** Persist this together with candidates before asking for the next batch. */
export type SourceReadCheckpoint = {
  version: 1;
  sourceKey: string;
  pending: SourceInput[];
} & (
  | { kind: "snapshot" }
  | {
      kind: "getx";
      nextCursor: string | null;
      pagesRead: number;
      remainingItems: number;
      seenCursors: string[];
      seenIds: string[];
    }
);

export interface SourceDiscoveryBatch {
  inputs: SourceInput[];
  checkpoint: SourceReadCheckpoint | null;
  complete: boolean;
}

export interface SourceOptions extends PublicNetworkOptions {
  firecrawlApiKey?: string;
  /** API base, e.g. https://api.firecrawl.dev/v2. */
  firecrawlBaseUrl?: string;
  maxChars?: number;
  getxApiKey?: string;
  getxApiToken?: string;
  getxApiBaseUrl?: string;
  maxItems?: number;
  maxItemsPerSource?: number;
  maxPages?: number;
  baseDir?: string;
  now?: () => Date;
}

function nonempty(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${name} must be a non-empty string`);
  return value.trim();
}

function textContent(value: string): string {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function htmlText(value: string): string {
  const $ = load(value);
  $("script,style,noscript,iframe,svg,form,nav,footer,header").remove();
  $("br").replaceWith("\n");
  $("p,li,h1,h2,h3,h4,pre,blockquote").each((_index, element) => {
    $(element).append("\n");
  });
  const main = $("article,main,[role=main]").first();
  return textContent((main.length ? main : $("body")).text());
}

function normalizedDate(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? new Date(timestamp).toISOString()
    : undefined;
}

function normalizeInput(value: unknown, maxChars: number): SourceInput {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Source item must be an object");
  const input = value as Record<string, unknown>;
  const url = publicUrl(nonempty(input.url, "Source URL")).href;
  const title =
    input.title === undefined
      ? undefined
      : nonempty(input.title, "Source title").slice(0, 1000);
  const publishedAt = normalizedDate(input.publishedAt);
  if (input.publishedAt !== undefined && !publishedAt)
    throw new Error("Source publishedAt must be a valid date");
  const text =
    input.text === undefined
      ? undefined
      : textContent(nonempty(input.text, "Source text")).slice(0, maxChars);
  return {
    url,
    ...(text !== undefined ? { text } : {}),
    ...(title ? { title } : {}),
    ...(publishedAt ? { publishedAt } : {}),
  };
}

function jsonObject(text: string, source: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${source} returned invalid JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error(`${source} returned an invalid object`);
  return parsed as Record<string, unknown>;
}

function httpsApiBase(value: string): URL {
  const url = publicUrl(value);
  if (url.protocol !== "https:" || url.search)
    throw new Error("Source API base must use HTTPS without query parameters");
  return new URL(`${url.href.replace(/\/+$/, "")}/`);
}

/** Supplied text is the source of truth; an empty supplied text is an error. */
export async function loadSource(
  input: SourceInput,
  options: SourceOptions = {},
): Promise<SourceDocument> {
  const maxChars = boundedInteger(
    options.maxChars,
    20_000,
    100_000,
    "maxChars",
  );
  const source = normalizeInput(input, maxChars);
  if (source.text !== undefined) return { ...source, text: source.text };
  const timeoutMs = boundedInteger(
    options.timeoutMs,
    30_000,
    120_000,
    "timeoutMs",
  );
  if (options.firecrawlApiKey) {
    // Firecrawl performs remote extraction. Its deployment must also enforce SSRF
    // restrictions for its own redirects/subresources; our socket guard protects
    // this worker, not the third-party service's browser/network.
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const remaining = () => {
      const milliseconds = timeoutMs - (Date.now() - started);
      if (milliseconds <= 0) throw new Error("Source request timed out");
      return milliseconds;
    };
    try {
      return await Promise.race([
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("Source request timed out")),
            timeoutMs,
          );
        }),
        (async () => {
          await publicAddresses(publicUrl(source.url), options.lookup);
          const base = httpsApiBase(
            options.firecrawlBaseUrl ?? "https://api.firecrawl.dev/v2",
          );
          const response = await fetchPublicText(new URL("scrape", base).href, {
            ...options,
            timeoutMs: remaining(),
            method: "POST",
            maxRedirects: 0,
            headers: {
              Authorization: `Bearer ${options.firecrawlApiKey}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              url: source.url,
              formats: ["markdown"],
              onlyMainContent: true,
              timeout: remaining(),
            }),
          });
          if (response.status < 200 || response.status >= 300)
            throw new Error(
              `Firecrawl request failed with HTTP ${response.status}`,
            );
          const payload = jsonObject(response.text, "Firecrawl");
          if (
            payload.success !== true ||
            !payload.data ||
            typeof payload.data !== "object"
          )
            throw new Error("Firecrawl did not return a successful document");
          const data = payload.data as Record<string, unknown>;
          const metadata =
            data.metadata && typeof data.metadata === "object"
              ? (data.metadata as Record<string, unknown>)
              : {};
          if (
            typeof metadata.statusCode === "number" &&
            metadata.statusCode >= 400
          )
            throw new Error(
              `Source page failed with HTTP ${metadata.statusCode}`,
            );
          if (metadata.error)
            throw new Error("Firecrawl reported a source-page error");
          for (const target of [metadata.url, metadata.sourceURL]) {
            if (typeof target === "string") {
              remaining();
              await publicAddresses(publicUrl(target), options.lookup);
            }
          }
          const text = textContent(
            nonempty(data.markdown, "Firecrawl markdown"),
          ).slice(0, maxChars);
          const title =
            source.title ??
            (typeof metadata.title === "string"
              ? textContent(metadata.title).slice(0, 1000)
              : undefined);
          remaining();
          return { ...source, ...(title ? { title } : {}), text };
        })(),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  const response = await fetchPublicText(source.url, options);
  if (response.status < 200 || response.status >= 300)
    throw new Error(`Source request failed with HTTP ${response.status}`);
  const type = response.headers
    .get("content-type")
    ?.split(";")[0]
    .trim()
    .toLowerCase();
  if (
    type &&
    ![
      "text/html",
      "application/xhtml+xml",
      "text/plain",
      "text/markdown",
    ].includes(type)
  )
    throw new Error("Unsupported source content type");
  const isHtml =
    type === "text/html" ||
    type === "application/xhtml+xml" ||
    (!type && /^\s*</.test(response.text));
  const text = nonempty(
    isHtml ? htmlText(response.text) : textContent(response.text),
    "Extracted source text",
  ).slice(0, maxChars);
  const title =
    source.title ??
    (isHtml
      ? textContent(load(response.text)("title").first().text()).slice(0, 1000)
      : undefined);
  return { ...source, url: response.url, ...(title ? { title } : {}), text };
}

function validAge(maxAgeHours: number | undefined): void {
  if (
    maxAgeHours !== undefined &&
    (!Number.isFinite(maxAgeHours) || maxAgeHours <= 0 || maxAgeHours > 8760)
  )
    throw new Error("maxAgeHours must be greater than 0 and no more than 8760");
}

function recentEnough(
  date: string | undefined,
  maxAgeHours: number | undefined,
  now: Date,
): boolean {
  if (maxAgeHours === undefined) return true;
  if (!date) return false;
  const age = now.getTime() - Date.parse(date);
  return age >= -300_000 && age <= maxAgeHours * 3_600_000;
}

async function rssSources(
  config: Extract<SourceConfig, { type: "rss" }>,
  options: SourceOptions,
  limit: number,
  maxChars: number,
  now: Date,
): Promise<SourceInput[]> {
  validAge(config.maxAgeHours);
  const response = await fetchPublicText(config.url, options);
  if (response.status < 200 || response.status >= 300)
    throw new Error(`RSS request failed with HTTP ${response.status}`);
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(response.text))
    throw new Error("RSS must not contain a DTD or entity declarations");
  const $ = load(response.text, { xmlMode: true });
  const atom = $("feed").length > 0;
  if (!atom && !$("rss > channel, RDF, rdf\\:RDF").length)
    throw new Error("Response is not an RSS or Atom feed");
  const results: SourceInput[] = [];
  for (const element of $(atom ? "feed > entry" : "item").toArray()) {
    if (results.length >= limit) break;
    const item = $(element);
    const link = atom
      ? (item.find('link[rel="alternate"]').first().attr("href") ??
        item.find("link:not([rel])").first().attr("href"))
      : item.find("link").first().text();
    if (!link?.trim()) continue;
    let url: string;
    try {
      url = publicUrl(new URL(link.trim(), response.url).href).href;
    } catch {
      continue;
    }
    const publishedAt = normalizedDate(
      item
        .find(atom ? "published,updated" : "pubDate,dc\\:date")
        .first()
        .text(),
    );
    if (!recentEnough(publishedAt, config.maxAgeHours, now)) continue;
    const title = htmlText(item.find("title").first().text()).slice(0, 1000);
    // A summary is not a substitute for the full article. Full embedded content
    // avoids a second request; summary-only feeds are expanded by loadSource.
    const embedded = item.find(atom ? "content" : "content\\:encoded").first();
    const embeddedText = embedded.length ? htmlText(embedded.text()) : "";
    results.push({
      url,
      ...(title ? { title } : {}),
      ...(publishedAt ? { publishedAt } : {}),
      ...(embeddedText ? { text: embeddedText.slice(0, maxChars) } : {}),
    });
  }
  return results;
}

async function jsonFileSources(
  path: string,
  options: SourceOptions,
  limit: number,
  maxChars: number,
): Promise<SourceInput[]> {
  const maxBytes = boundedInteger(
    options.maxBytes,
    2_000_000,
    5_000_000,
    "maxBytes",
  );
  const file = await open(
    resolve(
      options.baseDir ?? process.cwd(),
      nonempty(path, "JSON source path"),
    ),
    constants.O_RDONLY | constants.O_NONBLOCK,
  );
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maxBytes)
      throw new Error(
        "JSON source must be a regular file within the byte limit",
      );
    const buffer = Buffer.alloc(maxBytes + 1);
    let size = 0;
    while (size <= maxBytes) {
      const result = await file.read(buffer, size, buffer.length - size, null);
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    if (size > maxBytes) throw new Error("JSON source exceeds byte limit");
    let values: unknown;
    try {
      values = JSON.parse(buffer.subarray(0, size).toString("utf8"));
    } catch {
      throw new Error("JSON source file is not valid JSON");
    }
    if (!Array.isArray(values))
      throw new Error("JSON source file must contain a SourceInput array");
    return values
      .slice(0, limit)
      .map((value) => normalizeInput(value, maxChars));
  } finally {
    await file.close();
  }
}

type GetxSourceConfig = Extract<
  SourceConfig,
  { type: "getx-search" | "getx-user" }
>;

async function getxPage(
  config: GetxSourceConfig,
  options: SourceOptions,
  maxChars: number,
  now: Date,
  cursor: string | null,
): Promise<{ inputs: SourceInput[]; nextCursor: string | null }> {
  const key = nonempty(
    options.getxApiKey ?? options.getxApiToken,
    "GetXAPI token",
  );
  validAge(config.maxAgeHours);
  if (
    config.minLikes !== undefined &&
    (!Number.isInteger(config.minLikes) || config.minLikes < 0)
  )
    throw new Error("minLikes must be a nonnegative integer");
  const base = httpsApiBase(
    options.getxApiBaseUrl ?? "https://api.getxapi.com",
  );
  const url = new URL(
    config.type === "getx-search"
      ? "twitter/tweet/advanced_search"
      : "twitter/user/tweets",
    base,
  );
  if (config.type === "getx-search") {
    const product = config.product ?? "Latest";
    if (!["Latest", "Top"].includes(product))
      throw new Error("GetXAPI product must be Latest or Top");
    const query = nonempty(config.query, "GetXAPI query");
    if (query.length > 4_000)
      throw new Error("GetXAPI query exceeds 4000 characters");
    url.searchParams.set("q", query);
    url.searchParams.set("product", product);
  } else {
    const userName = nonempty(config.userName, "GetXAPI userName").replace(
      /^@/,
      "",
    );
    if (!/^[A-Za-z0-9_]{1,15}$/.test(userName))
      throw new Error("GetXAPI userName is invalid");
    url.searchParams.set("userName", userName);
  }
  if (cursor) url.searchParams.set("cursor", cursor);
  const response = await fetchPublicText(url.href, {
    ...options,
    headers: { Authorization: `Bearer ${key}`, accept: "application/json" },
    maxRedirects: 0,
  });
  if (response.status < 200 || response.status >= 300)
    throw new Error(`GetXAPI request failed with HTTP ${response.status}`);
  const payload = jsonObject(response.text, "GetXAPI");
  if (
    !Array.isArray(payload.tweets) ||
    typeof payload.has_more !== "boolean" ||
    payload.error
  )
    throw new Error("GetXAPI returned an invalid tweets page");
  // The documented page contains about 20 items. Keep response work bounded if
  // a provider unexpectedly changes its contract, rather than silently losing it.
  if (payload.tweets.length > 100)
    throw new Error("GetXAPI page exceeds 100 tweets");
  const inputs: SourceInput[] = [];
  const seenIds = new Set<string>();
  for (const value of payload.tweets) {
    if (!value || typeof value !== "object") continue;
    const tweet = value as Record<string, unknown>;
    if (
      typeof tweet.id !== "string" ||
      !/^\d{1,30}$/.test(tweet.id) ||
      typeof tweet.text !== "string" ||
      !tweet.text.trim() ||
      seenIds.has(tweet.id)
    )
      continue;
    seenIds.add(tweet.id);
    if (
      config.minLikes !== undefined &&
      (typeof tweet.likeCount !== "number" || tweet.likeCount < config.minLikes)
    )
      continue;
    const publishedAt = normalizedDate(tweet.createdAt);
    if (!recentEnough(publishedAt, config.maxAgeHours, now)) continue;
    const author =
      tweet.author && typeof tweet.author === "object"
        ? (tweet.author as Record<string, unknown>).userName
        : undefined;
    const userName =
      typeof author === "string" && /^[A-Za-z0-9_]{1,15}$/.test(author)
        ? author
        : "i";
    inputs.push({
      url: `https://x.com/${userName}/status/${tweet.id}`,
      text: textContent(tweet.text).slice(0, maxChars),
      ...(userName !== "i" ? { title: `@${userName} on X` } : {}),
      ...(publishedAt ? { publishedAt } : {}),
    });
  }
  const nextCursor =
    payload.has_more && payload.tweets.length
      ? nonempty(payload.next_cursor, "GetXAPI next_cursor")
      : null;
  if (nextCursor && nextCursor.length > 8_192)
    throw new Error("GetXAPI cursor exceeds length limit");
  return { inputs, nextCursor };
}

function configRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function configuredId(value: unknown): string {
  const id = nonempty(value, "Source id");
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(id)) {
    throw new Error(
      "Source id must contain at most 128 letters, digits, dots, colons, hyphens or underscores",
    );
  }
  return id;
}

/** Invalid configuration still needs a stable identity to persist its backoff. */
function configurationDigest(value: unknown): string {
  const ancestors = new Set<object>();
  const canonical = (item: unknown): unknown => {
    if (item !== null && typeof item === "object") {
      if (ancestors.has(item)) return { invalidSourceValue: "circular" };
      ancestors.add(item);
      const result = Array.isArray(item)
        ? item.map(canonical)
        : Object.fromEntries(
            Object.entries(item)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, child]) => [key, canonical(child)]),
          );
      ancestors.delete(item);
      return result;
    }
    if (["undefined", "function", "symbol", "bigint"].includes(typeof item)) {
      return { invalidSourceValue: typeof item, value: String(item) };
    }
    return item;
  };
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

/** Validation belongs inside an isolated source lease, not registration. */
export function assertSourceConfig(
  value: unknown,
): asserts value is SourceConfig {
  const config = configRecord(value);
  if (!config) throw new Error("Source config entry must be an object");
  if (config.id !== undefined) configuredId(config.id);
  for (const key of ["enabled", "primary"] as const) {
    if (config[key] !== undefined && typeof config[key] !== "boolean") {
      throw new Error(`Source ${key} must be a boolean`);
    }
  }
  switch (config.type) {
    case "url":
    case "rss":
      publicUrl(nonempty(config.url, "Source URL"));
      break;
    case "json-file":
      if (nonempty(config.path, "JSON source path").includes("\0")) {
        throw new Error("JSON source path cannot contain null bytes");
      }
      break;
    case "getx-search":
      if (nonempty(config.query, "GetXAPI query").length > 4_000) {
        throw new Error("GetXAPI query exceeds 4000 characters");
      }
      break;
    case "getx-user":
      if (
        !/^[A-Za-z0-9_]{1,15}$/.test(
          nonempty(config.userName, "GetXAPI userName").replace(/^@/, ""),
        )
      ) {
        throw new Error("GetXAPI userName is invalid");
      }
      break;
    default:
      throw new Error(
        "Source type must be url, rss, json-file, getx-search or getx-user",
      );
  }
}

/** Stable identity excludes scheduling knobs so an interval change keeps state. */
export function sourceIdentity(
  value: unknown,
  options: Pick<SourceOptions, "baseDir"> = {},
): string {
  const config = configRecord(value);
  const invalid = () => `invalid:${configurationDigest(value).slice(0, 24)}`;
  if (!config) return invalid();
  if (config.id !== undefined) {
    try {
      return configuredId(config.id);
    } catch {
      return invalid();
    }
  }
  let locator: unknown;
  switch (config.type) {
    case "url":
    case "rss":
      // URL validation belongs inside the isolated source check. A malformed
      // locator must still have an identity so its failure can be recorded.
      try {
        locator = new URL(nonempty(config.url, "Source URL")).href.replace(
          /#.*$/,
          "",
        );
      } catch {
        if (typeof config.url !== "string") return invalid();
        locator = config.url;
      }
      break;
    case "json-file":
      if (typeof config.path !== "string") return invalid();
      locator = resolve(options.baseDir ?? process.cwd(), config.path);
      break;
    case "getx-user":
      if (typeof config.userName !== "string") return invalid();
      locator = config.userName.replace(/^@/, "").toLowerCase();
      break;
    case "getx-search":
      locator = { query: config.query, product: config.product ?? "Latest" };
      break;
    default:
      return invalid();
  }
  return `${config.type}:${createHash("sha256").update(JSON.stringify(locator)).digest("hex").slice(0, 24)}`;
}

/** Changes affecting what is read invalidate an unfinished snapshot, not its ID. */
export function sourceReadKey(
  value: unknown,
  options: SourceOptions = {},
): string {
  const config = configRecord(value) ?? { invalidSourceConfig: value };
  const ignored = new Set(["id", "enabled", "checkIntervalMs", "primary"]);
  const data = Object.fromEntries(
    Object.entries(config)
      .filter(([key]) => !ignored.has(key))
      .sort(([a], [b]) => a.localeCompare(b)),
  );
  return createHash("sha256")
    .update(
      JSON.stringify({
        config: data,
        maxChars: options.maxChars ?? 20_000,
        maxItemsPerSource: options.maxItemsPerSource ?? 50,
        maxPages: options.maxPages ?? 5,
        ...(config.type === "json-file"
          ? { baseDir: resolve(options.baseDir ?? process.cwd()) }
          : {}),
        ...(typeof config.type === "string" && config.type.startsWith("getx-")
          ? {
              getxApiBaseUrl:
                options.getxApiBaseUrl ?? "https://api.getxapi.com",
            }
          : {}),
      }),
    )
    .digest("hex");
}

function readCheckpoint(
  value: unknown,
  sourceKey: string,
  maxChars: number,
): SourceReadCheckpoint | null {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid source checkpoint");
  const record = value as Record<string, unknown>;
  if (record.sourceKey !== sourceKey) return null;
  if (
    record.version !== 1 ||
    !Array.isArray(record.pending) ||
    record.pending.length > 50
  )
    throw new Error("Invalid source checkpoint");
  const pending = record.pending.map((input) =>
    normalizeInput(input, maxChars),
  );
  if (record.kind === "snapshot")
    return { version: 1, sourceKey, kind: "snapshot", pending };
  if (
    record.kind !== "getx" ||
    !Number.isInteger(record.pagesRead) ||
    Number(record.pagesRead) < 1 ||
    Number(record.pagesRead) > 5 ||
    !Number.isInteger(record.remainingItems) ||
    Number(record.remainingItems) < 0 ||
    Number(record.remainingItems) > 50 ||
    pending.length > Number(record.remainingItems) ||
    !(
      record.nextCursor === null ||
      (typeof record.nextCursor === "string" &&
        record.nextCursor.length > 0 &&
        record.nextCursor.length <= 8_192)
    ) ||
    !Array.isArray(record.seenCursors) ||
    record.seenCursors.length > 5 ||
    record.seenCursors.some(
      (cursor) =>
        typeof cursor !== "string" || !cursor || cursor.length > 8_192,
    ) ||
    !Array.isArray(record.seenIds) ||
    record.seenIds.length > 50 ||
    record.seenIds.some(
      (id) => typeof id !== "string" || !/^\d{1,30}$/.test(id),
    )
  )
    throw new Error("Invalid source checkpoint");
  return {
    version: 1,
    sourceKey,
    kind: "getx",
    pending,
    nextCursor: record.nextCursor as string | null,
    pagesRead: Number(record.pagesRead),
    remainingItems: Number(record.remainingItems),
    seenCursors: record.seenCursors as string[],
    seenIds: record.seenIds as string[],
  };
}

/**
 * A source check performs at most one GetX call or one feed/file read. Remaining
 * items are stored in the checkpoint, so a small fair share never loses the rest
 * of a paid page or causes the next worker to download the same snapshot again.
 */
export async function discoverSourceBatch(
  config: SourceConfig,
  options: SourceOptions & { checkpoint?: unknown; batchSize?: number } = {},
): Promise<SourceDiscoveryBatch> {
  if (configRecord(config)?.enabled === false)
    return { inputs: [], checkpoint: null, complete: true };
  assertSourceConfig(config);
  const maxChars = boundedInteger(
    options.maxChars,
    20_000,
    100_000,
    "maxChars",
  );
  const fullLimit = Math.min(
    boundedInteger(config.limit, 10, 50, "Source limit"),
    boundedInteger(options.maxItemsPerSource, 50, 50, "maxItemsPerSource"),
  );
  const batchSize = Math.min(
    boundedInteger(options.batchSize, 10, 50, "batchSize"),
    fullLimit,
  );
  const sourceKey = sourceReadKey(config, options);
  const checkpoint = readCheckpoint(options.checkpoint, sourceKey, maxChars);
  const now = options.now?.() ?? new Date();
  if (!Number.isFinite(now.getTime()))
    throw new Error("Discovery clock must return a valid Date");
  if (config.type === "getx-search" || config.type === "getx-user") {
    const pageLimit = Math.min(
      boundedInteger(config.maxPages, 1, 5, "maxPages"),
      boundedInteger(options.maxPages, 5, 5, "maxPages"),
    );
    let state: Extract<SourceReadCheckpoint, { kind: "getx" }>;
    if (checkpoint?.kind === "getx") {
      state = {
        ...checkpoint,
        pending: [...checkpoint.pending],
        seenCursors: [...checkpoint.seenCursors],
        seenIds: [...checkpoint.seenIds],
      };
    } else {
      state = {
        version: 1,
        sourceKey,
        kind: "getx",
        pending: [],
        nextCursor: null,
        pagesRead: 0,
        remainingItems: fullLimit,
        seenCursors: [],
        seenIds: [],
      };
    }
    if (
      !state.pending.length &&
      state.pagesRead < pageLimit &&
      state.remainingItems > 0
    ) {
      const cursor = state.nextCursor;
      const page = await getxPage(config, options, maxChars, now, cursor);
      state.pagesRead += 1;
      if (cursor) state.seenCursors.push(cursor);
      if (page.nextCursor && state.seenCursors.includes(page.nextCursor))
        throw new Error("GetXAPI repeated a pagination cursor");
      const seenIds = new Set(state.seenIds);
      state.pending = page.inputs
        .filter((input) => {
          const id = /\/status\/(\d+)$/.exec(input.url)?.[1];
          if (!id || seenIds.has(id)) return false;
          seenIds.add(id);
          return true;
        })
        .slice(0, state.remainingItems);
      state.seenIds.push(
        ...state.pending.map((input) => /\/status\/(\d+)$/.exec(input.url)![1]),
      );
      state.nextCursor = state.pagesRead < pageLimit ? page.nextCursor : null;
    }
    const inputs = state.pending.splice(0, batchSize);
    state.remainingItems -= inputs.length;
    const complete =
      state.remainingItems === 0 ||
      (!state.pending.length && !state.nextCursor);
    return { inputs, checkpoint: complete ? null : state, complete };
  }
  let pending: SourceInput[];
  if (checkpoint?.kind === "snapshot") {
    pending = [...checkpoint.pending];
  } else {
    switch (config.type) {
      case "url":
        pending = [normalizeInput(config, maxChars)];
        break;
      case "rss":
        pending = await rssSources(config, options, fullLimit, maxChars, now);
        break;
      case "json-file":
        pending = await jsonFileSources(
          config.path,
          options,
          fullLimit,
          maxChars,
        );
        break;
      default:
        throw new Error("Unknown source type");
    }
  }
  const inputs = pending.splice(0, batchSize);
  const complete = pending.length === 0;
  return {
    inputs,
    checkpoint: complete
      ? null
      : { version: 1, sourceKey, kind: "snapshot", pending },
    complete,
  };
}

async function getxSources(
  config: GetxSourceConfig,
  options: SourceOptions,
  limit: number,
  maxChars: number,
  now: Date,
): Promise<SourceInput[]> {
  const results: SourceInput[] = [];
  let checkpoint: SourceReadCheckpoint | null = null;
  do {
    const batch = await discoverSourceBatch(
      { ...config, limit },
      { ...options, maxChars, now: () => now, checkpoint, batchSize: limit },
    );
    results.push(...batch.inputs);
    checkpoint = batch.checkpoint;
  } while (checkpoint);
  return results;
}

/** Discovery is bounded and read-only. It never accepts model-selected URLs. */
export async function discoverSources(
  config: readonly SourceConfig[],
  options: SourceOptions = {},
): Promise<SourceInput[]> {
  if (!Array.isArray(config) || config.length > 50)
    throw new Error("Source config must be an array with at most 50 sources");
  const maxItems = boundedInteger(options.maxItems, 20, 100, "maxItems");
  const sourceCap = boundedInteger(
    options.maxItemsPerSource,
    50,
    50,
    "maxItemsPerSource",
  );
  const maxChars = boundedInteger(
    options.maxChars,
    20_000,
    100_000,
    "maxChars",
  );
  const now = options.now?.() ?? new Date();
  if (!Number.isFinite(now.getTime()))
    throw new Error("Discovery clock must return a valid Date");
  const results: SourceInput[] = [];
  const seen = new Set<string>();
  for (const source of config) {
    if (results.length >= maxItems) break;
    if (!source || typeof source !== "object")
      throw new Error("Source config entry must be an object");
    if (source.enabled === false) continue;
    const limit = Math.min(
      boundedInteger(source.limit, 10, 50, "Source limit"),
      sourceCap,
      maxItems - results.length,
    );
    let discovered: SourceInput[];
    switch (source.type) {
      case "url":
        discovered = [normalizeInput(source, maxChars)];
        break;
      case "rss":
        discovered = await rssSources(source, options, limit, maxChars, now);
        break;
      case "json-file":
        discovered = await jsonFileSources(
          source.path,
          options,
          limit,
          maxChars,
        );
        break;
      case "getx-search":
      case "getx-user":
        discovered = await getxSources(source, options, limit, maxChars, now);
        break;
      default:
        throw new Error("Unknown source type");
    }
    for (const input of discovered) {
      const source = normalizeInput(input, maxChars);
      const statusId =
        /^https:\/\/(?:www\.)?(?:twitter|x)\.com\/[^/]+\/status\/(\d+)/.exec(
          source.url,
        )?.[1];
      const key = statusId ? `x:${statusId}` : source.url;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push(source);
      if (results.length >= maxItems) break;
    }
  }
  return results;
}
