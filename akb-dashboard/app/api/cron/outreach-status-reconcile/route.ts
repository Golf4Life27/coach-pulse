// Phase 11.5 (INV-006) — Outreach_Status auto-transition cron reconciler.
// @agent: crier
//
// GET /api/cron/outreach-status-reconcile
//
// Daily 14:00 UTC slot (vercel.json). Scans Listings_V1 for records
// where Envelope_ID is populated AND Outreach_Status ∈ {Negotiating,
// Response Received} AND the Notes idempotency marker is absent.
// Transitions matching records to Outreach_Status = "Offer Accepted",
// appends Notes audit line, writes Spine + audit log entry.
//
// Pair-with: INV-004 (Spine rec0A9ZWSMMT5Nk9a). INV-004 added a
// runtime guard so Crier silence signals are suppressed when
// Envelope_ID is set. INV-006 is the cure — transitions the status
// field itself so consumers see correct state. INV-004's guard stays
// in place as belt-and-suspenders for the reconciliation window
// (records get caught within 24h of envelope creation).
//
// Today's behavior: zero records have Envelope_ID populated table-wide
// (Phase 12.7 DocuSign provisioning is operator-external STOP).
// Reconciler runs as a no-op until the first envelope is tracked.
// Preventive infrastructure pattern matching INV-004.
//
// Phase 12.7 sequel (documented in AKB_Belt_v1_Spec.md §6): when the
// DocuSign envelope-create route lands, it will also write Outreach_Status
// inline at envelope creation time. This cron stays as the reconciler
// safety-net catching envelopes created via direct DocuSign UI.

import { NextResponse } from "next/server";
import { getListings, updateListingRecord } from "@/lib/airtable";
import { audit } from "@/lib/audit-log";
import { writeState } from "@/lib/maverick/write-state";
import {
  authenticate,
  hasDashboardSession,
  readAuthEnv,
  readAuthHeaders,
} from "@/lib/maverick/oauth/auth-waterfall";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";
import {
  shouldAutoTransition,
  buildAuditNoteLine,
} from "@/lib/maverick/outreach-status-reconcile";

export const runtime = "nodejs";
export const maxDuration = 60;

// Field IDs (mirrors lib/airtable.ts).
const FIELD = {
  outreachStatus: "fldGIgqwyCJg4uFyv",
  notes: "fldwKGxZly6O8qyPu",
} as const;

interface ReconcileSummary {
  scanned: number;
  transitioned: number;
  skipped_no_envelope: number;
  skipped_status: number;
  skipped_already_transitioned: number;
  errors: Array<{ recordId: string; address: string; error: string }>;
  transitioned_records: Array<{ recordId: string; address: string; envelopeId: string }>;
}

export async function GET(req: Request) {
  const t0 = Date.now();

  // Auth waterfall (mirrors arv/buyer-intelligence/rehab routes).
  const cookieHeader = req.headers.get("cookie");
  const isDashboard = hasDashboardSession(cookieHeader);
  let authKind: "dashboard_session" | "oauth" | "cron" | "bearer_dev" | "none" =
    "none";
  if (isDashboard) {
    authKind = "dashboard_session";
  } else {
    const env = readAuthEnv();
    const headers = readAuthHeaders(req);
    const authRequired =
      kvConfigured() || env.cronSecret !== null || env.bearerDevToken !== null;
    if (authRequired) {
      const auth = await authenticate(headers, env, kvProd);
      if (!auth.ok) {
        return NextResponse.json(
          { error: "unauthorized", reason: auth.reason },
          { status: 401 },
        );
      }
      authKind = auth.kind;
    }
  }
  if (authKind === "cron" && process.env.MAVERICK_CRON_ENABLED !== "true") {
    return NextResponse.json({ error: "cron_disabled" }, { status: 503 });
  }

  const summary: ReconcileSummary = {
    scanned: 0,
    transitioned: 0,
    skipped_no_envelope: 0,
    skipped_status: 0,
    skipped_already_transitioned: 0,
    errors: [],
    transitioned_records: [],
  };

  let listings;
  try {
    listings = await getListings();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await audit({
      agent: "crier",
      event: "outreach_status_reconcile_fetch_failed",
      status: "confirmed_failure",
      inputSummary: { auth_kind: authKind },
      outputSummary: { duration_ms: Date.now() - t0 },
      error: msg,
    });
    return NextResponse.json(
      { error: "listings_fetch_failed", message: msg },
      { status: 502 },
    );
  }

  summary.scanned = listings.length;
  const now = new Date();

  for (const l of listings) {
    const decision = shouldAutoTransition({
      envelopeId: l.envelopeId ?? null,
      outreachStatus: l.outreachStatus ?? null,
      notes: l.notes ?? null,
    });

    if (decision.action === "skip") {
      switch (decision.reason) {
        case "no_envelope_id":
          summary.skipped_no_envelope++;
          break;
        case "status_not_eligible":
          summary.skipped_status++;
          break;
        case "already_transitioned":
          summary.skipped_already_transitioned++;
          break;
      }
      continue;
    }

    // Decision is "transition" — write Outreach_Status, append Notes,
    // emit Spine + audit. Per-record errors are isolated; the batch
    // continues.
    const envelopeId = l.envelopeId!;
    const noteLine = buildAuditNoteLine(now, envelopeId);
    const nextNotes = l.notes ? `${l.notes}\n${noteLine}` : noteLine;

    try {
      await updateListingRecord(l.id, {
        [FIELD.outreachStatus]: "Offer Accepted",
        [FIELD.notes]: nextNotes,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      summary.errors.push({
        recordId: l.id,
        address: l.address,
        error: msg,
      });
      await audit({
        agent: "crier",
        event: "outreach_status_auto_transition_failed",
        status: "confirmed_failure",
        inputSummary: { record_id: l.id, address: l.address, envelope_id: envelopeId },
        outputSummary: {},
        error: msg,
        recordId: l.id,
      });
      continue;
    }

    summary.transitioned++;
    summary.transitioned_records.push({
      recordId: l.id,
      address: l.address,
      envelopeId,
    });

    // Audit log entry (KV ring).
    await audit({
      agent: "crier",
      event: "outreach_status_auto_transitioned",
      status: "confirmed_success",
      inputSummary: {
        record_id: l.id,
        address: l.address,
        envelope_id: envelopeId,
        prior_status: l.outreachStatus,
      },
      outputSummary: { new_status: "Offer Accepted" },
      recordId: l.id,
    });

    // Spine entry (durable, per-fire). One row per record transitioned.
    try {
      await writeState({
        event_type: "build_event",
        attribution_agent: "crier",
        title: `Outreach_Status auto-transition: ${l.address} (${l.id}) → Offer Accepted`,
        description:
          `INV-006 reconciler transition. Record ${l.id} (${l.address}) ` +
          `prior status "${l.outreachStatus}", Envelope_ID ${envelopeId} ` +
          `populated. Auto-transitioned to "Offer Accepted" with Notes ` +
          `idempotency marker. Pairs with INV-004 (rec0A9ZWSMMT5Nk9a).`,
        related_listing: l.id,
      });
    } catch (err) {
      // Spine failure does not abort the transition — Airtable + audit
      // already landed. Log and continue.
      console.error(
        `[outreach-status-reconcile] Spine write failed for ${l.id}:`,
        err,
      );
    }
  }

  return NextResponse.json({
    ok: true,
    auth_kind: authKind,
    duration_ms: Date.now() - t0,
    ...summary,
  });
}
