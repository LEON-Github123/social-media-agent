import { getPrompts } from "../../prompts/index.js";
import { buildReportPrompt } from "../prompt-core.js";

export const GENERATE_REPORT_PROMPT = buildReportPrompt({
  businessContext: getPrompts().businessContext,
});
