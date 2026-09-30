import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadBrand, brandSchema as configuredBrandSchema } from "../config.js";
import {
  brandSchema,
  validateBrand,
  validateContentInput,
  validateJobInput,
  validateSourceDocuments,
  validateSourceInputs,
} from "../validation.js";

const brand = {
  id: "brand-one",
  name: "Example",
  audience: "Developers",
  businessContext: "Practical API integration tutorials",
};

const source = {
  url: "https://example.com/docs",
  text: "Use PNG or JPEG inputs.",
};

void test("brand config, loading, and generation use the same bounded schema and defaults", async () => {
  assert.equal(configuredBrandSchema, brandSchema);
  const expected = validateBrand(brand);
  assert.deepEqual(expected, {
    ...brand,
    language: "English",
    contentRules: [],
    examples: [],
    verifiedFacts: [],
    maxPostLength: 280,
  });
  assert.deepEqual(
    validateContentInput({ brand, sources: [source] }).brand,
    expected,
  );
  const directory = await mkdtemp(join(tmpdir(), "postiz-brand-validation-"));
  const path = join(directory, "brand.json");
  try {
    await writeFile(path, JSON.stringify(brand));
    assert.deepEqual(await loadBrand(path), expected);
    await writeFile(
      path,
      JSON.stringify({ ...brand, audience: "a".repeat(4_001) }),
    );
    await assert.rejects(loadBrand(path));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("all brand field and collection bounds apply before a generation job", () => {
  for (const field of [
    { id: "a".repeat(101) },
    { id: "bad/id" },
    { name: "a".repeat(201) },
    { audience: "a".repeat(4_001) },
    { businessContext: "a".repeat(20_001) },
    { contentRules: ["a".repeat(2_001)] },
    { contentRules: Array(51).fill("rule") },
    { examples: ["a".repeat(4_001)] },
    { examples: Array(21).fill("example") },
    { language: "a".repeat(81) },
    { verifiedFacts: [{ claim: "a".repeat(4_001), url: source.url }] },
    { verifiedFacts: Array(51).fill({ claim: "fact", url: source.url }) },
    { verifiedFacts: [{ claim: "fact", url: "file:///private" }] },
    { maxPostLength: 29 },
    { maxPostLength: 281 },
  ]) {
    assert.throws(() => validateBrand({ ...brand, ...field }));
    assert.throws(() =>
      validateContentInput({
        brand: { ...brand, ...field },
        sources: [source],
      }),
    );
  }
});

void test("one to eight source items share the same enqueue and generated-document limits", () => {
  for (const length of [1, 8]) {
    const sources = Array.from({ length }, (_, index) => ({
      ...source,
      url: `${source.url}/${index}`,
    }));
    assert.equal(validateSourceInputs(sources).length, length);
    assert.equal(validateSourceDocuments(sources).length, length);
    assert.equal(
      validateContentInput({ brand, sources }).sources.length,
      length,
    );
  }
  for (const length of [0, 9]) {
    const sources = Array.from({ length }, () => source);
    assert.throws(() => validateSourceInputs(sources));
    assert.throws(() => validateSourceDocuments(sources));
    assert.throws(() => validateContentInput({ brand, sources }));
  }
});

void test("every item is validated; a bad later source rejects the whole batch", () => {
  for (const badSource of [
    null,
    { url: "relative/path" },
    { url: source.url, text: " " },
    { url: source.url, title: "" },
    { url: source.url, text: 123 },
    { url: source.url, publishedAt: "sometime soon" },
  ]) {
    assert.throws(() => validateSourceInputs([source, badSource]));
    assert.throws(() =>
      validateJobInput({
        brand,
        sources: [source, badSource],
        integrationId: "x-channel",
      }),
    );
  }
});

void test("URLs reject unsafe or oversized forms consistently for sources and brand facts", () => {
  for (const url of [
    "ftp://example.com/file",
    "javascript:alert(1)",
    "https://user:password@example.com/",
    "http://127.0.0.1/secret",
    "http://192.168.1.1/secret",
    "http://localhost:4000/",
    "http://service.internal/",
    "https://exa\nmple.com/",
    "https://example.com\\path",
    `https://example.com/${"a".repeat(4_096)}`,
  ]) {
    assert.throws(() => validateSourceInputs([{ ...source, url }]));
    assert.throws(() => validateSourceDocuments([{ ...source, url }]));
    assert.throws(() =>
      validateBrand({ ...brand, verifiedFacts: [{ claim: "fact", url }] }),
    );
  }
});

void test("canonical source URLs preserve query parameters, with no fetch or DNS required", () => {
  const supplied =
    " HTTPS://Example.COM:443/docs?version=1&utm_source=x#section ";
  assert.equal(
    validateSourceInputs([{ url: supplied }])[0].url,
    "https://example.com/docs?version=1&utm_source=x",
  );
});

void test("URL-only queued sources are allowed but generation requires extracted text", () => {
  assert.deepEqual(validateSourceInputs([{ url: source.url }]), [
    { url: source.url },
  ]);
  assert.throws(() => validateSourceDocuments([{ url: source.url }]));
  assert.throws(() =>
    validateContentInput({ brand, sources: [{ url: source.url }] }),
  );
});

void test("text and title bounds reject excess instead of silently truncating supplied evidence", () => {
  assert.equal(
    validateSourceInputs([{ ...source, text: "a".repeat(100_000) }])[0].text!
      .length,
    100_000,
  );
  for (const properties of [
    { text: "a".repeat(100_001) },
    { title: "a".repeat(2_001) },
  ]) {
    assert.throws(() => validateSourceInputs([{ ...source, ...properties }]));
    assert.throws(() =>
      validateSourceDocuments([{ ...source, ...properties }]),
    );
  }
  const maximum = [
    { ...source, text: "a".repeat(100_000) },
    { ...source, url: `${source.url}/second`, text: "b".repeat(80_000) },
  ];
  assert.equal(validateSourceInputs(maximum).length, 2);
  assert.equal(validateSourceDocuments(maximum).length, 2);
  maximum[1].text += "b";
  assert.throws(() => validateSourceInputs(maximum), /input limit/);
  assert.throws(() => validateSourceDocuments(maximum), /input limit/);
});

void test("publishedAt accepts valid ISO dates and offsets but rejects impossible dates", () => {
  assert.equal(
    validateSourceInputs([{ ...source, publishedAt: "2026-09-24" }])[0]
      .publishedAt,
    "2026-09-24T00:00:00.000Z",
  );
  assert.equal(
    validateSourceInputs([
      { ...source, publishedAt: "2026-09-24T08:00:00+08:00" },
    ])[0].publishedAt,
    "2026-09-24T00:00:00.000Z",
  );
  for (const publishedAt of [
    "",
    "2026-02-30",
    "2026-09-24T27:00:00Z",
    "tomorrow",
    "2026-09-24T08:00:00",
  ]) {
    assert.throws(() => validateSourceInputs([{ ...source, publishedAt }]));
  }
});

void test("persisted and enqueue job inputs share bounded integration and media fields", () => {
  const input = { brand, sources: [source], integrationId: "x-channel" };
  assert.deepEqual(validateJobInput(input).mediaPaths, []);
  for (const invalid of [
    { integrationId: "" },
    { integrationId: "x".repeat(201) },
    { mediaPaths: [""] },
    { mediaPaths: ["assets/\u0000image.png"] },
    { mediaPaths: ["a".repeat(4_097)] },
    { mediaPaths: Array(5).fill("image.png") },
    { mediaPaths: "image.png" },
  ]) {
    assert.throws(() => validateJobInput({ ...input, ...invalid }));
  }
  assert.equal(
    validateJobInput({
      ...input,
      integrationId: "x".repeat(200),
      mediaPaths: Array(4).fill("a".repeat(4_096)),
    }).mediaPaths.length,
    4,
  );
});
