// Deal-docs ingestion lane — drop an InvestorBase CSV or PropStream CMA
// PDF on the deal page; the system does the reading. @agent: appraiser
//
// POST /api/deal-docs/<recordId>  (multipart form, field "file")
//
// Credential-free tier of the automation ladder (operator GO 2026-07-20):
// the operator keeps the 3-minute manual export (ToS-clean, no stored
// portal passwords); everything after the drop is automated:
//   CSV → per-track (flipper/landlord) as-is acquisition evidence. The
//         medians are DISPLAYED with one-tap stamp buttons that write
//         through the EXISTING validated γ-path — the 2026-06-08 hard rule
//         (InvestorBase exports, operator-entered, export-date provenance)
//         stays intact; we automate the arithmetic, not the ruling.
//   PDF → the CMA summary numbers (comp avg, est value, seller's open
//         mortgage, last sale). Owner + first-mortgage evidence hydrates
//         Property_Intel (non-select fields only — the Conveyor 422 lesson);
//         the full extract stashes in KV for the dossier flow.
// Both drops append a provenance note to the listing ledger.

import { NextResponse } from "next/server";
import { getListing, updateListingRecord } from "@/lib/airtable";
import { upsertPropertyIntel } from "@/lib/federation/property-intel-store";
import {
  looksLikeInvestorBaseCsv,
  parseInvestorBaseCsv,
} from "@/lib/deal-docs/investorbase-csv";
import { looksLikeCmaPdf, parseCmaText } from "@/lib/deal-docs/cma-pdf";
import { audit } from "@/lib/audit-log";
import {
  authenticate,
  hasDashboardSession,
  readAuthEnv,
  readAuthHeaders,
} from "@/lib/maverick/oauth/auth-waterfall";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";

export const runtime = "nodejs";
export const maxDuration = 60;

const NOTES_FIELD = "fldwKGxZly6O8qyPu";
const CMA_KV_TTL_S = 30 * 24 * 3600;

async function appendNote(recordId: string, note: string): Promise<void> {
  const listing = await getListing(recordId);
  const existing = listing?.notes ?? "";
  const full = existing ? `${existing}\n\n${note}` : note;
  await updateListingRecord(recordId, { [NOTES_FIELD]: full });
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ recordId: string }> },
) {
  const { recordId } = await params;
  if (!recordId || !recordId.startsWith("rec")) {
    return NextResponse.json({ error: "invalid_record_id" }, { status: 400 });
  }

  const cookieHeader = req.headers.get("cookie");
  if (!hasDashboardSession(cookieHeader)) {
    const env = readAuthEnv();
    const headers = readAuthHeaders(req);
    const authRequired = kvConfigured() || env.cronSecret !== null || env.bearerDevToken !== null;
    if (authRequired) {
      const auth = await authenticate(headers, env, kvProd);
      if (!auth.ok) {
        return NextResponse.json({ error: "unauthorized", reason: auth.reason }, { status: 401 });
      }
    }
  }

  let file: File | null = null;
  try {
    const form = await req.formData();
    const f = form.get("file");
    if (f instanceof File) file = f;
  } catch {
    return NextResponse.json({ error: "expected_multipart_form" }, { status: 400 });
  }
  if (!file) return NextResponse.json({ error: "no_file" }, { status: 400 });

  const listing = await getListing(recordId);
  if (!listing) return NextResponse.json({ error: "listing_not_found" }, { status: 404 });

  const name = file.name.toLowerCase();
  const nowIso = new Date().toISOString();

  try {
    // ── InvestorBase CSV ────────────────────────────────────────────────
    if (name.endsWith(".csv")) {
      const text = await file.text();
      const headerLine = text.split("\n", 1)[0] ?? "";
      if (!looksLikeInvestorBaseCsv(headerLine)) {
        return NextResponse.json({ error: "not_an_investorbase_export", detail: "header mismatch" }, { status: 422 });
      }
      const parsed = parseInvestorBaseCsv(text, Date.now());
      await appendNote(
        recordId,
        `[deal-docs ${nowIso}] InvestorBase export ingested (${file.name}): ${parsed.totalRows} buyers ` +
          `(${parsed.flipperCount} flipper / ${parsed.landlordCount} landlord). As-is acquisition evidence (18mo, $10k-$250k): ` +
          parsed.evidence
            .map((e) => `${e.track} median ${e.median != null ? `$${e.median.toLocaleString()}` : "—"} (n=${e.n})`)
            .join("; ") +
          ". Medians await operator stamp via the buyer-median panel.",
      );
      await audit({
        agent: "appraiser",
        event: "deal_doc_ingested",
        status: "confirmed_success",
        recordId,
        inputSummary: { kind: "investorbase_csv", file: file.name, rows: parsed.totalRows },
        outputSummary: {
          evidence: Object.fromEntries(parsed.evidence.map((e) => [e.track, { median: e.median, n: e.n }])),
        },
      });
      // Buyers returned for display; table import is a follow-up lane.
      return NextResponse.json({ kind: "investorbase_csv", ...parsed, buyers: parsed.buyers.slice(0, 50) });
    }

    // ── PropStream CMA PDF ──────────────────────────────────────────────
    if (name.endsWith(".pdf")) {
      const buf = Buffer.from(await file.arrayBuffer());
      // Direct lib import — the package root runs a debug self-test when
      // imported outside its own repo (known pdf-parse quirk).
      const { default: pdfParse } = await import("pdf-parse/lib/pdf-parse.js");
      const { text } = await pdfParse(buf);
      if (!looksLikeCmaPdf(text)) {
        return NextResponse.json({ error: "not_a_cma_pdf", detail: "no 'Comparative Market Analysis' header" }, { status: 422 });
      }
      const extract = parseCmaText(text);

      // Hydrate Property_Intel with the ownership/lien evidence (non-select
      // fields only). Best-effort: a hydration failure must not lose the
      // parse — the extract still returns and the note still lands.
      let intelWritten = false;
      try {
        const fields: Record<string, unknown> = { Owner_FetchedAt: nowIso };
        if (extract.ownerName) fields["Owner_Of_Record"] = extract.ownerName;
        if (extract.mortgageBalance != null) fields["First_Mortgage_Amount"] = extract.mortgageBalance;
        if (extract.ownerName || extract.mortgageBalance != null) {
          await upsertPropertyIntel(recordId, listing.address ?? "", fields);
          intelWritten = true;
        }
      } catch {
        intelWritten = false;
      }

      if (kvConfigured()) {
        try {
          await kvProd.setEx(`cma-capture:${recordId}`, JSON.stringify({ ...extract, file: file.name, capturedAt: nowIso }), CMA_KV_TTL_S);
        } catch {
          /* best-effort stash */
        }
      }

      await appendNote(
        recordId,
        `[deal-docs ${nowIso}] PropStream CMA ingested (${file.name}): comp avg ` +
          `${extract.avgSalePrice != null ? `$${extract.avgSalePrice.toLocaleString()}` : "—"} (${extract.compCount ?? "—"} comps), ` +
          `est value ${extract.estimatedValue != null ? `$${extract.estimatedValue.toLocaleString()}` : "—"}, ` +
          `owner ${extract.ownerName ?? "—"}, open mortgage ${extract.mortgageBalance != null ? `$${extract.mortgageBalance.toLocaleString()}` : "—"}, ` +
          `last sale ${extract.lastSalePrice != null ? `$${extract.lastSalePrice.toLocaleString()}` : "—"}${extract.lastSaleDate ? ` on ${extract.lastSaleDate}` : ""}.`,
      );
      await audit({
        agent: "appraiser",
        event: "deal_doc_ingested",
        status: "confirmed_success",
        recordId,
        inputSummary: { kind: "cma_pdf", file: file.name },
        outputSummary: { extracted: extract.extracted, intel_hydrated: intelWritten },
      });
      return NextResponse.json({ kind: "cma_pdf", extract, intelWritten });
    }

    return NextResponse.json({ error: "unsupported_file_type", detail: "drop a .csv (InvestorBase) or .pdf (CMA)" }, { status: 422 });
  } catch (err) {
    await audit({
      agent: "appraiser",
      event: "deal_doc_ingested",
      status: "confirmed_failure",
      recordId,
      inputSummary: { file: file.name },
      error: String(err).slice(0, 200),
    });
    return NextResponse.json({ error: "ingest_failed", detail: String(err).slice(0, 300) }, { status: 500 });
  }
}
