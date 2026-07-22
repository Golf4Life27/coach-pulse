// Frontier auto-stage (chew-and-move-on, operator /goal 2026-07-22).
// @agent: scout
//
// THE GAP THIS CLOSES: the weekly frontier pass (#37) could PROMOTE
// staged→launch within budget capacity, but nothing ever CREATED staged
// rows — the registry sat frozen at the same ~88 ZIPs / 9 metros while
// the promotion queue ran empty. The crawler "tiptoed around the same
// few metros" because there was structurally nowhere else to go.
//
// THE FIX: a curated expansion queue (lib/config/expansion-metros.json —
// disclosure-state, non-restricted, high-distress metros, operator-
// editable) feeds tier=staged rows in CONFIG ORDER: the first metro's
// ZIPs stage fully before the next metro opens, so the belt chews
// through one fresh metro at a time instead of dribbling everywhere.
// Staged rows spend NOTHING (intake targets launch/active only); the
// budget governor still decides how many promote per week.
//
// RAILS (enforced here in code, not just documented in the config):
//   - restricted states (IL/MO/SC/NC/OK/ND) never stage;
//   - non-disclosure states (TX/KS/MS/LA/...) never stage — the opener
//     HOLDs there, so staging them would burn crawl budget on markets
//     that cannot send (the existing TX cluster is the cautionary tale);
//   - a ZIP already in ZIP_Registry (ANY tier) never re-stages;
//   - per-pass hard bound + a target backlog so the staged queue stays
//     a runway, not a flood.
//
// The decision is PURE; the frontier-rotation route does the I/O.

import expansionConfig from "@/lib/config/expansion-metros.json";

export interface ExpansionMetro {
  id: string;
  label: string;
  state: string;
  market: string;
  zips: string[];
}

/** The configured expansion queue, in priority order. */
export function listExpansionMetros(): ExpansionMetro[] {
  const metros = (expansionConfig as { metros?: unknown }).metros;
  if (!Array.isArray(metros)) return [];
  return metros.filter(
    (m): m is ExpansionMetro =>
      !!m &&
      typeof (m as ExpansionMetro).id === "string" &&
      typeof (m as ExpansionMetro).state === "string" &&
      typeof (m as ExpansionMetro).market === "string" &&
      Array.isArray((m as ExpansionMetro).zips),
  );
}

/** How many staged rows the pass tries to keep queued ahead of promotion.
 *  2× the current promotion capacity (next week's seats are already cut
 *  when this week's promote), floored so a zero-capacity week still keeps
 *  a small runway warm. */
export function targetStagedBacklog(capacityLeft: number, floor = 12): number {
  return Math.max(floor, capacityLeft * 2);
}

export interface StageSkipCounts {
  already_in_registry: number;
  restricted_state: number;
  non_disclosure_state: number;
  malformed_zip: number;
}

export interface StagingDecision {
  toStage: Array<{ zip: string; state: string; market: string; note: string }>;
  skipped: StageSkipCounts;
  /** Metro ids that contributed at least one staged ZIP this pass. */
  metrosOpened: string[];
  /** True when the whole expansion queue is exhausted (operator should
   *  append metros to expansion-metros.json). */
  queueExhausted: boolean;
}

/** Pure: which ZIPs to stage this pass. Walks metros in config order and
 *  stages each metro's remaining ZIPs before touching the next metro —
 *  the chew-through-then-move-on shape — until the staged backlog reaches
 *  target or the per-pass bound is hit. */
export function decideStaging(input: {
  /** Every ZIP already in ZIP_Registry, any tier. */
  existingZips: ReadonlySet<string>;
  restrictedStates: ReadonlySet<string>;
  nonDisclosureStates: ReadonlySet<string>;
  /** Current count of tier=staged rows. */
  stagedBacklog: number;
  /** Keep this many staged rows queued (targetStagedBacklog). */
  targetBacklog: number;
  /** Hard bound on new rows per pass. */
  maxPerPass: number;
  metros?: ExpansionMetro[];
}): StagingDecision {
  const metros = input.metros ?? listExpansionMetros();
  const skipped: StageSkipCounts = {
    already_in_registry: 0,
    restricted_state: 0,
    non_disclosure_state: 0,
    malformed_zip: 0,
  };
  const toStage: StagingDecision["toStage"] = [];
  const metrosOpened: string[] = [];
  const want = Math.min(
    Math.max(0, input.targetBacklog - input.stagedBacklog),
    Math.max(0, input.maxPerPass),
  );

  let anyRemaining = false;
  for (const metro of metros) {
    const st = metro.state.trim().toUpperCase();
    let openedThisMetro = false;
    for (const rawZip of metro.zips) {
      const zip = String(rawZip).trim();
      if (!/^\d{5}$/.test(zip)) {
        skipped.malformed_zip++;
        continue;
      }
      if (input.existingZips.has(zip) || toStage.some((s) => s.zip === zip)) {
        skipped.already_in_registry++;
        continue;
      }
      if (input.restrictedStates.has(st)) {
        skipped.restricted_state++;
        continue;
      }
      if (input.nonDisclosureStates.has(st)) {
        skipped.non_disclosure_state++;
        continue;
      }
      if (toStage.length >= want) {
        anyRemaining = true;
        continue;
      }
      toStage.push({
        zip,
        state: st,
        market: metro.market,
        note: `frontier auto-stage: ${metro.label} (${metro.id}) — expansion queue, chew-and-move-on`,
      });
      openedThisMetro = true;
    }
    if (openedThisMetro) metrosOpened.push(metro.id);
  }

  return {
    toStage,
    skipped,
    metrosOpened,
    queueExhausted: !anyRemaining && toStage.length === 0 && want > 0,
  };
}
