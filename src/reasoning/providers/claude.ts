import Anthropic from "@anthropic-ai/sdk";
import type { TeamReport } from "../../schema/canonical.js";
import { RECOMMENDATIONS_JSON_SCHEMA, TeamRecommendationsOutputSchema, type TeamRecommendationsOutput } from "../schema.js";
import type { ReasoningContext, ReasoningProvider } from "../types.js";
import { buildPrompt } from "../types.js";

// Alternate reasoning provider — the Claude API, for when a local Ollama
// model isn't available or isn't capable enough. Not the default; see
// OllamaReasoningProvider for why. Requires ANTHROPIC_API_KEY (or another
// credential the Anthropic SDK resolves automatically).
//
// Uses a raw JSON Schema via output_config.format rather than the SDK's
// zodOutputFormat helper (which needs Zod v4 internals) — our schemas stay
// on Zod v3, and the response is validated by the caller after parsing, the
// same pattern as OllamaReasoningProvider.
export class ClaudeReasoningProvider implements ReasoningProvider {
  private readonly client = new Anthropic();

  constructor(private readonly model: string = "claude-opus-5") {}

  // Generic structured-output call — see OllamaReasoningProvider.chat.
  async chat(prompt: string, jsonSchema: Record<string, unknown>): Promise<unknown> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }],
      output_config: { format: { type: "json_schema", schema: jsonSchema } },
    });

    const textBlock = response.content.find((block): block is Anthropic.TextBlock => block.type === "text");
    if (!textBlock) throw new Error("ClaudeReasoningProvider: no text content in response");
    return JSON.parse(textBlock.text);
  }

  async reason(report: TeamReport, ctx?: ReasoningContext): Promise<TeamRecommendationsOutput> {
    const result = await this.chat(buildPrompt(report, ctx), RECOMMENDATIONS_JSON_SCHEMA);
    return TeamRecommendationsOutputSchema.parse(result);
  }
}
