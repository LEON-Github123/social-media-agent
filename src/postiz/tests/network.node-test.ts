import assert from "node:assert/strict";
import test from "node:test";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { fetchPublicText, isPublicAddress } from "../network.js";

const lookup = async () => [{ address: "8.8.8.8", family: 4 }];

function compressedResponse(body: Uint8Array, encoding: string): Response {
  return new Response(body, {
    headers: {
      "content-encoding": encoding,
      "content-length": String(body.byteLength),
    },
  });
}

void test("public IPv4 beside reserved 192.0 ranges remains eligible", () => {
  assert.equal(isPublicAddress("192.0.66.2"), true);
  assert.equal(isPublicAddress("192.0.0.1"), false);
  assert.equal(isPublicAddress("192.0.2.1"), false);
  assert.equal(isPublicAddress("192.168.1.1"), false);
});

void test("compressed source bodies are decoded inside both byte limits", async () => {
  for (const [encoding, encode] of [
    ["gzip", gzipSync],
    ["br", brotliCompressSync],
  ] as const) {
    const body = encode(Buffer.from("Official developer update"));
    const response = await fetchPublicText("https://example.com/feed", {
      lookup,
      fetch: async () => compressedResponse(body, encoding),
      maxBytes: 128,
    });
    assert.equal(response.text, "Official developer update");
  }
  const bomb = gzipSync(Buffer.from("x".repeat(10_000)));
  await assert.rejects(
    fetchPublicText("https://example.com/feed", {
      lookup,
      fetch: async () => compressedResponse(bomb, "gzip"),
      maxBytes: 128,
    }),
    /byte limit/,
  );
  const noisy = gzipSync(
    Buffer.from(Array.from({ length: 500 }, (_, i) => i % 256)),
  );
  await assert.rejects(
    fetchPublicText("https://example.com/feed", {
      lookup,
      fetch: async () => compressedResponse(noisy, "gzip"),
      maxBytes: 128,
    }),
    /byte limit/,
  );
});

void test("unknown encodings and mixed public/private DNS fail with bounded diagnostics", async () => {
  await assert.rejects(
    fetchPublicText("https://example.com/feed", {
      lookup,
      fetch: async () => compressedResponse(new Uint8Array([1, 2, 3]), "zstd"),
    }),
    /unsupported content encoding: zstd/,
  );
  await assert.rejects(
    fetchPublicText("https://example.com/feed", {
      lookup: async () => [
        { address: "8.8.8.8", family: 4 },
        { address: "2001:2::11a", family: 6 },
      ],
      fetch: async () => new Response("never"),
    }),
    /example\.com.*2001:2::11a/,
  );
});
