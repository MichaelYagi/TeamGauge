import { readFile } from "node:fs/promises";
import type { Provider, ProviderResult } from "../types.js";
import type { ProviderOutput } from "../../schema/canonical.js";
import type { JiraSource } from "../../schema/config.js";
import { defaultJiraAdapter, type JiraIssueAdapter, type RawJiraIssue } from "./adapter.js";
import { computeSignalsForIssues, groupIssuesByEngineer } from "../common/computeSignals.js";

interface JiraSearchResponse {
  issues?: RawJiraIssue[];
}

function extractIssues(payload: unknown): RawJiraIssue[] {
  if (Array.isArray(payload)) return payload as RawJiraIssue[];
  const response = payload as JiraSearchResponse;
  return response.issues ?? [];
}

export class JiraProvider implements Provider<JiraSource> {
  readonly name = "jira";

  constructor(private readonly adapter: JiraIssueAdapter = defaultJiraAdapter) {}

  async ingest(source: JiraSource): Promise<ProviderResult> {
    const issues = await this.loadIssues(source);
    return { engineers: groupIssuesByEngineer(issues, this.adapter) };
  }

  // Flat aggregate matching claude.md's documented provider output shape
  // (`{ signals }`, no per-engineer breakdown) — used by `teamgauge ingest`
  // for raw provider inspection, independent of team-report assembly.
  async ingestFlat(source: JiraSource): Promise<ProviderOutput> {
    const issues = await this.loadIssues(source);
    return { signals: computeSignalsForIssues(issues, this.adapter).signals };
  }

  private async loadIssues(source: JiraSource): Promise<RawJiraIssue[]> {
    if ("json" in source) {
      const raw = await readFile(source.json, "utf-8");
      return extractIssues(JSON.parse(raw));
    }

    if ("url" in source) {
      const response = await fetch(source.url);
      if (!response.ok) {
        throw new Error(`JiraProvider: failed to fetch ${source.url} (${response.status})`);
      }
      return extractIssues(await response.json());
    }

    if ("jql" in source) {
      return extractIssues(await this.searchByJql(source.jql));
    }

    throw new Error("JiraProvider: unrecognized source; expected one of json, url, jql");
  }

  private async searchByJql(jql: string): Promise<unknown> {
    const baseUrl = process.env.JIRA_BASE_URL;
    const email = process.env.JIRA_EMAIL;
    const apiToken = process.env.JIRA_API_TOKEN;
    if (!baseUrl || !email || !apiToken) {
      throw new Error(
        "JiraProvider: --jql requires JIRA_BASE_URL, JIRA_EMAIL, and JIRA_API_TOKEN environment variables",
      );
    }

    const endpoint = new URL("/rest/api/2/search", baseUrl);
    endpoint.searchParams.set("jql", jql);
    const auth = Buffer.from(`${email}:${apiToken}`).toString("base64");

    const response = await fetch(endpoint, {
      headers: { Authorization: `Basic ${auth}`, Accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(`JiraProvider: JQL search failed (${response.status})`);
    }
    return response.json();
  }
}
