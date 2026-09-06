import Anthropic from "@anthropic-ai/sdk";

interface OllamaTagsResponse {
  models?: Array<{ name: string }>;
}

export async function listOllamaModels(baseUrl: string): Promise<string[]> {
  const endpoint = new URL("/api/tags", baseUrl);
  const response = await fetch(endpoint);
  if (!response.ok) {
    throw new Error(`failed to list Ollama models at ${endpoint} (${response.status}). Is Ollama running?`);
  }
  const body = (await response.json()) as OllamaTagsResponse;
  return (body.models ?? []).map((model) => model.name);
}

export async function listClaudeModels(): Promise<string[]> {
  const client = new Anthropic();
  const ids: string[] = [];
  for await (const model of client.models.list()) {
    ids.push(model.id);
  }
  return ids;
}
