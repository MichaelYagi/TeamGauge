import { ask, askYesNo } from "./prompt.js";
import { createOrUpdateTeam, addRosterEntry, getTeam } from "../db/teamProfile.js";
import { localToday as today } from "../util/date.js";

// Interactive questionnaire — a one-time (or edit-anytime) setup step so
// team makeup, sprint length, and responsibilities don't have to be
// retyped/re-explained on every `analyze`/`reason` call. Everything
// collected here is a fact the user states, never inferred by TeamGauge.
export async function runSetup(dbPath?: string): Promise<void> {
  const existing = await ask("Team name (new or existing)");
  if (!existing) {
    process.stderr.write("teamgauge setup: a team name is required\n");
    process.exitCode = 1;
    return;
  }

  const existingProfile = getTeam(existing, dbPath);
  if (existingProfile) {
    process.stdout.write(`Found existing profile for "${existing}" — updating it.\n`);
  }

  const sprintLengthRaw = await ask(
    "Sprint length in days (e.g. 10 for a 2-week sprint)",
    existingProfile?.sprint_length_days ? String(existingProfile.sprint_length_days) : "10",
  );
  const sprintLengthDays = Number(sprintLengthRaw) || null;

  const charter = await ask(
    "What is this team responsible for? (a sentence or two — helps the reasoning step judge what's normal for this team)",
    existingProfile?.charter ?? "",
  );

  createOrUpdateTeam({ name: existing, sprint_length_days: sprintLengthDays, charter: charter || null }, dbPath);
  process.stdout.write(`Saved team profile for "${existing}".\n\n`);

  process.stdout.write("Now let's record the team's makeup. Enter each person; leave the name blank to finish.\n");
  const effectiveFrom = today();
  for (;;) {
    const name = await ask("Engineer name (as it appears in Jira, e.g. jason.choi)");
    if (!name) break;

    const role = await ask("Role (free text — e.g. SDET, Lead Engineer, PM)");
    const weightRaw = await ask("Load weight (1 = no adjustment; leave blank for 1)", "1");
    const weight = Number(weightRaw) || 1;
    const notes = await ask(
      "Any work-pattern fact worth knowing? (e.g. \"tests in the back half of the sprint\" — leave blank if none)",
    );

    addRosterEntry(existing, { engineer_name: name, role, weight, notes: notes || undefined, effective_from: effectiveFrom }, dbPath);
    process.stdout.write(`  added ${name} (${role || "role unknown"})\n`);

    const more = await askYesNo("Add another person?", true);
    if (!more) break;
  }

  process.stdout.write(`\nSetup complete for "${existing}". Use --team "${existing}" with \`analyze\` and \`reason\` from now on.\n`);
}
