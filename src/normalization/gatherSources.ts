import type { TeamSources } from "../schema/config.js";
import type { ProviderResult } from "../providers/types.js";
import { JiraProvider } from "../providers/jira/JiraProvider.js";
import { CSVProvider } from "../providers/csv/CSVProvider.js";

const UNIMPLEMENTED: Array<keyof TeamSources> = ["github", "url", "manual"];

export async function gatherProviderResults(sources: TeamSources): Promise<ProviderResult[]> {
  const results: ProviderResult[] = [];

  if (sources.jira) {
    results.push(await new JiraProvider().ingest(sources.jira));
  }

  if (sources.csv) {
    results.push(await new CSVProvider().ingest(sources.csv));
  }

  for (const key of UNIMPLEMENTED) {
    if (sources[key] !== undefined) {
      throw new Error(`${key} source is not implemented yet (only "jira" is currently supported)`);
    }
  }

  if (results.length === 0) {
    throw new Error("no sources configured for team; at least one provider source is required");
  }

  return results;
}
