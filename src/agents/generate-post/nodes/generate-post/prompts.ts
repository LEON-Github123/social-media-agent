import { getPrompts } from "../../prompts/index.js";
import { buildPostPrompt } from "../prompt-core.js";

export const GENERATE_POST_PROMPT = buildPostPrompt({
  examples: getPrompts().tweetExamples,
  structureInstructions: getPrompts().postStructureInstructions,
  contentRules: getPrompts().postContentRules,
});
