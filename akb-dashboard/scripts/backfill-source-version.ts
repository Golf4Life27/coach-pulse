#!/usr/bin/env tsx
// One-time backfill: stamp pre-existing Listings_V1 records with
// Source_Version (INV-LEGACY-BACKSTOP). Records already carrying a
// Source_Version are excluded by the empty filter, so this is safe to run
// after the v2-write deploy and is idempotent — a second run finds nothing.
//
// Default: every empty-Source_Version record → "v1_legacy".
//
// --rescue-after <ISO>: records whose Airtable createdTime >= <ISO> get
//   "v2_post_2026-05-26" instead (rescues records the enrichment-equipped
//   crawler wrote before the Source_Version write shipped); everything older
//   still gets "v1_legacy".
//
// Usage:
//   AIRTABLE_PAT=… npx tsx scripts/backfill-source-version.ts                                  # dry run, all → v1
//   AIRTABLE_PAT=… npx tsx scripts/backfill-source-version.ts --apply                          # write, all → v1
//   AIRTABLE_PAT=… npx tsx scripts/backfill-source-version.ts --rescue-after 2026-05-26T20:13:00Z --apply
//
// Dry run (default) reports the v1/v2 split + a sample and writes nothing.

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

function parseRescueAfter(): number | null {
  const i = process.argv.indexOf("--rescue-after");
  if (i === -1) return null;
  const raw = process.argv[i + 1];
  const ms = raw ? Date.parse(raw) : NaN;
  if (Number.isNaN(ms)) {
    console.error(`--rescue-after needs a valid ISO timestamp (got: ${raw ?? "nothing"}).`);
    process.exit(1);
  }
  return ms;
}

const RESCUE_AFTER_MS = parseRescueAfter();

interface Rec { id: string; address: string; createdMs: number }

/** The version a record should receive: v2 if created at/after the rescue
 *  cutoff, otherwise v1. Without --rescue-after, always v1. */
function targetVersion(r: Rec): string {
  if (RESCUE_AFTER_MS != null && r.createdMs >= RESCUE_AFTER_MS) return SOURCE_VERSION_V2;
  return SOURCE_VERSION_V1_LEGACY;
}

async function fetchUnversioned(): Promise<Rec[]> {
  const out: Rec[] = [];
  let offset: string | undefined;
  do {
    const url = new URL(`https://api.airtable.com/v0/${BASE}/${TABLE}`);
    url.searchParams.set("filterByFormula", `{${SOURCE_VERSION_FIELD_NAME}} = ''`);
    url.searchParams.append("fields[]", "Address");
    url.searchParams.set("pageSize", "100");
    if (offset) url.searchParams.set("offset", offset);
    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${PAT}` } });
    if (!res.ok) throw new Error(`list ${res.status}: ${await res.text().catch(() => "")}`);
    const body = (await res.json()) as {
      records: Array<{ id: string; createdTime: string; fields: Record<string, unknown> }>;
      offset?: string;
    };
    for (const r of body.records) {
      out.push({ id: r.id, address: String(r.fields.Address ?? ""), createdMs: Date.parse(r.createdTime) });
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
  if (RESCUE_AFTER_MS != null) {
    console.log(`[backfill-source-version] rescue cutoff: records createdTime >= ${new Date(RESCUE_AFTER_MS).toISOString()} → ${SOURCE_VERSION_V2}`);
  }
  console.log(`[backfill-source-version] scanning for records with empty ${SOURCE_VERSION_FIELD_NAME}…`);
  const targets = await fetchUnversioned();
  const v2Count = targets.filter((r) => targetVersion(r) === SOURCE_VERSION_V2).length;
  const v1Count = targets.length - v2Count;
  console.log(`[backfill-source-version] found ${targets.length} unversioned — ${v1Count} → ${SOURCE_VERSION_V1_LEGACY}, ${v2Count} → ${SOURCE_VERSION_V2}.`);

  if (targets.length === 0) {
    console.log("[backfill-source-version] nothing to do (idempotent no-op).");
    return;
  }

  if (!APPLY) {
    console.log("[backfill-source-version] DRY RUN — no writes. Sample:");
    for (const r of targets.slice(0, 10)) {
      console.log(`  ${r.id}  ${new Date(r.createdMs).toISOString()}  → ${targetVersion(r)}  ${r.address}`);
    }
    console.log("[backfill-source-version] re-run with --apply to write.");
    return;
  }

  let updated = 0;
  for (let i = 0; i < targets.length; i += BATCH) {
    updated += await patchBatch(targets.slice(i, i + BATCH));
    console.log(`[backfill-source-version] updated ${updated}/${targets.length}…`);
  }
  console.log(`[backfill-source-version] DONE — ${v1Count} ${SOURCE_VERSION_V1_LEGACY}, ${v2Count} ${SOURCE_VERSION_V2}.`);
}

main().catch((err) => {
  console.error("[backfill-source-version] FAILED:", err);
  process.exit(1);
});
