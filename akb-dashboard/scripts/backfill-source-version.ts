#!/usr/bin/env tsx
// One-time backfill: stamp every pre-existing Listings_V1 record with
// Source_Version="v1_legacy" (INV-LEGACY-BACKSTOP). Records the crawler has
// already written as v2 are excluded by the empty-Source_Version filter, so
// this is safe to run after the v2-write deploy and is idempotent — a second
// run finds nothing.
//
// Usage:
//   AIRTABLE_PAT=… npx tsx scripts/backfill-source-version.ts          # dry run
//   AIRTABLE_PAT=… npx tsx scripts/backfill-source-version.ts --apply  # write
//
// Dry run (default) reports the count + a sample and writes nothing. Pass
// --apply to perform the batched updates (10 per PATCH, Airtable's cap).

import {
  SOURCE_VERSION_FIELD_NAME,
  SOURCE_VERSION_V1_LEGACY,
} from "../lib/source-version";

const PAT = process.env.AIRTABLE_PAT;
const BASE = process.env.AIRTABLE_BASE_ID || "appp8inLAGTg4qpEZ";
const TABLE = "tbldMjKBgPiq45Jjs";
const APPLY = process.argv.includes("--apply");
const BATCH = 10;

interface Rec { id: string; address: string }

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
    const body = (await res.json()) as { records: Array<{ id: string; fields: Record<string, unknown> }>; offset?: string };
    for (const r of body.records) out.push({ id: r.id, address: String(r.fields.Address ?? "") });
    offset = body.offset;
  } while (offset);
  return out;
}

async function patchBatch(ids: string[]): Promise<number> {
  const res = await fetch(`https://api.airtable.com/v0/${BASE}/${TABLE}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${PAT}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      records: ids.map((id) => ({ id, fields: { [SOURCE_VERSION_FIELD_NAME]: SOURCE_VERSION_V1_LEGACY } })),
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
  console.log(`[backfill-source-version] scanning for records with empty ${SOURCE_VERSION_FIELD_NAME}…`);
  const targets = await fetchUnversioned();
  console.log(`[backfill-source-version] found ${targets.length} unversioned record(s).`);

  if (targets.length === 0) {
    console.log("[backfill-source-version] nothing to do (idempotent no-op).");
    return;
  }

  if (!APPLY) {
    console.log("[backfill-source-version] DRY RUN — no writes. Sample:");
    for (const r of targets.slice(0, 10)) console.log(`  ${r.id}  ${r.address}`);
    console.log(`[backfill-source-version] re-run with --apply to set ${SOURCE_VERSION_FIELD_NAME}="${SOURCE_VERSION_V1_LEGACY}" on all ${targets.length}.`);
    return;
  }

  let updated = 0;
  for (let i = 0; i < targets.length; i += BATCH) {
    const ids = targets.slice(i, i + BATCH).map((r) => r.id);
    updated += await patchBatch(ids);
    console.log(`[backfill-source-version] updated ${updated}/${targets.length}…`);
  }
  console.log(`[backfill-source-version] DONE — set ${SOURCE_VERSION_V1_LEGACY} on ${updated} record(s).`);
}

main().catch((err) => {
  console.error("[backfill-source-version] FAILED:", err);
  process.exit(1);
});
