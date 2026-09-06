import type { TeamReport } from "../schema/canonical.js";
import type { ReasoningContext, ReasoningProvider } from "./types.js";

const UNASSIGNED = "Unassigned";
const MENTIONS_UNASSIGNED = /\bunassigned\b/i;

// Prompting alone doesn't reliably stop a model from listing "Unassigned" as
// a redistribution target/source (observed even with an explicit
// instruction) — it's a backlog bucket, not a person, so this is enforced
// deterministically rather than trusted to the model. An exact-string check
// alone isn't enough: when the model also violates the separate "names
// only, no prose" schema rule, "Unassigned" ends up as a word buried inside
// a full sentence (e.g. "assigning Unassigned's items to engineers with
// high load scores") rather than a clean standalone array entry, which an
// exact match silently lets through. Drop the whole entry — not just the
// word — since an entry mentioning it is already schema-noncompliant prose,
// not a salvageable name.
function withoutUnassigned(names: string[]): string[] {
  return names.filter((name) => name !== UNASSIGNED && !MENTIONS_UNASSIGNED.test(name));
}

// Signals/derived_metrics are never touched here — only the recommendation
// fields, which start empty from `analyze` and are the one thing TeamGauge
// itself never computes.
export async function reasonAboutReport(
  report: TeamReport,
  provider: ReasoningProvider,
  ctx?: ReasoningContext,
): Promise<TeamReport> {
  const result = await provider.reason(report, ctx);
  const byName = new Map(result.engineer_recommendations.map((rec) => [rec.name, rec]));

  return {
    ...report,
    engineers: report.engineers.map((engineer) => {
      const rec = byName.get(engineer.name);
      if (!rec || engineer.name === UNASSIGNED) return engineer;
      return {
        ...engineer,
        recommendations: {
          redistribute_to: withoutUnassigned(rec.redistribute_to),
          reduce_scope: rec.reduce_scope,
          notes: rec.notes,
        },
      };
    }),
    team_recommendations: {
      ...result.team_recommendations,
      redistribute_work: withoutUnassigned(result.team_recommendations.redistribute_work),
    },
  };
}
