import { createHash } from "node:crypto";
import type { SourceInput } from "./validation.js";

export function normalizeSourceUrl(value: string): string {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error(
      "Sources must be HTTP(S) URLs without embedded credentials",
    );
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (/^utm_/i.test(key) || ["fbclid", "gclid"].includes(key.toLowerCase()))
      url.searchParams.delete(key);
  }
  url.searchParams.sort();
  return url.toString();
}

export function sourceUrlKey(value: string): string {
  const url = new URL(normalizeSourceUrl(value));
  const host = url.hostname.replace(/^(?:www|mobile)\./, "");
  const status = /^(?:\/[^/]+\/status|\/i\/web\/status)\/(\d+)(?:\/.*)?$/.exec(
    url.pathname,
  )?.[1];
  return ["x.com", "twitter.com"].includes(host) && status
    ? `x-status:${status}`
    : url.toString();
}

export function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/**
 * Version only the structured input supplied at discovery time. Later document
 * extraction must not change candidate identity. A bare URL therefore has one
 * stable empty version. X statuses keep one identity across mirrors/body fills.
 * Changing feed boilerplate can create extra web versions; topic identity is
 * the final guard against writing the same event twice.
 */
export function sourceMaterialKey(source: SourceInput): string {
  const urlKey = sourceUrlKey(source.url);
  if (urlKey.startsWith("x-status:")) return urlKey;
  const normalize = (value?: string) =>
    value?.replace(/\s+/g, " ").trim() || null;
  return stableHash({
    title: normalize(source.title),
    publishedAt: source.publishedAt
      ? new Date(source.publishedAt).toISOString()
      : null,
    text: normalize(source.text),
  });
}
