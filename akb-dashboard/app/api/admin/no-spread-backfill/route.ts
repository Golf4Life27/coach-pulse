// NO-SPREAD BACKFILL — park the records that can never carry an offer, and
// un-park them the moment the seller moves. @agent: appraiser
//
// Intake now refuses to COLLECT a listing asking at or above its own renovated
// value (lib/crawler/intake-filter.askAboveRenovatedValue). This is the other
// half: the records already in Airtable were gathered under the old rules, and
// they still sit in the eligible pool being re-priced every cron cycle. The
// pool reports roughly four times more prospects than it has.
//
// Both directions run every pass, which is what makes the label honest:
//   PARK    ask >= renovated value  -> Outreach_Status = "No Spread"
//   REVIVE  ask <  renovated value  -> clear it, back in the pool
// So a price cut restores a record with no human in the loop. That is the
// whole reason the operator asked for "No Spread" rather than "Dead".
//
// GET /api/admin/no-spread-backfill
//   (default)   DRY RUN — computes and reports, writes NOTHING
//   ?apply=1    write Outreach_Status
//   ?limit=N    cap records examined
//   ?state=XX   scope to one state
//
// Writes use typecast:true so Airtable creates the "No Spread" select choice on
// first use — no manual schema step. Only ever touches Outreach_Status, and
// only when it is empty or already "No Spread" (see WRITABLE_STATUSES): a
// record in a live conversation is never relabelled.

import { NextResponse } from "next/server";
import { audit } from "@/lib/audit-log";
import { classifyNoSpread, NO_SPREAD_STATUS } from "@/lib/pricing/no-spread";
import { listArvPsfByZip } from "@/lib/zip-arv-seed-store";
import {
  authenticate,
  hasDashboardSession,
  readAuthEnv,
  readAuthHeaders,
} from "@/lib/maverick/oauth/auth-waterfall";
import { kvProd, kvConfigured } from "@/lib/maverick/oauth/kv";

export const runtime = "nodejs";
export const maxDuration = 300;

const AIRTABLE_PAT = process.env.AIRTABLE_PAT;
const BASE_ID = process.env.AIRTABLE_BASE_ID || "appp8inLAGTg4qpEZ";
const LISTINGS_TABLE = "tbldMjKBgPiq45Jjs";

const F_ADDR = "fldwvp72hKTfiHHjj";
const F_ZIP = "fld9PTaKkgBNtvWbB";
const F_STATE = "fldSlDQvgCyr0J8tI";
const F_SQFT = "fld5bKGJLlN7GmiE9";
const F_LIST = "fld9J3Vi9fTq3zzMU";
const F_OUTREACH = "fldGIgqwyCJg4uFyv";
const F_LIVE = "fldCKnC1nnXEnTUKL";

interface Row { id: string; fields: Record<string, unknown> }

async function airtableAll(fields: string[], formula?: string): Promise<Row[]> {
  const out: Row[] = [];
  let offset: string | undefined;
  do {
    const p = new URLSearchParams();
    fields.forEach((f) => p.append("fields[]", f));
    p.set("returnFieldsByFieldId", "true");
    p.set("pageSize", "100");
    if (formula) p.set("filterByFormula", formula);
    if (offset) p.set("offset", offset);
    const res = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${LISTINGS_TABLE}?${p}`, {
      headers: { Authorization: `Bearer ${AIRTABLE_PAT}` }, cache: "no-store",
    });
    if (!res.ok) throw new Error(`listings read ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
    const b = (await res.json()) as { records?: Row[]; offset?: string };
    out.push(...(b.records ?? []));
    offset = b.offset;
  } while (offset);
  return out;
}

/** PATCH in Airtable's 10-record batches. Returns per-batch failures verbatim
 *  — a write that fails silently is the defect that hid the sweep bug for two
 *  days (b563550). */
async function patchAll(
  updates: Array<{ id: string; fields: Record<string, unknown> }>,
): Promise<{ written: number; errors: string[] }> {
  let written = 0;
  const errors: string[] = [];
  for (let i = 0; i < updates.length; i += 10) {
    const chunk = updates.slice(i, i + 10);
    try {
      const res = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${LISTINGS_TABLE}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${AIRTABLE_PAT}`, "Content-Type": "application/json" },
        body: JSON.stringify({ records: chunk, typecast: true }),
      });
      const raw = await res.text().catch(() => "");
      if (!res.ok) { errors.push(`${res.status} ${raw.slice(0, 300)}`); continue; }
      written += chunk.length;
    } catch (err) {
      errors.push(err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300));
    }
  }
  return { written, errors };
}

export async function GET(req: Request) {
  const t0 = Date.now();
  if (!AIRTABLE_PAT) return NextResponse.json({ error: "AIRTABLE_PAT not set" }, { status: 500 });

  const cookieHeader = req.headers.get("cookie");
  if (!hasDashboardSession(cookieHeader)) {
    const env = readAuthEnv();
    if (kvConfigured() || env.cronSecret !== null || env.bearerDevToken !== null) {
      const auth = await authenticate(readAuthHeaders(req), env, kvProd);
      if (!auth.ok) return NextResponse.json({ error: "unauthorized", reason: auth.reason }, { status: 401 });
    }
  }

  const url = new URL(req.url);
  const apply = url.searchParams.get("apply") === "1";
  const limitRaw = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : Infinity;
  const stateScope = (url.searchParams.get("state") ?? "").trim().toUpperCase();

  let psfByZip: Map<string, number>;
  let rows: Row[];
  try {
    [psfByZip, rows] = await Promise.all([
      listArvPsfByZip(),
      airtableAll([F_ADDR, F_ZIP, F_STATE, F_SQFT, F_LIST, F_OUTREACH, F_LIVE], `{Live_Status}='Active'`),
    ]);
  } catch (err) {
    return NextResponse.json(
      { error: "read_failed", message: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
  // An empty seed map makes every record unjudgeable, which classifyNoSpread
  // turns into "leave" — but refuse loudly rather than reporting a clean zero.
  if (psfByZip.size === 0) {
    return NextResponse.json({ error: "no_seeds_loaded", note: "refusing to run blind" }, { status: 502 });
  }

  const park: Array<{ id: string; fields: Record<string, unknown> }> = [];
  const revive: Array<{ id: string; fields: Record<string, unknown> }> = [];
  const samplePark: Array<Record<string, unknown>> = [];
  const sampleRevive: Array<Record<string, unknown>> = [];
  const byReason: Record<string, number> = {};
  let examined = 0;

  for (const r of rows) {
    if (examined >= limit) break;
    const f = r.fields;
    const state = typeof f[F_STATE] === "string" ? (f[F_STATE] as string).trim().toUpperCase() : "";
    if (stateScope && state !== stateScope) continue;
    examined++;

    const zip = typeof f[F_ZIP] === "string" ? (f[F_ZIP] as string).trim() : "";
    const statusCell = f[F_OUTREACH];
    const outreachStatus =
      typeof statusCell === "string" ? statusCell
      : statusCell && typeof statusCell === "object" && "name" in (statusCell as object)
        ? String((statusCell as { name: unknown }).name)
        : null;

    const v = classifyNoSpread({
      outreachStatus,
      listPrice: typeof f[F_LIST] === "number" ? (f[F_LIST] as number) : null,
      sqft: typeof f[F_SQFT] === "number" ? (f[F_SQFT] as number) : null,
      seedPsf: psfByZip.get(zip) ?? null,
    });
    byReason[v.action] = (byReason[v.action] ?? 0) + 1;

    const row = {
      address: f[F_ADDR], zip, state,
      list: f[F_LIST], sqft: f[F_SQFT], arv: v.arv, reason: v.reason,
    };
    if (v.action === "park") {
      park.push({ id: r.id, fields: { [F_OUTREACH]: NO_SPREAD_STATUS } });
      if (samplePark.length < 40) samplePark.push(row);
    } else if (v.action === "revive") {
      revive.push({ id: r.id, fields: { [F_OUTREACH]: "" } });
      if (sampleRevive.length < 40) sampleRevive.push(row);
    }
  }

  let writes: { written: number; errors: string[] } = { written: 0, errors: [] };
  if (apply && (park.length || revive.length)) {
    const a = await patchAll(park);
    const b = await patchAll(revive);
    writes = { written: a.written + b.written, errors: [...a.errors, ...b.errors] };
  }

  const summary = {
    mode: apply ? "apply" : "dry_run",
    apply_available: !apply,
    note: apply ? undefined : "No writes. Add ?apply=1 to set Outreach_Status.",
    examined,
    seeded_zips: psfByZip.size,
    would_park: park.length,
    would_revive: revive.length,
    by_action: byReason,
    written: writes.written,
    write_errors: writes.errors,
    sample_park: samplePark,
    sample_revive: sampleRevive,
    ms: Date.now() - t0,
  };

  await audit({
    agent: "appraiser",
    event: "no_spread_backfill",
    status: writes.errors.length ? "uncertain" : "confirmed_success",
    inputSummary: { apply, limit: Number.isFinite(limit) ? limit : null, state: stateScope || null },
    outputSummary: { ...summary, sample_park: samplePark.length, sample_revive: sampleRevive.length },
    decision: `${park.length} park, ${revive.length} revive, ${writes.written} written`,
  });

  return NextResponse.json(summary);
}
