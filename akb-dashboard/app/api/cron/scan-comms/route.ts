import { getListings, updateListingRecord } from "@/lib/airtable";
import { getMessagesForParticipant } from "@/lib/quo";
import { synthesize } from "@/lib/maverick/synthesizer";
// toE164 moved to lib/phone.ts on 2026-06-08 — conversation-check shares it
// (it was calling Quo without normalization → empty threads on every record).
import { toE164 } from "@/lib/phone";
import { isSelfEchoOrAutoreply } from "@/lib/conversation-check";
import { triageSellerReply } from "@/lib/reply-triage";
import { sendReplyAlert, type ReplyAlertInput } from "@/lib/reply-alert";
import { sendAutoClose } from "@/lib/auto-close";
import { sendAutoAck } from "@/lib/auto-ack";
import { detectOptOut, applyOptOut } from "@/lib/outreach/opt-out";
import { resolveAlertNumbers } from "@/lib/outreach-economics";

export const runtime = "nodejs";
export const maxDuration = 60;

const AIRTABLE_PAT = process.env.AIRTABLE_PAT!;
const BASE_ID = process.env.AIRTABLE_BASE_ID || "appp8inLAGTg4qpEZ";
const AIRTABLE_BATCH_SIZE = 10;
const MAX_PHONES_PER_RUN = 25;
const SCAN_WINDOW_MINUTES = 120;

function getProposalsTableId(): string | null {
  return process.env.AGENT_PROPOSALS_TABLE_ID ?? null;
}

function cleanPhone(phone: string): string {
  return phone.replace(/[^0-9]/g, "").slice(-10);
}

function formatCurrency(n: number | null | undefined): string {
  if (n == null) return "Unknown";
  return "$" + Math.round(n).toLocaleString("en-US");
}

async function generateDraftResponse(
  listing: {
    address: string;
    agentName: string | null;
    listPrice: number | null;
    mao: number | null;
    notes: string | null;
  },
  inboundMessage: string
): Promise<string> {
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) return "[No API key — draft not generated]";

  const systemPrompt = `You are an AI assistant for AKB Solutions LLC, a real estate wholesale operation run by Alex Balog. Your job is to draft short, professional text message responses to listing agents.

Rules:
- Use 65% of List Price as the offer number
- Never use the word "assignable" — say "affiliated entity" instead
- Never disclose wholesale fee, spread, or contract price to agents
- Keep responses under 3 sentences unless the situation requires more
- Be professional but casual — these are text messages, not emails
- Always include an inspection period (10 days) in any offer terms
- Never waive inspection/option periods
- If the agent is countering, you can acknowledge but Alex makes all pricing decisions — draft a response that keeps the conversation alive without committing to a new number
- Start with "Hey [FirstName]," — extract the first name from the agent name`;

  const userPrompt = `Property: ${listing.address}
Agent: ${listing.agentName || "Unknown"}
List Price: ${formatCurrency(listing.listPrice)}
Our MAO: ${formatCurrency(listing.mao)}
Recent Notes: ${(listing.notes || "").slice(-500)}

New inbound message from agent:
"${inboundMessage}"

Draft a text message response for Alex to review.`;

  try {
    // Phase 10 / P.2 migration — routed through unified synthesizer.
    const result = await synthesize({
      agent: "crier",
      system: systemPrompt,
      user: userPrompt,
      max_tokens: 300,
      apiKey: ANTHROPIC_API_KEY,
      event_label: "crier_reply_drafted",
    });
    return result.text || "[Draft generation failed]";
  } catch (err) {
    console.error("[Crier] AI draft error:", err);
    return "[Draft generation failed]";
  }
}

async function fetchExistingPendingProposals(
  tableId: string
): Promise<Set<string>> {
  const pending = new Set<string>();
  let offset: string | undefined;

  do {
    const params = new URLSearchParams();
    params.set("filterByFormula", '{Status}="Pending"');
    params.set("fields[]", "Record_ID");
    params.append("fields[]", "Proposal_Type");
    if (offset) params.set("offset", offset);

    const res = await fetch(
      `https://api.airtable.com/v0/${BASE_ID}/${tableId}?${params.toString()}`,
      {
        headers: { Authorization: `Bearer ${AIRTABLE_PAT}` },
        cache: "no-store",
      }
    );
    if (!res.ok) break;

    const data = await res.json();
    for (const rec of data.records) {
      const f = rec.fields as Record<string, unknown>;
      pending.add(`${f.Record_ID}:${f.Proposal_Type}`);
    }
    offset = data.offset;
  } while (offset);

  return pending;
}

interface ProposalRecord {
  fields: Record<string, unknown>;
}

async function batchCreateProposals(
  tableId: string,
  records: ProposalRecord[]
): Promise<number> {
  let created = 0;
  for (let i = 0; i < records.length; i += AIRTABLE_BATCH_SIZE) {
    const batch = records.slice(i, i + AIRTABLE_BATCH_SIZE);
    const res = await fetch(
      `https://api.airtable.com/v0/${BASE_ID}/${tableId}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${AIRTABLE_PAT}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ records: batch, typecast: true }),
      }
    );
    if (res.ok) created += batch.length;
    else console.error("[Jarvis] Batch create failed:", await res.text());
  }
  return created;
}

export async function GET(req: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = req.headers.get("authorization");
    if (authHeader !== `Bearer ${cronSecret}`) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const proposalsTableId = getProposalsTableId();
  if (!proposalsTableId) {
    return Response.json(
      { error: "AGENT_PROPOSALS_TABLE_ID not set" },
      { status: 500 }
    );
  }

  if (!process.env.QUO_API_KEY) {
    return Response.json(
      { error: "QUO_API_KEY not set" },
      { status: 500 }
    );
  }

  try {
    const listings = await getListings();

    // Only check actionable listings that have agent phones
    const ACTIONABLE = new Set([
      "Negotiating",
      "Response Received",
      "Offer Accepted",
      "Texted",
    ]);
    const actionableListings = listings.filter(
      (l) => l.agentPhone && ACTIONABLE.has(l.outreachStatus ?? "")
    );

    // Dedupe phones — multiple listings can share an agent phone
    const phoneToListings = new Map<string, typeof actionableListings>();
    for (const listing of actionableListings) {
      const e164 = toE164(listing.agentPhone!);
      const existing = phoneToListings.get(e164) ?? [];
      existing.push(listing);
      phoneToListings.set(e164, existing);
    }

    // Cap phones per run to stay within timeout
    const phones = Array.from(phoneToListings.keys()).slice(
      0,
      MAX_PHONES_PER_RUN
    );

    // Pre-flight dedupe
    const existingPending =
      await fetchExistingPendingProposals(proposalsTableId);

    let phonesChecked = 0;
    let inboundFound = 0;
    let matched = 0;
    const newProposals: ProposalRecord[] = [];
    // Outbound SMS alerts to ALERT_PHONE, fired AFTER batch-create succeeds.
    // Operator directive (2026-06-10): a reply that turns into a live
    // negotiation in 60 seconds means alerting is no longer optional.
    const alertQueue: ReplyAlertInput[] = [];
    // Tier 0 auto-close outcomes (sent / skipped + reason), surfaced in the
    // response so the daily digest + audit trail have the full picture.
    const autoCloseResults: Array<{ recordId: string; sent: boolean; reason: string | null }> = [];
    const autoAckResults: Array<{ recordId: string; sent: boolean; reason: string | null }> = [];
    // M8 / Gate 3 — STOP/opt-out (operator 2026-06-18).
    let optOutDetected = 0;
    let optOutFlipped = 0;
    const optOutApplied: Array<{ phone: string; matched: string; records: number; flipped: string[] }> = [];
    // 2026-06-08: was string[]. Now carries the INBOUND's actual createdAt,
    // not wall-clock now — the prior shape stamped Last_Inbound_At with
    // "right now" on every cron tick (line 278 used new Date()), so the
    // timestamp was always wrong by however long since the agent replied.
    // This breaks the conversation-check classifier (inbounds AFTER an
    // outbound look like they happened after a future outbound).
    const timestampUpdates: Array<{ id: string; inboundCreatedAt: string }> = [];
    const errors: string[] = [];

    for (const phone of phones) {
      phonesChecked++;
      try {
        const messages = await getMessagesForParticipant(
          phone,
          SCAN_WINDOW_MINUTES
        );

        // Find the most recent GENUINE inbound — skip self-echoes (our H2
        // template reflected back on some carriers) and bot autoreplies
        // (out-of-office / "no longer in service" / brokerage autoreply).
        // Treating those as replies created false "Response Received" +
        // bogus triage proposals (the conversation-check fix, now live on
        // the inbound path, not just the back-cohort tool).
        const inbound = messages.find(
          (m) => m.direction === "incoming" && !isSelfEchoOrAutoreply(m.body),
        );
        if (!inbound) continue;
        inboundFound++;

        // Match to all listings with this phone
        const matchedListings = phoneToListings.get(phone) ?? [];

        // ── M8 / Gate 3 (operator 2026-06-18): STOP / opt-out. A TCPA opt-out
        // is NOT a deal rejection — never send the tier-0 "best of luck" close,
        // and flip Do_Not_Text on EVERY record sharing this phone (number-level).
        // SUPPRESSION of the close/proposal is unconditional (fail-closed safety);
        // the Do_Not_Text WRITE is gated by STOP_OPT_OUT_LIVE (watched-first). H2
        // cannot fire until that flag is live (h2-outreach hard-disable coupling).
        const optOut = detectOptOut(inbound.body);
        if (optOut.optOut) {
          optOutDetected++;
          let flipped: string[] = [];
          if (process.env.STOP_OPT_OUT_LIVE === "true" && matchedListings.length > 0) {
            const res = await applyOptOut(matchedListings, optOut.matched ?? "stop", { updateListing: updateListingRecord });
            flipped = res.flipped;
            optOutFlipped += res.flipped.length;
            if (res.failed.length > 0) errors.push(`opt_out_write_failed: ${res.failed.map((f) => f.id).join(",")}`);
          }
          optOutApplied.push({ phone, matched: optOut.matched ?? "stop", records: matchedListings.length, flipped });
          continue; // SUPPRESS the close + proposals for an opt-out; move to next phone.
        }

        for (const listing of matchedListings) {
          matched++;

          if (existingPending.has(`${listing.id}:jarvis_reply`)) continue;

          // INV — stamp the INBOUND's actual createdAt, not wall-clock now.
          // (Was the source of the unbacked-reply pattern + breaks
          // conversation-check's outbound-vs-inbound ordering.)
          timestampUpdates.push({ id: listing.id, inboundCreatedAt: inbound.createdAt });

          // Triage FIRST (cheap, pure) — the tier decides the whole route.
          // Shared with scan-replies via lib/reply-triage.ts (one classifier,
          // no drift).
          // sentOfferUsd: outreachOfferPrice is only trusted as the sticky
          // number when the record shows a delivered first touch (the h2 lane
          // stamps it at send). Anything else → the soft-no draft carries NO
          // number (pricing-doctrine method 6 — fields are history, not
          // authority).
          const deliveredFirstTouch =
            listing.outreachStatus === "Texted" ||
            listing.outreachStatus === "Response Received" ||
            listing.outreachStatus === "Parked";
          const triage = triageSellerReply(inbound.body, listing.outreachStatus ?? null, {
            sentOfferUsd:
              deliveredFirstTouch && typeof listing.outreachOfferPrice === "number" && listing.outreachOfferPrice > 0
                ? listing.outreachOfferPrice
                : null,
            street: (listing.address ?? "").split(",")[0].trim() || null,
          });

          // ── TIER 0: high-confidence rejection → system auto-close. ──
          // No proposal, no alert, no Claude draft. The close rides the
          // standard rails (quiet hours, DNT, one-per-thread KV claim) and
          // is fully audited; idempotency across cron ticks is the KV claim.
          if (triage.tier === "tier_0_auto_close") {
            const ac = await sendAutoClose({
              recordId: listing.id,
              toE164: phone,
              state: listing.state ?? null,
              doNotText: listing.doNotText === true,
              address: listing.address ?? null,
            });
            autoCloseResults.push({ recordId: listing.id, sent: ac.sent, reason: ac.reason });
            continue;
          }

          // ── TIER 1 (interest only): one-time, number-free warm-hold ack. ──
          // Keeps a "yes, send me the offer / proof of funds" lead warm while
          // it waits in the operator's queue. Default OFF (REPLY_AUTO_ACK_LIVE),
          // interest-only, never negotiates (no numbers). Does NOT continue —
          // the needs-decision proposal + alert below STILL fire, so the
          // operator owns the actual engagement.
          if (triage.classification === "interest") {
            const ak = await sendAutoAck({
              recordId: listing.id,
              toE164: phone,
              state: listing.state ?? null,
              doNotText: listing.doNotText === true,
              classification: triage.classification,
              address: listing.address ?? null,
            });
            autoAckResults.push({ recordId: listing.id, sent: ak.sent, reason: ak.reason });
          }

          // ── TIER 1 / 2: needs-decision proposal + decision-first alert. ──
          // Soft-no uses the PURE pre-built re-engagement draft (sticky-number
          // rule enforced in lib/reply-triage) — it never touches the model
          // draft path, which reads record fields. Everything else keeps the
          // existing draft generator.
          const draftResponse =
            triage.classification === "soft_no" && triage.suggestedReply
              ? triage.suggestedReply
              : await generateDraftResponse(
                  listing,
                  inbound.body
                );

          const actionPayload = JSON.stringify({
            recordId: listing.id,
            action: "send_sms",
            to: phone,
            draftBody: draftResponse,
            inboundBody: inbound.body,
            classification: triage.classification,
            decisionKind: triage.decisionKind,
            needsDecision: triage.needsDecision,
            queueStatus: triage.queueStatus,
            tier: triage.tier,
          });

          newProposals.push({
            fields: {
              Proposal_ID: `jarvis_reply-${Date.now()}-${newProposals.length}`,
              Proposal_Type: "jarvis_reply",
              Priority: triage.priority,
              Record_ID: listing.id,
              Record_Address: listing.address,
              Reasoning: `Inbound from ${listing.agentName || "agent"} [${triage.classification}${triage.queueStatus ? ` → ${triage.queueStatus}` : ""}]: ${triage.reasoning}`,
              Suggested_Action_Payload: actionPayload,
              Status: "Pending",
            },
          });

          // Queue the decision/urgent alert for AFTER batch-create succeeds.
          // The body leads with the decision, never the inbound text (Quo
          // already showed Alex the message). Numbers resolve through the
          // SAME read path the batch dispatches with (resolveAlertNumbers)
          // — one read path, not a parallel one (2026-06-10 smoke-test fix).
          // Missing numbers still fall back to "hold sticky opener" with the
          // gap audited, never fabricated.
          const nums = resolveAlertNumbers(listing);
          alertQueue.push({
            recordId: listing.id,
            address: listing.address ?? null,
            tier: triage.tier,
            classification: triage.classification,
            outreachOfferPrice: nums.opener,
            underwrittenMao: nums.mao,
          });

          existingPending.add(`${listing.id}:jarvis_reply`);
        }
      } catch (err) {
        errors.push(`${phone}: ${String(err)}`);
      }
    }

    // Batch create proposals
    const created =
      newProposals.length > 0
        ? await batchCreateProposals(proposalsTableId, newProposals)
        : 0;

    // Fire reply alerts (best-effort, never block the cron). One per needs-
    // decision proposal that was just created. The alert queue is gated on
    // triage.needsDecision upstream — rejections (auto-Dead) do not page.
    const alertResults: Array<{ recordId: string; sent: boolean; reason: string | null }> = [];
    if (created > 0 && alertQueue.length > 0) {
      for (const item of alertQueue) {
        try {
          const res = await sendReplyAlert(item);
          alertResults.push({ recordId: item.recordId, sent: res.sent, reason: res.reason });
        } catch (e) {
          alertResults.push({ recordId: item.recordId, sent: false, reason: e instanceof Error ? e.message.slice(0, 160) : String(e).slice(0, 160) });
        }
      }
    }

    // Stamp Last_Inbound_At with the inbound's ACTUAL createdAt — was
    // wall-clock new Date() before 2026-06-08, breaking timeline ordering.
    for (const { id, inboundCreatedAt } of timestampUpdates) {
      try {
        await updateListingRecord(id, {
          fld3IhR1DXzcVuq6F: inboundCreatedAt,
        });
      } catch (err) {
        console.error(
          `[Jarvis] Failed to stamp Last_Inbound_At on ${id}:`,
          err
        );
      }
    }

    return Response.json({
      phonesInPool: phoneToListings.size,
      phonesChecked,
      inboundFound,
      matched,
      proposalsCreated: created,
      skippedDedupe: matched - newProposals.length - autoCloseResults.length,
      alertsAttempted: alertResults.length,
      alertsSent: alertResults.filter((r) => r.sent).length,
      alertResults: alertResults.length > 0 ? alertResults : undefined,
      autoCloseAttempted: autoCloseResults.length,
      autoCloseSent: autoCloseResults.filter((r) => r.sent).length,
      autoCloseResults: autoCloseResults.length > 0 ? autoCloseResults : undefined,
      autoAckAttempted: autoAckResults.length,
      autoAckSent: autoAckResults.filter((r) => r.sent).length,
      autoAckResults: autoAckResults.length > 0 ? autoAckResults : undefined,
      optOutDetected,
      optOutFlipped,
      optOutEnforced: process.env.STOP_OPT_OUT_LIVE === "true",
      optOutApplied: optOutApplied.length > 0 ? optOutApplied : undefined,
      errors: errors.length > 0 ? errors : undefined,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[scan-comms] error:", err);
    return Response.json(
      { error: "Scan failed", detail: String(err) },
      { status: 500 }
    );
  }
}
