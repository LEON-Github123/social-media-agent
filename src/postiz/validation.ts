import { z } from "zod";
import { publicUrl } from "./network.js";

export const MAX_SOURCES_PER_JOB = 8;
export const MAX_SOURCE_URL_LENGTH = 4_096;
export const MAX_SOURCE_TEXT_CHARS = 100_000;
export const MAX_TOTAL_SOURCE_TEXT_CHARS = 180_000;

export interface BrandConfig {
  id: string;
  name: string;
  audience: string;
  businessContext: string;
  contentRules: string[];
  examples: string[];
  language: string;
  verifiedFacts?: { claim: string; url: string }[];
  maxPostLength?: number;
}

export interface SourceInput {
  url: string;
  text?: string;
  title?: string;
  publishedAt?: string;
}

export interface SourceDocument extends SourceInput {
  text: string;
}

export interface ContentInput {
  brand: BrandConfig;
  sources: SourceDocument[];
}

export interface ValidatedJobInput {
  brand: BrandConfig;
  sources: SourceInput[];
  integrationId: string;
  mediaPaths: string[];
}

/**
 * Synchronous validation only: no fetch or DNS. The network layer still checks
 * resolved addresses and redirects when a source is actually fetched.
 */
export const sourceUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_SOURCE_URL_LENGTH)
  .transform((value, context) => {
    try {
      if (
        /\s/.test(value) ||
        value.includes("\\") ||
        Array.from(value).some((character) => {
          const code = character.charCodeAt(0);
          return code < 32 || code === 127;
        })
      ) {
        throw new Error(
          "Source URL must not contain whitespace, controls, or backslashes",
        );
      }
      return publicUrl(value).href;
    } catch (error) {
      context.addIssue({
        code: "custom",
        message:
          error instanceof Error ? error.message : "Source URL is invalid",
      });
      return z.NEVER;
    }
  })
  .pipe(z.string().max(MAX_SOURCE_URL_LENGTH));

const nonempty = (maximum: number) => z.string().trim().min(1).max(maximum);

export const brandSchema = z.object({
  id: nonempty(100).regex(/^[a-zA-Z0-9_-]+$/),
  name: nonempty(200),
  audience: nonempty(4_000),
  businessContext: nonempty(20_000),
  contentRules: z.array(nonempty(2_000)).max(50).default([]),
  examples: z.array(nonempty(4_000)).max(20).default([]),
  language: nonempty(80).default("English"),
  verifiedFacts: z
    .array(z.object({ claim: nonempty(4_000), url: sourceUrlSchema }))
    .max(50)
    .default([]),
  maxPostLength: z.number().int().min(30).max(280).default(280),
});

const publishedAtSchema = nonempty(100)
  .pipe(z.union([z.iso.date(), z.iso.datetime({ offset: true })]))
  .transform((value) => new Date(value).toISOString());

export const sourceInputSchema = z.object({
  url: sourceUrlSchema,
  title: nonempty(2_000).optional(),
  text: nonempty(MAX_SOURCE_TEXT_CHARS).optional(),
  publishedAt: publishedAtSchema.optional(),
});

export const sourceDocumentSchema = sourceInputSchema.extend({
  text: nonempty(MAX_SOURCE_TEXT_CHARS),
});

function checkTotalSourceText(sources: SourceInput[]): boolean {
  return (
    sources.reduce((size, source) => size + (source.text?.length ?? 0), 0) <=
    MAX_TOTAL_SOURCE_TEXT_CHARS
  );
}

export const sourceInputsSchema = z
  .array(sourceInputSchema)
  .min(1)
  .max(MAX_SOURCES_PER_JOB)
  .refine(
    checkTotalSourceText,
    "Source documents exceed the content workflow input limit",
  );

export const sourceDocumentsSchema = z
  .array(sourceDocumentSchema)
  .min(1)
  .max(MAX_SOURCES_PER_JOB)
  .refine(
    checkTotalSourceText,
    "Source documents exceed the content workflow input limit",
  );

export const contentInputSchema = z.object({
  brand: brandSchema,
  sources: sourceDocumentsSchema,
});

export const jobInputSchema = z.object({
  brand: brandSchema,
  sources: sourceInputsSchema,
  integrationId: nonempty(200),
  mediaPaths: z
    .array(
      nonempty(4_096).refine(
        (value) => !value.includes("\u0000"),
        "Media path must not contain NUL",
      ),
    )
    .max(4)
    .default([]),
});

export function validateBrand(value: unknown): BrandConfig {
  return brandSchema.parse(value);
}

/** Validate the entire batch before enqueueing or starting any extraction. */
export function validateSourceInputs(value: unknown): SourceInput[] {
  return sourceInputsSchema.parse(value);
}

export function validateSourceDocuments(value: unknown): SourceDocument[] {
  return sourceDocumentsSchema.parse(value);
}

export function validateContentInput(value: unknown): ContentInput {
  return contentInputSchema.parse(value);
}

export function validateJobInput(value: unknown): ValidatedJobInput {
  return jobInputSchema.parse(value);
}
