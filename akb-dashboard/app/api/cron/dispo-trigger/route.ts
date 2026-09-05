// DISPO TRIGGER — hunted → contracted → dispo'ed, automatically (2026-09-05).
// @agent: scout/crier
//
// Runs at 25,55 * * * * (vercel.json). For every listing with
// Contract_Executed_At set and no Dispo_Blast_Fired_At (see
// getDispoTriggerCandidates — Dead is excluded server-side), this:
//
//   1. claims `dispo:blast:<recordId>` in KV (1h NX) so overlapping
//      invocations can't double-send; Airtable's Dispo_Blast_Fired_At is
//      the durable stamp;
//   2. runs the assignment-spread gate (lib/pricing/assignment-spread):
//      BLOCK → no send, audited, operator fixes Assignment_Price or fires
//      /api/buyers/fire-blast with allowThinSpread by hand. HOLD (no
//      contract price) → skipped, audited;
//   3. collects photos ONCE (collectPhotos: RentCast → Firecrawl → Street
//      View) and publishes the deal page (Deal_Photo_URLs + Dispo_Public)
//      BEFORE any email so the link in the email works on arrival;
//   4. ranks the rolodex with buildBuyerShortlist, takes the callable top
//      slice with an email on file (selectBlastRecipients), and sends the
//      deterministic template (composeDispoBlastEmail) — ONE number, the
//      assignment price, plus the /d/<recordId> link. SMS to buyers is OFF
//      here on purpose: buyers text from the 815 line only on the
//      operator's word (TCPA-adjacent = Tier C);
//   5. stamps buyers (Email_Sent_At / Last_Engagement_At), appends a blast
//      log to Verification_Notes, stamps Dispo_Blast_Fired_At, audits
//      `dispo_blast_fired`.
//
// If every send fails (Gmail down) the stamp is NOT written, so the next
// slot retries after the KV claim expires. If there are simply no eligible
// buyers the stamp IS written with a zero count (nothing to retry) and the
// deal page is still live for the operator's own phone list.
//
// Auth waterfall + MAVERICK_CRON_ENABLED kill switch match morning-digest.
// ?dry_run=1 reports gate + recipients + email preview, writes nothing.
// ?record_id=rec... limits the run to one record.

import { NextResponse } from "next/server";
import { getDispoTriggerCandidates, getBuyers, updateListingRecord } from "@/lib/airtable";
import { updateBuyerV2, BUYER_V2_FIELDS } from "@/lib/buyers-v2";
import { audit } from "@/lib/audit-log";
import {
  authenticate,
  hasDashboardSession,
  readAuthEnv,
  readAuthHeaders,
} from "@/lib/maverick/oauth/auth-waterfall";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";
import { sendEmail } from "@/lib/gmail";
import { collectPhotos } from "@/lib/photo-sources";
import { evaluateAssignmentSpread } from "@/lib/pricing/assignment-spread";
import { buildBuyerShortlist } from "@/lib/dispo/buyer-shortlist";
import {
  composeDispoBlastEmail,
  dealPageUrl,
  photoUrlsJson,
  selectBlastRecipients,
} from "@/lib/dispo/blast-email";
import type { Listing } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;

const BASE_URL = () => process.env.DASHBOARD_BASE_URL || "https://coach-pulse-ten.vercel.app";
const MAX_RECIPIENTS = () => {
  const n = Number(process.env.DISPO_BLAST_MAX_RECIPIENTS);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 25) : 10;
};
const CLAIM_TTL_SECONDS = 3600;

function stamp(): string {
  return new Date().toLocaleDateString("en-US", {
    month: "numeric", day: "numeric", year: "2-digit", hour: "numeric", minute: "2-digit", hour12: true,
  });
}

function contractPriceOf(l: Listing): number | null {
  const L = l as unknown as Record<string, unknown>;
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
  return num(L.contractOfferPrice) ?? num(L.contractPrice);
}

interface RecordOutcome {
  recordId: string;
  address: string;
  outcome: "blasted" | "no_recipients" | "gate_block" | "gate_hold" | "claimed_elsewhere" | "send_failed" | "dry_run" | "error";
  detail?: string;
  gate?: unknown;
  recipients?: Array<{ buyerId: string; name: string; email: string; sent?: boolean; error?: string }>;
  photos?: number;
  preview?: { subject: string; body: string };
}

export async function GET(req: Request) {
  const t0 = Date.now();
  const cookieHeader = req.headers.get("cookie");
  let authKind = "none";
  if (hasDashboardSession(cookieHeader)) {
    authKind = "dashboard_session";
  } else {
    const env = readAuthEnv();
    const headers = readAuthHeaders(req);
    const authRequired = kvConfigured() || env.cronSecret !== null || env.bearerDevToken !== null;
    if (authRequired) {
      const auth = await authenticate(headers, env, kvProd);
      if (!auth.ok) return NextResponse.json({ error: "unauthorized", reason: auth.reason }, { status: 401 });
      authKind = auth.kind;
    }
  }
  if (authKind === "cron" && process.env.MAVERICK_CRON_ENABLED !== "true") {
    return NextResponse.json({ error: "cron_disabled" }, { status: 503 });
  }

  const url = new URL(req.url);
  // Operator hold (2026-09-05, "hold the first blast for my eyes"): the lane
  // is DARK until DISPO_BLAST_LIVE=true. Dark = every run is a dry run —
  // gate, shortlist, and preview are computed and reported, nothing is
  // sent, published, or stamped.
  const held = process.env.DISPO_BLAST_LIVE !== "true";
  const dryRun = held || url.searchParams.get("dry_run") === "1";
  const onlyRecord = url.searchParams.get("record_id");

  let candidates: Listing[];
  try {
    candidates = await getDispoTriggerCandidates();
  } catch (err) {
    return NextResponse.json({ error: "candidate_fetch_failed", detail: String(err) }, { status: 502 });
  }
  if (onlyRecord) candidates = candidates.filter((c) => c.id === onlyRecord);

  const outcomes: RecordOutcome[] = [];
  if (candidates.length === 0) {
    return NextResponse.json({ ok: true, dry_run: dryRun, held, candidates: 0, outcomes, ms: Date.now() - t0 });
  }

  let buyers: Awaited<ReturnType<typeof getBuyers>> = [];
  try {
    buyers = await getBuyers();
  } catch (err) {
    return NextResponse.json({ error: "buyers_fetch_failed", detail: String(err) }, { status: 502 });
  }

  for (const l of candidates) {
    const recordId = l.id;
    const out: RecordOutcome = { recordId, address: l.address, outcome: "error" };
    outcomes.push(out);
    try {
      // ── Gate: never blast a money-loser.
      const contractPrice = contractPriceOf(l);
      const assignmentPrice = l.assignmentPrice ?? null;
      const gate = evaluateAssignmentSpread({ assignmentPrice, contractPrice });
      out.gate = gate;
      if (gate.status !== "pass") {
        out.outcome = gate.status === "block" ? "gate_block" : "gate_hold";
        out.detail = gate.reason;
        if (!dryRun) {
          await audit({
            agent: "scout", event: "dispo_blast_gated", status: "uncertain", recordId,
            decision: gate.status, inputSummary: { assignmentPrice, contractPrice }, outputSummary: { reason: gate.reason },
          });
        }
        continue;
      }
      const price = assignmentPrice as number;

      // ── Shortlist + recipients (pure).
      const shortlist = buildBuyerShortlist({
        subject: { recordId, address: l.address, zip: l.zip ?? null, state: l.state ?? null, city: l.city ?? null, price },
        buyers,
        topN: MAX_RECIPIENTS(),
      });
      const recipients = selectBlastRecipients(shortlist, MAX_RECIPIENTS());
      out.recipients = recipients.map((r) => ({ buyerId: r.buyerId, name: r.name, email: r.email }));
      const link = dealPageUrl(BASE_URL(), recordId);
      const emailFor = (name: string | null) =>
        composeDispoBlastEmail({
          buyerName: name, address: l.address, city: l.city ?? null, state: l.state ?? null, zip: l.zip ?? null,
          beds: l.bedrooms ?? null, baths: l.bathrooms ?? null, sqft: l.buildingSqFt ?? null,
          assignmentPrice: price, optionDeadline: l.optionDeadline ?? null, dealUrl: link,
        });
      out.preview = emailFor(recipients[0]?.name ?? null);

      if (dryRun) {
        out.outcome = "dry_run";
        continue;
      }

      // ── Claim (overlap guard).
      if (kvConfigured()) {
        const claimed = await kvProd.setNx(`dispo:blast:${recordId}`, new Date().toISOString(), CLAIM_TTL_SECONDS);
        if (!claimed) {
          out.outcome = "claimed_elsewhere";
          continue;
        }
      }

      // ── Publish the deal page first (photos once), so the link works.
      let photoCount = 0;
      const publishFields: Record<string, unknown> = { Dispo_Public: true };
      if (!l.dealPhotoUrls) {
        try {
          const fullAddress = [l.address, l.city, l.state, l.zip].filter(Boolean).join(", ");
          const photos = await collectPhotos({
            verificationUrl: l.verificationUrl ?? null, fullAddress,
            address: l.address, city: l.city ?? null, state: l.state ?? null, zip: l.zip ?? null, maxTotal: 8,
          });
          photoCount = photos.length;
          if (photos.length > 0) publishFields.Deal_Photo_URLs = photoUrlsJson(photos);
        } catch (err) {
          console.error(`[dispo-trigger] photo collection failed for ${recordId}:`, err);
        }
      }
      out.photos = photoCount;
      try {
        await updateListingRecord(recordId, publishFields);
      } catch (err) {
        console.error(`[dispo-trigger] publish write failed for ${recordId}:`, err);
      }

      // ── Send.
      const noteLines: string[] = [];
      let sent = 0;
      for (const r of recipients) {
        const rec = out.recipients!.find((x) => x.buyerId === r.buyerId)!;
        try {
          const email = emailFor(r.name);
          const res = await sendEmail({ to: r.email, subject: email.subject, body: email.body });
          if (!res.success) throw new Error(res.error ?? "Gmail send failed");
          rec.sent = true;
          sent++;
          const nowIso = new Date().toISOString();
          try {
            await updateBuyerV2(r.buyerId, {
              [BUYER_V2_FIELDS.Email_Sent_At]: nowIso,
              [BUYER_V2_FIELDS.Last_Engagement_At]: nowIso,
            });
          } catch (err) {
            console.error(`[dispo-trigger] buyer stamp failed ${r.buyerId}:`, err);
          }
          noteLines.push(`${stamp()} — Dispo blast (auto): emailed ${r.name} @ ${r.email}${res.messageId ? ` [gmail:${res.messageId}]` : ""}`);
        } catch (err) {
          rec.sent = false;
          rec.error = String(err);
        }
      }

      const allFailed = recipients.length > 0 && sent === 0;
      if (allFailed) {
        out.outcome = "send_failed";
        out.detail = "every send failed; will retry next slot";
      } else {
        out.outcome = recipients.length === 0 ? "no_recipients" : "blasted";
        if (recipients.length === 0) noteLines.push(`${stamp()} — Dispo blast (auto): no buyers with email matched; deal page live at ${link}`);
      }

      const stampFields: Record<string, unknown> = {};
      if (!allFailed) stampFields.Dispo_Blast_Fired_At = new Date().toISOString();
      if (noteLines.length > 0) {
        const existing = l.notes ?? "";
        stampFields.Verification_Notes = existing ? `${existing}\n${noteLines.join("\n")}` : noteLines.join("\n");
      }
      if (Object.keys(stampFields).length > 0) {
        try {
          await updateListingRecord(recordId, stampFields);
        } catch (err) {
          console.error(`[dispo-trigger] stamp write failed for ${recordId}:`, err);
          out.detail = `${out.detail ?? ""} stamp_write_failed: ${String(err)}`.trim();
        }
      }

      await audit({
        agent: "scout", event: "dispo_blast_fired", status: allFailed ? "confirmed_failure" : "confirmed_success", recordId,
        decision: out.outcome,
        inputSummary: { assignmentPrice: price, contractPrice, recipients: recipients.length, link },
        outputSummary: { sent, failed: recipients.length - sent, photos: photoCount, shortlistCoverage: shortlist.coverage },
        ms: Date.now() - t0,
      });
    } catch (err) {
      out.outcome = "error";
      out.detail = String(err);
      console.error(`[dispo-trigger] ${recordId}:`, err);
      if (!dryRun) {
        await audit({ agent: "scout", event: "dispo_blast_fired", status: "confirmed_failure", recordId, error: String(err) });
      }
    }
  }

  return NextResponse.json({ ok: true, dry_run: dryRun, held, candidates: candidates.length, outcomes, ms: Date.now() - t0 });
}
