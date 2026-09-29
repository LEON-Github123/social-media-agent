import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

export interface PublicAddress {
  address: string;
  family: number;
}

export interface PublicNetworkOptions {
  timeoutMs?: number;
  maxBytes?: number;
  /** Test transport. Production uses a socket pinned to a checked DNS result. */
  fetch?: typeof globalThis.fetch;
  /** Test resolver; all returned addresses must be public. */
  lookup?: (hostname: string) => Promise<readonly PublicAddress[]>;
}

export interface PublicResponse {
  url: string;
  status: number;
  headers: Headers;
  text: string;
}

export function boundedInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
  name: string,
): number {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < 1 || result > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}`);
  }
  return result;
}

/** Conservative public-unicast check, including normalized/encoded IP literals. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 &&
        (b === 168 ||
          (b === 0 && (c === 0 || c === 2)) ||
          (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (family === 6) {
    // Only global unicast. Reject IPv4-mapped, NAT64, local, multicast,
    // documentation, special-purpose and 6to4 addresses conservatively.
    const [first, second = "0"] = address.toLowerCase().split(":");
    const a = Number.parseInt(first, 16);
    const b = Number.parseInt(second || "0", 16);
    return (
      a >= 0x2000 &&
      a < 0x4000 &&
      a !== 0x2002 &&
      a !== 0x3fff &&
      !(a === 0x2001 && (b < 0x200 || b === 0xdb8))
    );
  }
  return false;
}

export function publicUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Source URL must be an absolute HTTP(S) URL");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  ) {
    throw new Error("Source URL must use HTTP(S) without credentials");
  }
  const host = url.hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();
  if (
    !host ||
    host === "localhost" ||
    /\.(localhost|local|internal|home|lan)$/.test(host)
  ) {
    throw new Error("Source URL must use a public hostname");
  }
  if (isIP(host) ? !isPublicAddress(host) : !host.includes(".")) {
    throw new Error("Private or non-public source addresses are not allowed");
  }
  url.hash = "";
  return url;
}

export async function publicAddresses(
  url: URL,
  lookup?: PublicNetworkOptions["lookup"],
): Promise<readonly PublicAddress[]> {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const literalFamily = isIP(hostname);
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await (
        lookup ?? ((host) => dnsLookup(host, { all: true, verbatim: true }))
      )(hostname);
  const invalid = addresses.filter(
    (item) =>
      !isPublicAddress(item.address) || item.family !== isIP(item.address),
  );
  if (!addresses.length || invalid.length) {
    const details = invalid.length
      ? invalid
          .slice(0, 3)
          .map(
            (item) =>
              `${String(item.address)
                .slice(0, 64)
                .replace(/[^\da-fA-F:.]/g, "?")}/${item.family}`,
          )
          .join(", ")
      : "no addresses";
    throw new Error(
      `Source DNS must resolve exclusively to public addresses (${hostname.slice(0, 200).replace(/[^a-zA-Z0-9.:-]/g, "?")}: ${details})`,
    );
  }
  return addresses;
}

function contentDecoder(encoding: string | null): Transform | null {
  const value = encoding?.trim().toLowerCase();
  if (!value || value === "identity") return null;
  if (value === "gzip") return createGunzip();
  if (value === "br") return createBrotliDecompress();
  if (value === "deflate") return createInflate();
  throw new Error(
    `Source returned unsupported content encoding: ${value.slice(0, 80).replace(/[^a-z0-9, ._-]/g, "?")}`,
  );
}

async function readBody(
  body: Readable,
  encoding: string | null,
  maxBytes: number,
  signal: AbortSignal,
): Promise<string> {
  let decoder: Transform | null;
  try {
    decoder = contentDecoder(encoding);
  } catch (error) {
    body.destroy();
    throw error;
  }
  let compressedBytes = 0;
  let decodedBytes = 0;
  const chunks: Buffer[] = [];
  const compressedLimit = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      compressedBytes += chunk.length;
      callback(
        compressedBytes > maxBytes
          ? new Error("Source response exceeds byte limit")
          : null,
        chunk,
      );
    },
  });
  const collect = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      decodedBytes += chunk.length;
      if (decodedBytes > maxBytes) {
        callback(new Error("Source response exceeds byte limit"));
        return;
      }
      chunks.push(chunk);
      callback();
    },
  });
  try {
    if (decoder)
      await pipeline(body, compressedLimit, decoder, collect, { signal });
    else await pipeline(body, compressedLimit, collect, { signal });
  } catch (error) {
    if (
      decoder &&
      error instanceof Error &&
      !/byte limit|abort/i.test(error.message)
    )
      throw new Error(`Source response decoding failed (${encoding})`);
    throw error;
  }
  return Buffer.concat(chunks, decodedBytes).toString("utf8");
}

async function readFetchBody(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<string> {
  const length = Number(response.headers.get("content-length"));
  if (length > maxBytes) {
    await response.body?.cancel();
    throw new Error("Source response exceeds byte limit");
  }
  if (!response.body) return "";
  return readBody(
    Readable.from(response.body as AsyncIterable<Uint8Array>),
    response.headers.get("content-encoding"),
    maxBytes,
    signal,
  );
}

function requestPinned(
  url: URL,
  address: PublicAddress,
  init: {
    method: string;
    headers: Headers;
    body?: string;
    signal: AbortSignal;
  },
  maxBytes: number,
): Promise<PublicResponse> {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      {
        method: init.method,
        headers: Object.fromEntries(init.headers),
        signal: init.signal,
        agent: false,
        // A specific family disables Node's family autodetection; lookup returns
        // this one approved address rather than performing a second DNS query.
        family: address.family,
        // Preserve original Host/SNI while preventing a second DNS resolution.
        lookup: (_hostname, _options, callback) =>
          callback(null, address.address, address.family),
      },
      (response) => {
        const headers = new Headers();
        for (const [key, value] of Object.entries(response.headers)) {
          if (value !== undefined)
            headers.set(key, Array.isArray(value) ? value.join(", ") : value);
        }
        if (Number(headers.get("content-length")) > maxBytes) {
          response.destroy();
          reject(new Error("Source response exceeds byte limit"));
          return;
        }
        void readBody(
          response,
          headers.get("content-encoding"),
          maxBytes,
          init.signal,
        ).then(
          (text) =>
            resolve({
              url: url.href,
              status: response.statusCode ?? 0,
              headers,
              text,
            }),
          reject,
        );
      },
    );
    request.on("error", reject);
    request.end(init.body);
  });
}

/** One deadline covers DNS, redirects and response streaming, not just headers. */
export async function fetchPublicText(
  input: string,
  options: PublicNetworkOptions & {
    method?: "GET" | "POST";
    headers?: HeadersInit;
    body?: string;
    maxRedirects?: number;
  } = {},
): Promise<PublicResponse> {
  const timeoutMs = boundedInteger(
    options.timeoutMs,
    30_000,
    120_000,
    "timeoutMs",
  );
  const maxBytes = boundedInteger(
    options.maxBytes,
    2_000_000,
    5_000_000,
    "maxBytes",
  );
  const maxRedirects = options.maxRedirects ?? 3;
  if (!Number.isInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 5)
    throw new Error("maxRedirects must be between 0 and 5");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("Source request timed out"));
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      timeout,
      (async () => {
        let url = publicUrl(input);
        const headers = new Headers(options.headers);
        headers.delete("host");
        headers.set("accept-encoding", "gzip, br, deflate");
        if (!headers.has("user-agent"))
          headers.set("user-agent", "ContentWorker/1.0");
        for (let redirects = 0; ; redirects += 1) {
          const addresses = await publicAddresses(url, options.lookup);
          if (controller.signal.aborted)
            throw new Error("Source request timed out");
          const init = {
            method: options.method ?? "GET",
            headers,
            body: options.body,
            signal: controller.signal,
          };
          let response: PublicResponse;
          if (options.fetch) {
            const fetched = await options.fetch(url.href, {
              ...init,
              redirect: "manual",
            });
            if (fetched.redirected)
              throw new Error(
                "Injected transport must not automatically follow redirects",
              );
            response = {
              url: url.href,
              status: fetched.status,
              headers: fetched.headers,
              text: await readFetchBody(fetched, maxBytes, controller.signal),
            };
          } else {
            response = await requestPinned(url, addresses[0], init, maxBytes);
          }
          if (![301, 302, 303, 307, 308].includes(response.status))
            return response;
          if (redirects >= maxRedirects)
            throw new Error("Source redirect limit exceeded");
          const location = response.headers.get("location");
          if (!location) throw new Error("Source redirect is missing Location");
          const next = publicUrl(new URL(location, url).href);
          if (
            init.method !== "GET" ||
            ((headers.has("authorization") || headers.has("cookie")) &&
              next.origin !== url.origin)
          ) {
            throw new Error(
              "Authenticated or POST source request cannot follow this redirect",
            );
          }
          if (url.protocol === "https:" && next.protocol !== "https:")
            throw new Error("Source redirect cannot downgrade HTTPS");
          url = next;
        }
      })(),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort();
  }
}
