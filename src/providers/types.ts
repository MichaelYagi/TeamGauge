import type { Signals } from "../schema/canonical.js";

// A provider computes signals per engineer it can identify in the source
// data. The per-engineer object reuses the same `signals` shape claude.md
// specifies for provider output — that shape is unified whether it describes
// one engineer or a whole team, per the "unified schema" principle.
export interface EngineerSignals {
  name: string;
  role: string;
  signals: Signals;
  resolved_count: number;
  velocity: number;
}

export interface ProviderResult {
  engineers: EngineerSignals[];
  // Present only when every issue in the source unanimously agrees — see
  // src/providers/common/detect.ts. Absent means "don't know," never a guess.
  detected?: { team?: string; sprint?: string };
}

export interface Provider<Source> {
  readonly name: string;
  ingest(source: Source): Promise<ProviderResult>;
}
