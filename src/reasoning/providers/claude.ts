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
  //
  // max_tokens is generous (16384, raised from an original 8192) because
  // this same chat() now backs two very differently-sized schemas:
  // RECOMMENDATIONS_JSON_SCHEMA (one snapshot's per-engineer notes, the
  // original reason for 8192) and the much richer CUMULATIVE_JSON_SCHEMA
  // (team_overview's "usually means" diagnostics, engineer_patterns
  // scanning every engineer's full trajectory, a genuinely long
  // overall_assessment) added later for the Accumulated Report — a team
  // with a long history and many engineers can produce noticeably more
  // output under that schema than 8192 reliably allows; a real cut-off
  // was observed against a real 19-sprint, 12-engineer team's Accumulated
  // Report. A cut-off response is stopped mid string, which JSON.parse
  // reports as an opaque "Unterminated string" error with no indication
  // the real cause was a length limit — so stop_reason is checked first
  // and turned into a clear, actionable error instead of letting that
  // confusing parse failure surface to the caller.
  async chat(prompt: string, jsonSchema: Record<string, unknown>): Promise<unknown> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 16384,
      messages: [{ role: "user", content: prompt }],
      output_config: { format: { type: "json_schema", schema: jsonSchema } },
    });

    if (response.stop_reason === "max_tokens") {
      throw new Error(
        "ClaudeReasoningProvider: response was cut off before finishing (hit the max_tokens limit) — the reasoning output was too long to fit. Try a smaller team/sprint scope, or reduce how much detail the prompt asks for.",
      );
    }

    const textBlock = response.content.find((block): block is Anthropic.TextBlock => block.type === "text");
    if (!textBlock) throw new Error("ClaudeReasoningProvider: no text content in response");
    return JSON.parse(textBlock.text);
  }

  async reason(report: TeamReport, ctx?: ReasoningContext): Promise<TeamRecommendationsOutput> {
    const result = await this.chat(buildPrompt(report, ctx), RECOMMENDATIONS_JSON_SCHEMA);
    return TeamRecommendationsOutputSchema.parse(result);
  }
}
