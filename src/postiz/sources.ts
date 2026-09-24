import { constants } from "node:fs";
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
) & { limit?: number };

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

async function getxSources(
  config: Extract<SourceConfig, { type: "getx-search" | "getx-user" }>,
  options: SourceOptions,
  limit: number,
  maxChars: number,
  now: Date,
): Promise<SourceInput[]> {
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
  const pageLimit = Math.min(
    boundedInteger(config.maxPages, 1, 5, "maxPages"),
    boundedInteger(options.maxPages, 5, 5, "maxPages"),
  );
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
    url.searchParams.set("q", nonempty(config.query, "GetXAPI query"));
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
  const results: SourceInput[] = [];
  const seenIds = new Set<string>();
  const cursors = new Set<string>();
  for (let page = 0; page < pageLimit && results.length < limit; page += 1) {
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
    for (const value of payload.tweets) {
      if (results.length >= limit) break;
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
        (typeof tweet.likeCount !== "number" ||
          tweet.likeCount < config.minLikes)
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
      results.push({
        url: `https://x.com/${userName}/status/${tweet.id}`,
        text: textContent(tweet.text).slice(0, maxChars),
        ...(userName !== "i" ? { title: `@${userName} on X` } : {}),
        ...(publishedAt ? { publishedAt } : {}),
      });
    }
    // Empty results are a successful query. Never spend more calls paging an
    // empty page or repeatedly following a server's unchanged cursor.
    if (
      !payload.has_more ||
      !payload.tweets.length ||
      results.length >= limit ||
      page + 1 >= pageLimit
    )
      break;
    const cursor = nonempty(payload.next_cursor, "GetXAPI next_cursor");
    if (cursors.has(cursor))
      throw new Error("GetXAPI repeated a pagination cursor");
    cursors.add(cursor);
    url.searchParams.set("cursor", cursor);
  }
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
