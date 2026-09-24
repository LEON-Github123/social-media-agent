import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

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
      (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
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
  if (
    !addresses.length ||
    addresses.some(
      (item) => !isPublicAddress(item.address) || ![4, 6].includes(item.family),
    )
  ) {
    throw new Error("Source DNS must resolve exclusively to public addresses");
  }
  return addresses;
}

async function readFetchBody(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const length = Number(response.headers.get("content-length"));
  if (length > maxBytes) {
    await response.body?.cancel();
    throw new Error("Source response exceeds byte limit");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes)
        throw new Error("Source response exceeds byte limit");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
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
        const encoding = headers.get("content-encoding");
        if (
          (encoding && encoding !== "identity") ||
          Number(headers.get("content-length")) > maxBytes
        ) {
          response.destroy();
          reject(
            new Error(
              encoding && encoding !== "identity"
                ? "Source returned unsupported content encoding"
                : "Source response exceeds byte limit",
            ),
          );
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            response.destroy(new Error("Source response exceeds byte limit"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () =>
          resolve({
            url: url.href,
            status: response.statusCode ?? 0,
            headers,
            text: Buffer.concat(chunks).toString("utf8"),
          }),
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
        headers.set("accept-encoding", "identity");
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
              text: await readFetchBody(fetched, maxBytes),
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
