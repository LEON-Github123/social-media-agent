import { ChatAnthropic } from "@langchain/anthropic";
import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";

export type ContentTask = "relevance" | "report" | "post" | "quality";

export interface ModelRequest {
  task: ContentTask;
  system: string;
  user: string;
}

/** A small injection boundary so content tests never need API credentials. */
export interface ContentModel {
  invoke(request: ModelRequest): Promise<string>;
}

export interface ModelSettings {
  provider: "openai" | "anthropic";
  model: string;
  apiKey: string;
  baseURL?: string;
  temperature?: number;
  timeoutMs?: number;
  maxOutputTokens?: number;
}

const settingsSchema = z.object({
  provider: z.enum(["openai", "anthropic"]),
  model: z.string().trim().min(1),
  apiKey: z.string().trim().min(1),
  baseURL: z
    .string()
    .url()
    .refine((value) => /^https?:\/\//i.test(value), "Use an HTTP(S) model URL")
    .optional(),
  // Omit temperature by default: some reasoning models reject it entirely.
  temperature: z.number().min(0).max(1).optional(),
  timeoutMs: z.number().int().min(1_000).max(300_000).default(60_000),
  maxOutputTokens: z.number().int().min(256).max(16_000).default(4_096),
});

export function modelText(content: unknown): string {
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .filter(
              (part): part is { type: "text"; text: string } =>
                typeof part === "object" &&
                part !== null &&
                part.type === "text" &&
                typeof part.text === "string",
            )
            .map((part) => part.text)
            .join("\n")
        : "";
  if (!text.trim() || text.length > 200_000) {
    throw new Error("The content model returned empty or oversized text");
  }
  return text.trim();
}

/**
 * Text-only adapter. A compatible URL is not a promise that every model supports
 * the same features: this flow needs only system/user text and text responses.
 * Structured decisions are validated by the content graph, not provider tools.
 */
export function createContentModel(input: ModelSettings): ContentModel {
  const settings = settingsSchema.parse(input);
  const common = {
    model: settings.model,
    apiKey: settings.apiKey,
    maxTokens: settings.maxOutputTokens,
    maxRetries: 0,
    timeout: settings.timeoutMs,
    ...(settings.temperature === undefined
      ? {}
      : { temperature: settings.temperature }),
  };
  const model =
    settings.provider === "anthropic"
      ? new ChatAnthropic({
          ...common,
          ...(settings.baseURL
            ? { clientOptions: { baseURL: settings.baseURL } }
            : {}),
        })
      : new ChatOpenAI({
          ...common,
          streaming: false,
          ...(settings.baseURL
            ? { configuration: { baseURL: settings.baseURL } }
            : {}),
        });

  return {
    async invoke(request) {
      try {
        const response = await model.invoke(
          [
            { role: "system", content: request.system },
            { role: "user", content: request.user },
          ],
          {
            signal: AbortSignal.timeout(settings.timeoutMs),
            runName: `content-${request.task}`,
          },
        );
        return modelText(response.content);
      } catch (error) {
        // Provider errors may contain request bodies or credentials. The worker
        // logs only a safe stage/status and never the raw upstream response.
        const status =
          typeof error === "object" && error !== null && "status" in error
            ? Number(error.status)
            : undefined;
        throw new Error(
          `Content model ${request.task} request failed` +
            (status && Number.isInteger(status) ? ` (HTTP ${status})` : ""),
        );
      }
    },
  };
}
