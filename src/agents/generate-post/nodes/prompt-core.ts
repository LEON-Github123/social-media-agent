/**
 * Pure prompt builders shared by the original graphs and the standalone content
 * worker. Defaults preserve the legacy prompts; explicit options remove the
 * legacy brand, scheduling and reflection assumptions for new callers.
 */
const STRUCTURE_GUIDELINES = `<part key="1">
This is the introduction and summary of the content. This must include key details such as:
- the name of the content/product/service.
- what the content/product/service does, and/or the problems it solves.
- unique selling points or interesting facts about the content.
- a high level summary of the content/product/service.

Ensure this is section packed with details and engaging.
</part>

<part key="2">
This section should focus on how the content implements, or related to any of the business context outlined above. It should include:
- key details about how it relates to the context.
- any product(s) or service(s) used in the content.
- why the content is relevant to the business context.
- how the content is used, implemented, or related.
- why these products are important to the application.
</part>

<part key="3">
This section should cover any additional details about the content that the first two parts missed. It should include:
- a detailed technical overview of the content.
- interesting facts about the content.
- any other relevant information that may be engaging to readers.

This is the section where you should include any relevant parts of the content which you were unable to include in the first two sections.
Ensure you do NOT leave out any relevant details in the report. You want your report to be extensive and detailed. Remember, it's better to overdo it than underdo it.
</part>`;

const REPORT_RULES = `- Focus on the subject of the content, and how it uses or relates to the business context outlined above.
- The final Tweet/LinkedIn post will be developer focused, so ensure the report is VERY technical and detailed.
- You should include ALL relevant details in the report, because doing this will help the final post be more informed, relevant and engaging.
- Include any relevant links found in the content in the report. These will be useful for readers to learn more about the content.
- Include details about what the product does, what problem it solves, and how it works. If the content is not about a product, you should focus on what the content is about instead of making it product focused.
- Use proper markdown styling when formatting the marketing report.
- Generate the report in English, even if the content submitted is not in English.`;

const DEFAULT_REPORT_FRAMING = `You have been tasked with writing a marketing report on content submitted to you from a third party which uses your products.
This marketing report will then be used to craft Tweets and LinkedIn posts promoting the content and your products.`;

const DEFAULT_REPORT_OUTPUT = `- First, read over the content VERY thoroughly.
- Take notes, and write down your thoughts about the content after reading it carefully. These should be interesting insights or facts which you think you'll need later on when writing the final report. This should be the first text you write. ALWAYS perform this step first, and wrap the notes and thoughts inside opening and closing "<thinking>" tags.
- Finally, write the report. Use the notes and thoughts you wrote down in the previous step to help you write the report. This should be the last text you write. Wrap your report inside "<report>" tags. Ensure you ALWAYS WRAP your report inside the "<report>" tags, with an opening and closing tag.`;

export interface ReportPromptOptions {
  businessContext: string;
  structureGuidelines?: string;
  rules?: string;
  framing?: string;
  outputInstructions?: string;
}

export function buildReportPrompt(options: ReportPromptOptions): string {
  return `You are a highly regarded marketing employee.
${options.framing ?? DEFAULT_REPORT_FRAMING}

${options.businessContext}

The marketing report should follow the following structure guidelines. It will be made up of three main sections outlined below:
<structure-guidelines>
${options.structureGuidelines ?? STRUCTURE_GUIDELINES}
</structure-guidelines>

Follow these rules and guidelines when generating the report:
<rules>
${options.rules ?? REPORT_RULES}
<rules>

Lastly, you should use the following process when writing the report:
<writing-process>
${options.outputInstructions ?? DEFAULT_REPORT_OUTPUT}
</writing-process>

Do not include any personal opinions or biases in the report. Stick to the facts and technical details.
Your response should ONLY include the marketing report, and no other text.
Remember, the more detailed and engaging the report, the better!!
Finally, remember to have fun!

Given these instructions, examine the users input closely, and generate a detailed and thoughtful marketing report on it.`;
}

const DEFAULT_POST_OUTPUT = `Step 1. First, read over the marketing report VERY thoroughly.
Step 2. Take notes, and write down your thoughts about the report after reading it carefully. This should include details you think will help make the post more engaging, and your initial thoughts about what to focus the post on, the style, etc. This should be the first text you write. Wrap the notes and thoughts inside a "<thinking>" tag.
Step 3. Lastly, write the LinkedIn/Twitter post. Use the notes and thoughts you wrote down in the previous step to help you write the post. This should be the last text you write. Wrap your report inside a "<post>" tag. Ensure you write only ONE post for both LinkedIn and Twitter.
IMPORTANT: Ensure the post header ALWAYS starts with 'LangChain Community Spotlight:' followed by the project name.`;

const DEFAULT_EXAMPLES_INTRODUCTION =
  "The following are examples of LinkedIn/Twitter posts on third-party content that have done well, and you should use them as style inspiration for your post:";

export interface PostPromptOptions {
  examples: string;
  structureInstructions: string;
  contentRules: string;
  reflections?: string;
  examplesIntroduction?: string;
  outputInstructions?: string;
}

export function buildPostPrompt(options: PostPromptOptions): string {
  return `You're a highly regarded marketing employee, working on crafting thoughtful and engaging content for the LinkedIn and Twitter pages.
You've been provided with a report on some content that you need to turn into a LinkedIn/Twitter post. The same post will be used for both platforms.
Your coworker has already taken the time to write a detailed marketing report on this content for you, so please take your time and read it carefully.

${options.examplesIntroduction ?? DEFAULT_EXAMPLES_INTRODUCTION}
<examples>
${options.examples}
</examples>

Now that you've seen some examples, lets's cover the structure of the LinkedIn/Twitter post you should follow.
${options.structureInstructions}

This structure should ALWAYS be followed. And remember, the shorter and more engaging the post, the better (your yearly bonus depends on this!!).

Here are a set of rules and guidelines you should strictly follow when creating the LinkedIn/Twitter post:
<rules>
${options.contentRules}
</rules>

${options.reflections ?? "{reflectionsPrompt}"}

Lastly, you should follow the process below when writing the LinkedIn/Twitter post:
<writing-process>
${options.outputInstructions ?? DEFAULT_POST_OUTPUT}
</writing-process>

Given these examples, rules, and the content provided by the user, curate a LinkedIn/Twitter post that is engaging and follows the structure of the examples provided.`;
}
