import { randomUUID } from "node:crypto";
import { TOKENHOT_BRAND_FACT_SEEDS } from "./brand-fact-seeds.js";
import { ContentFeedbackStore } from "./feedback-store.js";
import type { SourceInput } from "./validation.js";
import { sourceUrlSchema } from "./validation.js";

type Row = Record<string, unknown>;
const DAY = 86_400_000;
const CATEGORIES = ["integration", "model", "feature", "pricing"] as const;
const STATUSES = ["pending", "verified", "retired"] as const;

export interface BrandFact {
  id: string;
  brandId: string;
  claim: string;
  url: string;
  evidence: string;
  keywords: string[];
  category: (typeof CATEGORIES)[number];
  status: (typeof STATUSES)[number];
  observedAt: number;
  verifiedAt: number | null;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
}

type FactContent = Pick<
  BrandFact,
  | "claim"
  | "url"
  | "evidence"
  | "keywords"
  | "category"
  | "observedAt"
  | "expiresAt"
>;

function boundedText(value: unknown, name: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.trim().length > maximum
  )
    throw new TypeError(
      `${name} must be non-empty and at most ${maximum} characters`,
    );
  return value.trim();
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Brand fact input must be an object");
  return value as Record<string, unknown>;
}

function timestamp(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new TypeError(`${name} must be a non-negative integer timestamp`);
  return value as number;
}

function validateContent(
  input: Record<string, unknown>,
  now: number,
): FactContent {
  const claim = boundedText(input.claim, "claim", 4_000);
  const parsedUrl = sourceUrlSchema.safeParse(input.url);
  if (!parsedUrl.success) throw new TypeError("url must be a public URL");
  const url = parsedUrl.data;
  const evidence = boundedText(input.evidence, "evidence", 4_000);
  if (
    !Array.isArray(input.keywords) ||
    input.keywords.length < 1 ||
    input.keywords.length > 12
  )
    throw new TypeError("keywords must contain 1 to 12 terms");
  const keywords = input.keywords.map((word) =>
    boundedText(word, "keyword", 100),
  );
  if (!CATEGORIES.includes(input.category as BrandFact["category"]))
    throw new TypeError("Invalid brand fact category");
  const category = input.category as BrandFact["category"];
  const observedAt = timestamp(input.observedAt, "observedAt");
  if (observedAt > now)
    throw new TypeError("observedAt cannot be in the future");
  const expiresAt = timestamp(input.expiresAt, "expiresAt");
  const limit = category === "pricing" ? 7 : 90;
  if (expiresAt <= observedAt || expiresAt - observedAt > limit * DAY)
    throw new TypeError(
      `expiresAt must be after observedAt and within ${limit} days`,
    );
  return { claim, url, evidence, keywords, category, observedAt, expiresAt };
}

function fromRow(row: Row): BrandFact {
  return {
    id: String(row.id),
    brandId: String(row.brand_id),
    claim: String(row.claim),
    url: String(row.url),
    evidence: String(row.evidence),
    keywords: JSON.parse(String(row.keywords_json)) as string[],
    category: row.category as BrandFact["category"],
    status: row.status as BrandFact["status"],
    observedAt: Number(row.observed_at),
    verifiedAt: row.verified_at === null ? null : Number(row.verified_at),
    expiresAt: Number(row.expires_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function sameContent(left: FactContent, right: FactContent): boolean {
  return (
    left.claim === right.claim &&
    left.url === right.url &&
    left.evidence === right.evidence &&
    left.category === right.category &&
    left.observedAt === right.observedAt &&
    left.expiresAt === right.expiresAt &&
    JSON.stringify(left.keywords) === JSON.stringify(right.keywords)
  );
}

function exactTerm(haystack: string, term: string): boolean {
  const lower = term.toLowerCase();
  let offset = 0;
  for (;;) {
    const index = haystack.indexOf(lower, offset);
    if (index < 0) return false;
    const before = index === 0 ? "" : haystack[index - 1];
    const after = haystack[index + lower.length] ?? "";
    const following = haystack[index + lower.length + 1] ?? "";
    const afterIsBoundary =
      !/[\p{L}\p{N}_.-]/u.test(after) ||
      (after === "." && !/[\p{L}\p{N}_-]/u.test(following));
    if (!/[\p{L}\p{N}_.-]/u.test(before) && afterIsBoundary) return true;
    offset = index + 1;
  }
}

function matches(
  fact: BrandFact,
  sources: SourceInput[],
  brandId: string,
): boolean {
  return sources.some((source) => {
    if (fact.category === "model" && source.url === fact.url) return true;
    const content = `${source.title ?? ""}\n${source.text ?? ""}`.toLowerCase();
    if (fact.category === "model") {
      // Model facts require a complete code, including its version and variant.
      return fact.keywords.some(
        (keyword) =>
          /^(?=.*\d)[a-z0-9]+(?:[-_.][a-z0-9]+)+$/i.test(keyword) &&
          exactTerm(content, keyword),
      );
    }
    return fact.keywords.some(
      (keyword) =>
        keyword.length >= 4 &&
        !keyword.toLowerCase().includes(brandId.toLowerCase()) &&
        exactTerm(content, keyword),
    );
  });
}

/** Persistent operator-reviewed brand facts. Seeds never become verified automatically. */
export abstract class BrandKnowledgeStore extends ContentFeedbackStore {
  listBrandFacts(brandId: string): BrandFact[] {
    boundedText(brandId, "brandId", 100);
    return this.db
      .prepare(
        "SELECT * FROM brand_facts WHERE brand_id=? ORDER BY created_at,id",
      )
      .all(brandId)
      .map(fromRow);
  }

  createBrandFact(brandId: string, input: unknown): BrandFact {
    boundedText(brandId, "brandId", 100);
    const values = object(input);
    const content = validateContent(values, this.now());
    return this.transaction(() => {
      const now = this.now();
      const fact: BrandFact = {
        id: randomUUID(),
        brandId,
        ...content,
        status: "pending",
        verifiedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      this.insertFact(fact);
      this.recordAudit({
        brandId,
        eventType: "brand_fact.created",
        reason: "Created pending brand fact",
        before: null,
        after: fact,
      });
      return fact;
    });
  }

  updateBrandFact(brandId: string, id: string, input: unknown): BrandFact {
    boundedText(brandId, "brandId", 100);
    boundedText(id, "id", 200);
    const patch = object(input);
    const reason = boundedText(patch.reason, "reason", 2_000);
    if (
      patch.status !== undefined &&
      !STATUSES.includes(patch.status as BrandFact["status"])
    )
      throw new TypeError("Invalid brand fact status");
    return this.transaction(() => {
      const row = this.db
        .prepare("SELECT * FROM brand_facts WHERE brand_id=? AND id=?")
        .get(brandId, id);
      if (!row) throw new Error("Brand fact not found for this brand");
      const before = fromRow(row);
      const content = validateContent({ ...before, ...patch }, this.now());
      const changed = !sameContent(before, content);
      const status =
        (patch.status as BrandFact["status"] | undefined) ??
        (changed ? "pending" : before.status);
      if (status === "verified" && content.expiresAt <= this.now())
        throw new TypeError("Expired brand facts cannot be verified");
      const after: BrandFact = {
        ...before,
        ...content,
        status,
        verifiedAt:
          status === "verified"
            ? patch.status === "verified" || changed
              ? this.now()
              : before.verifiedAt
            : null,
        updatedAt: this.now(),
      };
      this.db
        .prepare(
          `UPDATE brand_facts SET claim=?,url=?,evidence=?,keywords_json=?,category=?,
        status=?,observed_at=?,verified_at=?,expires_at=?,updated_at=? WHERE brand_id=? AND id=?`,
        )
        .run(
          after.claim,
          after.url,
          after.evidence,
          JSON.stringify(after.keywords),
          after.category,
          after.status,
          after.observedAt,
          after.verifiedAt,
          after.expiresAt,
          after.updatedAt,
          brandId,
          id,
        );
      this.recordAudit({
        brandId,
        eventType: "brand_fact.updated",
        reason,
        before,
        after,
      });
      return after;
    });
  }

  seedBrandFacts(brandId: string): void {
    boundedText(brandId, "brandId", 100);
    if (brandId !== "tokenhot") return;
    this.transaction(() => {
      const observedAt = Date.UTC(2026, 8, 29);
      for (const seed of TOKENHOT_BRAND_FACT_SEEDS) {
        const now = this.now();
        const fact: BrandFact = {
          ...seed,
          brandId,
          keywords: [...seed.keywords],
          category: seed.category,
          status: "pending",
          observedAt,
          verifiedAt: null,
          expiresAt: observedAt + 90 * DAY,
          createdAt: now,
          updatedAt: now,
        };
        if (this.insertFact(fact, true)) {
          this.recordAudit({
            brandId,
            eventType: "brand_fact.seeded",
            actor: "system",
            reason:
              "Seeded public documentation candidate pending operator review",
            before: null,
            after: fact,
          });
        }
      }
    });
  }

  matchBrandFacts(brandId: string, sources: SourceInput[]): BrandFact[] {
    boundedText(brandId, "brandId", 100);
    if (!Array.isArray(sources))
      throw new TypeError("sources must be an array");
    const rows = this.db
      .prepare(
        `SELECT * FROM brand_facts WHERE brand_id=?
      AND status='verified' AND verified_at IS NOT NULL AND expires_at>?
      ORDER BY updated_at DESC,id`,
      )
      .all(brandId, this.now());
    return rows
      .map(fromRow)
      .filter((fact) => matches(fact, sources, brandId))
      .slice(0, 8);
  }

  private insertFact(fact: BrandFact, ignore = false): boolean {
    const result = this.db
      .prepare(
        `INSERT ${ignore ? "OR IGNORE " : ""}INTO brand_facts
      (id,brand_id,claim,url,evidence,keywords_json,category,status,observed_at,
       verified_at,expires_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        fact.id,
        fact.brandId,
        fact.claim,
        fact.url,
        fact.evidence,
        JSON.stringify(fact.keywords),
        fact.category,
        fact.status,
        fact.observedAt,
        fact.verifiedAt,
        fact.expiresAt,
        fact.createdAt,
        fact.updatedAt,
      );
    return Number(result.changes) === 1;
  }
}
