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
  // max_tokens went 8192 -> 16384 -> this (32768) chasing the same problem
  // twice, because raising it kept running into a DIFFERENT ceiling each
  // time rather than the model's actual output limit. This chat() backs
  // both RECOMMENDATIONS_JSON_SCHEMA (one snapshot, the original 8192 case)
  // and the much richer CUMULATIVE_JSON_SCHEMA (Accumulated Report), and a
  // real cut-off against a real 19-sprint, 13-engineer team's Accumulated
  // Report happened even at 16384 — worse once weight-aware reasoning
  // (src/db/teamProfile.ts's overlayCurrentRosterFacts) gave the model more
  // to say about more people. Bumping max_tokens straight to 32000 to fix
  // that hit a THIRD, unrelated wall: the Anthropic SDK refuses a
  // non-streaming call whose max_tokens implies a response that could take
  // longer than 10 minutes to generate, and throws before ever reaching the
  // network — confirmed directly (32000 non-streaming fails immediately
  // with that message; the identical request succeeds over
  // client.messages.stream()). So the real, durable fix is streaming
  // (removes that ceiling entirely, letting max_tokens follow the schema's
  // actual needs) — not another guess at a bigger constant. .finalMessage()
  // assembles the complete Message the same shape create() would have
  // returned, so everything below is unchanged. A cut-off response is
  // stopped mid string, which JSON.parse reports as an opaque "Unterminated
  // string" error with no indication the real cause was a length limit —
  // so stop_reason is still checked first and turned into a clear,
  // actionable error instead of letting that confusing parse failure
  // surface to the caller.
  async chat(prompt: string, jsonSchema: Record<string, unknown>): Promise<unknown> {
    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: 32768,
      messages: [{ role: "user", content: prompt }],
      output_config: { format: { type: "json_schema", schema: jsonSchema } },
    });
    const response = await stream.finalMessage();

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
