#!/usr/bin/env tsx
// One-time backfill: stamp pre-existing Listings_V1 records with
// Source_Version (INV-LEGACY-BACKSTOP). Records already carrying a
// Source_Version are excluded by the empty filter, so this is safe to run
// after the v2-write deploy and is idempotent — a second run finds nothing.
//
// Default: every empty-Source_Version record -> "v1_legacy".
//
// Rescue modes (a record matching ANY rescue rule -> "v2_post_2026-05-26"):
//
//   --rescue-after <ISO>
//       createdTime >= <ISO>  (rescues records the enrichment-equipped
//       crawler wrote before the Source_Version write shipped).
//
//   --rescue-active-outreach [<ISO>]
//       Outreach_Status in {Negotiating, Response Received, Offer Accepted}
//       (rescued unconditionally — live deals), OR Outreach_Status="Texted"
//       with Last_Outreach_Date >= the recency cutoff. The cutoff is this
//       flag's own <ISO> arg if given, else --rescue-after's value; if
//       neither is set, Texted records are NOT rescued (only the three
//       active-conversation statuses are).
//
// The two modes are combinable. Dry run (default) reports the split by
// category — newly-crawled / active-outreach / older-legacy — and writes
// nothing. Pass --apply to perform the batched updates (10 per PATCH).
//
// Usage:
//   AIRTABLE_PAT=… npx tsx scripts/backfill-source-version.ts
//   AIRTABLE_PAT=… npx tsx scripts/backfill-source-version.ts --rescue-after 2026-05-26T20:13:00Z --rescue-active-outreach 2026-05-01T00:00:00Z --apply

import {
  SOURCE_VERSION_FIELD_NAME,
  SOURCE_VERSION_V1_LEGACY,
  SOURCE_VERSION_V2,
} from "../lib/source-version";

const PAT = process.env.AIRTABLE_PAT;
const BASE = process.env.AIRTABLE_BASE_ID || "appp8inLAGTg4qpEZ";
const TABLE = "tbldMjKBgPiq45Jjs";
const APPLY = process.argv.includes("--apply");
const BATCH = 10;

// Outreach_Status values that signal a live deal — rescued regardless of date.
const ACTIVE_STATUSES = new Set(["Negotiating", "Response Received", "Offer Accepted"]);

/** Parse the optional ISO value following a flag. Returns:
 *  - undefined: flag absent
 *  - null: flag present with no/invalid value
 *  - number: parsed epoch ms */
function parseFlagDate(flag: string): number | null | undefined {
  const i = process.argv.indexOf(flag);
  if (i === -1) return undefined;
  const raw = process.argv[i + 1];
  if (!raw || raw.startsWith("--")) return null;
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) {
    console.error(`${flag} got an invalid ISO timestamp: ${raw}`);
    process.exit(1);
  }
  return ms;
}

const RESCUE_AFTER_MS = parseFlagDate("--rescue-after") ?? null;
const ACTIVE_FLAG = parseFlagDate("--rescue-active-outreach"); // undefined = off
const ACTIVE_ENABLED = ACTIVE_FLAG !== undefined;
// Texted recency threshold: this flag's own value, else --rescue-after's.
const TEXTED_SINCE_MS = (typeof ACTIVE_FLAG === "number" ? ACTIVE_FLAG : null) ?? RESCUE_AFTER_MS;

type Category = "newly-crawled" | "active-outreach" | "older-legacy";

interface Rec {
  id: string;
  address: string;
  createdMs: number;
  outreachStatus: string;
  lastOutreachMs: number | null;
}

/** Exactly one category per record. active-outreach takes priority (it's the
 *  "live deal" signal), then newly-crawled, else older-legacy. */
function categorize(r: Rec): Category {
  if (ACTIVE_ENABLED) {
    if (ACTIVE_STATUSES.has(r.outreachStatus)) return "active-outreach";
    if (
      r.outreachStatus === "Texted" &&
      TEXTED_SINCE_MS != null &&
      r.lastOutreachMs != null &&
      r.lastOutreachMs >= TEXTED_SINCE_MS
    ) {
      return "active-outreach";
    }
  }
  if (RESCUE_AFTER_MS != null && r.createdMs >= RESCUE_AFTER_MS) return "newly-crawled";
  return "older-legacy";
}

function targetVersion(r: Rec): string {
  return categorize(r) === "older-legacy" ? SOURCE_VERSION_V1_LEGACY : SOURCE_VERSION_V2;
}

async function fetchUnversioned(): Promise<Rec[]> {
  const out: Rec[] = [];
  let offset: string | undefined;
  do {
    const url = new URL(`https://api.airtable.com/v0/${BASE}/${TABLE}`);
    url.searchParams.set("filterByFormula", `{${SOURCE_VERSION_FIELD_NAME}} = ''`);
    for (const f of ["Address", "Outreach_Status", "Last_Outreach_Date"]) url.searchParams.append("fields[]", f);
    url.searchParams.set("pageSize", "100");
    if (offset) url.searchParams.set("offset", offset);
    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${PAT}` } });
    if (!res.ok) throw new Error(`list ${res.status}: ${await res.text().catch(() => "")}`);
    const body = (await res.json()) as {
      records: Array<{ id: string; createdTime: string; fields: Record<string, unknown> }>;
      offset?: string;
    };
    for (const r of body.records) {
      const lod = r.fields.Last_Outreach_Date;
      out.push({
        id: r.id,
        address: String(r.fields.Address ?? ""),
        createdMs: Date.parse(r.createdTime),
        outreachStatus: String(r.fields.Outreach_Status ?? ""),
        lastOutreachMs: typeof lod === "string" && lod ? Date.parse(lod) : null,
      });
    }
    offset = body.offset;
  } while (offset);
  return out;
}

async function patchBatch(recs: Rec[]): Promise<number> {
  const res = await fetch(`https://api.airtable.com/v0/${BASE}/${TABLE}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${PAT}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      records: recs.map((r) => ({ id: r.id, fields: { [SOURCE_VERSION_FIELD_NAME]: targetVersion(r) } })),
      typecast: true,
    }),
  });
  if (!res.ok) throw new Error(`patch ${res.status}: ${await res.text().catch(() => "")}`);
  const body = (await res.json()) as { records?: unknown[] };
  return body.records?.length ?? 0;
}

async function main() {
  if (!PAT) {
    console.error("AIRTABLE_PAT not set — aborting.");
    process.exit(1);
  }
  if (RESCUE_AFTER_MS != null) console.log(`[backfill] --rescue-after: createdTime >= ${new Date(RESCUE_AFTER_MS).toISOString()} -> ${SOURCE_VERSION_V2}`);
  if (ACTIVE_ENABLED) {
    console.log(`[backfill] --rescue-active-outreach: {${[...ACTIVE_STATUSES].join(", ")}} always; Texted with Last_Outreach_Date >= ${TEXTED_SINCE_MS != null ? new Date(TEXTED_SINCE_MS).toISOString() : "(no cutoff — Texted NOT rescued)"}`);
  }
  console.log(`[backfill] scanning for records with empty ${SOURCE_VERSION_FIELD_NAME}…`);
  const targets = await fetchUnversioned();

  const counts: Record<Category, number> = { "newly-crawled": 0, "active-outreach": 0, "older-legacy": 0 };
  for (const r of targets) counts[categorize(r)]++;
  console.log(`[backfill] found ${targets.length} unversioned:`);
  console.log(`           active-outreach -> v2 : ${counts["active-outreach"]}`);
  console.log(`           newly-crawled   -> v2 : ${counts["newly-crawled"]}`);
  console.log(`           older-legacy    -> v1 : ${counts["older-legacy"]}`);

  if (targets.length === 0) {
    console.log("[backfill] nothing to do (idempotent no-op).");
    return;
  }

  if (!APPLY) {
    console.log("[backfill] DRY RUN — no writes. Sample:");
    for (const r of targets.slice(0, 12)) {
      console.log(`  ${r.id}  ${categorize(r).padEnd(15)} ${targetVersion(r).padEnd(18)} status='${r.outreachStatus}'  ${r.address}`);
    }
    console.log("[backfill] re-run with --apply to write.");
    return;
  }

  let updated = 0;
  for (let i = 0; i < targets.length; i += BATCH) {
    updated += await patchBatch(targets.slice(i, i + BATCH));
    console.log(`[backfill] updated ${updated}/${targets.length}…`);
  }
  console.log(`[backfill] DONE — v2: ${counts["active-outreach"] + counts["newly-crawled"]}, v1: ${counts["older-legacy"]}.`);
}

main().catch((err) => {
  console.error("[backfill] FAILED:", err);
  process.exit(1);
});
