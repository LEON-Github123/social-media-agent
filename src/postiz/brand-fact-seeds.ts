/** Public documentation candidates recorded on 2026-09-29. Operator confirmation is required. */
export const TOKENHOT_BRAND_FACT_SEEDS = [
  {
    id: "tokenhot-doc-openai-base-url",
    claim:
      "The documented OpenAI-compatible API base URL is https://api.tokenhot.ai/v1.",
    url: "https://docs.tokenhot.ai/start",
    evidence: "API Base URL; https://api.tokenhot.ai/v1",
    keywords: ["base URL", "OpenAI SDK"],
    category: "integration",
  },
  {
    id: "tokenhot-doc-bearer-auth",
    claim:
      "The quick start specifies bearer-token authentication using a Tokenhot API key.",
    url: "https://docs.tokenhot.ai/start",
    evidence: "Authentication; Bearer Token（API Key）",
    keywords: ["authentication", "API key", "bearer token"],
    category: "integration",
  },
  {
    id: "tokenhot-doc-chat-completions",
    claim:
      "The OpenAI-compatible chat-completions endpoint is documented as POST https://api.tokenhot.ai/v1/chat/completions.",
    url: "https://docs.tokenhot.ai/general",
    evidence: "POST; /v1/chat/completions",
    keywords: ["chat completions", "/v1/chat/completions"],
    category: "integration",
  },
  {
    id: "tokenhot-doc-model-parameter",
    claim:
      "In the documented chat-completions format, clients select the provider model through the request's model parameter.",
    url: "https://docs.tokenhot.ai/general",
    evidence: "replace the model parameter",
    keywords: ["model routing", "chat completions"],
    category: "integration",
  },
  {
    id: "tokenhot-doc-openai-sdk-migration",
    claim:
      "The quick start describes OpenAI SDK migration by changing base_url and api_key.",
    url: "https://docs.tokenhot.ai/start",
    evidence: "change base_url and api_key",
    keywords: ["OpenAI SDK migration", "base_url", "api_key"],
    category: "integration",
  },
  {
    id: "tokenhot-doc-tool-integrations",
    claim:
      "Tokenhot publishes setup guides for Claude Code, Codex CLI, and Gemini CLI under Anthropic, OpenAI, and Gemini protocols, respectively.",
    url: "https://docs.tokenhot.ai/navigation",
    evidence:
      "Claude Code … Anthropic; Codex CLI … OpenAI; Gemini CLI … Gemini",
    keywords: ["Claude Code", "Codex CLI", "Gemini CLI"],
    category: "integration",
  },
  {
    id: "tokenhot-doc-doubao-seedance-2-5",
    claim:
      "Tokenhot's Seedance 2.5 API documentation names the model code doubao-seedance-2.5 and a video-generation POST endpoint.",
    url: "https://docs.tokenhot.ai/41391413e0",
    evidence: "Model Code: doubao-seedance-2.5; POST /v1/video/generations",
    keywords: ["doubao-seedance-2.5"],
    category: "model",
  },
  {
    id: "tokenhot-doc-gemini-3-1-flash-image-preview",
    claim:
      "Tokenhot lists gemini-3.1-flash-image-preview for image generation and editing with text and image output.",
    url: "https://tokenhot.ai/models/gemini-3.1-flash-image-preview",
    evidence: "image generation and editing; Text / Image",
    keywords: ["gemini-3.1-flash-image-preview"],
    category: "model",
  },
] as const;
