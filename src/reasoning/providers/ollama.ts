import type { TeamReport } from "../../schema/canonical.js";
import { RECOMMENDATIONS_JSON_SCHEMA, TeamRecommendationsOutputSchema, type TeamRecommendationsOutput } from "../schema.js";
import type { ReasoningContext, ReasoningProvider } from "../types.js";
import { buildPrompt } from "../types.js";

interface OllamaChatResponse {
  message?: { role: string; content: string };
}

// Default reasoning provider — a local/self-hosted Ollama server, not a
// single vendor API, in keeping with claude.md's "agent-agnostic" and "no
// coupling to a single LLM" principles. Structured output uses Ollama's
// `format` field (a raw JSON Schema), then a Zod pass validates the result
// since Ollama's schema conformance isn't as strictly guaranteed as a
// provider with native structured-output support.
export class OllamaReasoningProvider implements ReasoningProvider {
  constructor(
    private readonly baseUrl: string = "http://localhost:11434",
    private readonly model: string = "llama3.1",
  ) {}

  // Generic structured-output call — any prompt, any JSON Schema. Callers
  // validate the result with their own Zod schema (see reason.ts and
  // cumulativeReason.ts) so this class stays agnostic to what's being asked.
  async chat(prompt: string, jsonSchema: Record<string, unknown>): Promise<unknown> {
    const endpoint = new URL("/api/chat", this.baseUrl);
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: "user", content: prompt }],
        stream: false,
        format: jsonSchema,
      }),
    });

    if (!response.ok) {
      throw new Error(
        `OllamaReasoningProvider: request to ${endpoint} failed (${response.status}). Is Ollama running and is model "${this.model}" pulled?`,
      );
    }

    const body = (await response.json()) as OllamaChatResponse;
    const content = body.message?.content;
    if (!content) throw new Error("OllamaReasoningProvider: empty response from model");
    return JSON.parse(content);
  }

  async reason(report: TeamReport, ctx?: ReasoningContext): Promise<TeamRecommendationsOutput> {
    const result = await this.chat(buildPrompt(report, ctx), RECOMMENDATIONS_JSON_SCHEMA);
    return TeamRecommendationsOutputSchema.parse(result);
  }
}
