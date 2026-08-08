// BLANK-STATUS REPAIR — clear the Outreach_Status choice whose NAME is the
// empty string. @agent: scout
//
// THE DEFECT (found 2026-08-07 while dumping the ZIP registry). Something
// wrote "" to the Outreach_Status singleSelect with typecast:true, and
// Airtable minted a choice whose NAME is the empty string (sel D1RtCO33pmQKqw).
// 251 Ohio Active records carried it at discovery. It is the worst possible
// state because the two readers DISAGREE, permanently:
//   Airtable   isEmpty() reports the field SET → every filterByFormula audit
//              SKIPS these records (the "903 eligible" census missed all 251).
//   The app    outreachStatusEmpty() reads the blank NAME as unset → outreach
//              treats them as never-contacted and ELIGIBLE.
// So the pool is bigger than any audit says, and a record that WAS contacted
// and later blanked would read as never-contacted to the send path.
//
// The WRITER was fixed on 2026-08-08 (no-spread revive now writes null, and
// 1f6ff50 documents the trap); this route repairs the EXISTING rows.
//
// DETECTION cannot use filterByFormula — Airtable's formula layer renders both
// "unset" and "set to the blank choice" as "". The REST read distinguishes
// them: an unset field is OMITTED from `fields`, while the blank choice comes
// back as an empty-string value. We read all Active rows and repair exactly
// the present-but-blank ones.
//
// GET /api/admin/blank-status-repair
//   (default)  DRY RUN — counts + samples, writes NOTHING
//   ?apply=1   PATCH Outreach_Status to null (truly unset)
//
// Writing null clears the cell outright — the same rule the no-spread route
// now follows: a singleSelect is cleared with null, never "".

import { NextResponse } from "next/server";
import { audit } from "@/lib/audit-log";
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
const F_STATE = "fldSlDQvgCyr0J8tI";
const F_OUTREACH = "fldGIgqwyCJg4uFyv";

interface Row { id: string; fields: Record<string, unknown> }

async function readAllActive(): Promise<Row[]> {
  const out: Row[] = [];
  let offset: string | undefined;
  do {
    const p = new URLSearchParams();
    [F_ADDR, F_STATE, F_OUTREACH].forEach((f) => p.append("fields[]", f));
    p.set("returnFieldsByFieldId", "true");
    p.set("pageSize", "100");
    p.set("filterByFormula", `{Live_Status}='Active'`);
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

/** The discriminator: field PRESENT in the payload but rendering as the empty
 *  string (or an object whose name is ""). Unset fields are simply omitted. */
function hasBlankChoice(fields: Record<string, unknown>): boolean {
  if (!(F_OUTREACH in fields)) return false;
  const v = fields[F_OUTREACH];
  if (v === "") return true;
  if (v && typeof v === "object" && "name" in (v as object)) {
    return String((v as { name: unknown }).name).trim() === "";
  }
  return typeof v === "string" && v.trim() === "";
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

  const apply = new URL(req.url).searchParams.get("apply") === "1";

  let rows: Row[];
  try {
    rows = await readAllActive();
  } catch (err) {
    return NextResponse.json(
      { error: "read_failed", message: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }

  const blank = rows.filter((r) => hasBlankChoice(r.fields));
  const byState: Record<string, number> = {};
  for (const r of blank) {
    const st = typeof r.fields[F_STATE] === "string" ? (r.fields[F_STATE] as string) : "?";
    byState[st] = (byState[st] ?? 0) + 1;
  }

  let written = 0;
  const errors: string[] = [];
  if (apply && blank.length) {
    for (let i = 0; i < blank.length; i += 10) {
      const chunk = blank.slice(i, i + 10).map((r) => ({ id: r.id, fields: { [F_OUTREACH]: null } }));
      try {
        const res = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${LISTINGS_TABLE}`, {
          method: "PATCH",
          headers: { Authorization: `Bearer ${AIRTABLE_PAT}`, "Content-Type": "application/json" },
          body: JSON.stringify({ records: chunk }),
        });
        const raw = await res.text().catch(() => "");
        // Failures verbatim — a silent write failure is the sweep bug (b563550).
        if (!res.ok) { errors.push(`${res.status} ${raw.slice(0, 300)}`); continue; }
        written += chunk.length;
      } catch (err) {
        errors.push(err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300));
      }
    }
  }

  const summary = {
    mode: apply ? "apply" : "dry_run",
    note: apply ? undefined : "No writes. Add ?apply=1 to clear the blank choices to truly-unset.",
    active_scanned: rows.length,
    blank_choice_found: blank.length,
    by_state: byState,
    written,
    write_errors: errors,
    sample: blank.slice(0, 40).map((r) => ({ address: r.fields[F_ADDR], state: r.fields[F_STATE] })),
    ms: Date.now() - t0,
  };

  await audit({
    agent: "scout",
    event: "blank_status_repair",
    status: errors.length ? "uncertain" : "confirmed_success",
    inputSummary: { apply },
    outputSummary: { ...summary, sample: undefined },
    decision: `${blank.length} blank-choice rows, ${written} cleared`,
  });

  return NextResponse.json(summary);
}
