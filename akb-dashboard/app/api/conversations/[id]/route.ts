import { getListing, getListings } from "@/lib/airtable";
import { withBudget } from "@/lib/async-budget";
import { getThreadVerified } from "@/lib/quo";
import { getThreadsForEmail } from "@/lib/gmail";
import { parseConversation } from "@/lib/notes";
import { mergeTimeline, type SiblingRecord } from "@/lib/timeline-merge";
import { detectCaptureGaps } from "@/lib/comms-integrity";
import { extractStickyOffer } from "@/lib/h2-outreach/bump-lane";
import { resolveDisplayOffer, resolveDisplayCeiling } from "@/lib/deal-numbers";
import { fixNoteTimestamp, stripSyncMarkers } from "@/lib/timeline-fixups";
import { cleanEmailBody } from "@/lib/email-clean";

export const runtime = "nodejs";
// 60s belt over the parallel per-source budgets (9-12s each) — the
// pre-2026-07-20 sequential fetch chain proved 30s wasn't enough on
// multi-listing agents (Canfield 504).
export const maxDuration = 60;

interface UnifiedMessage {
  id: string;
  source: "quo" | "email" | "notes";
  direction: "inbound" | "outbound" | "system";
  body: string;
  // Full verbatim body BEFORE quoted-history / signature stripping. Only set
  // when `body` was cleaned (email source) and differs — lets the panel offer
  // a "show original" without losing the raw record. Undefined = body IS raw.
  raw_body?: string;
  timestamp: string;
  from: string;
  to: string;
  subject?: string;
}

function cleanPhone(phone: string): string {
  const digits = phone.replace(/[^0-9]/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return `+${digits}`;
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  if (!id || !id.startsWith("rec")) {
    return Response.json({ error: "Invalid record ID" }, { status: 400 });
  }

  try {
    const listing = await getListing(id);
    if (!listing) {
      return Response.json({ error: "Listing not found" }, { status: 404 });
    }

    // THE SOURCES RUN IN PARALLEL, EACH UNDER A TIME BUDGET (2026-07-20,
    // the Canfield empty-thread 504): sequential fetches summed past the
    // 30s lambda ceiling on a multi-listing agent with phone + email on
    // file, the route 504'd, and the panel rendered the failure as an empty
    // thread. Now one slow source degrades — flagged in `degraded`, never
    // silent — and the sources that answered still render. Notes are local
    // to the record and always survive.
    const degraded: string[] = [];
    const ENGAGED = new Set(["Negotiating", "Response Received", "Counter Received", "Offer Accepted"]);

    // Sibling listings (same Agent_Phone) so each cross-channel message is
    // attributed to a specific property — keeps THIS property's thread clean
    // when an agent holds several listings. Sole-engaged tie-break (685
    // Bolton, 2026-07-13): when THIS record is the phone's only live-money
    // deal, signal-less messages render here instead of vanishing.
    const siblingLookup = async (): Promise<{ siblings: SiblingRecord[]; targetSoleEngaged: boolean }> => {
      if (!listing.agentPhone) return { siblings: [], targetSoleEngaged: false };
      const all = await getListings();
      const target = cleanPhone(listing.agentPhone);
      const siblingListings = all.filter(
        (l) => l.id !== id && l.agentPhone && cleanPhone(l.agentPhone) === target,
      );
      return {
        siblings: siblingListings.map((l) => ({
          recordId: l.id,
          address: l.address,
          candidatePrices: [l.listPrice, l.outreachOfferPrice ?? null].filter(
            (n): n is number => typeof n === "number" && n > 0,
          ),
        })),
        targetSoleEngaged:
          ENGAGED.has(listing.outreachStatus ?? "") &&
          !siblingListings.some((l) => ENGAGED.has(l.outreachStatus ?? "")),
      };
    };

    const [siblingResult, quoMessages, gmailMessages] = await Promise.all([
      withBudget(siblingLookup(), 9_000, { siblings: [], targetSoleEngaged: false }, "attribution", degraded),
      // 1. Texts — RELIABLE read path (wire #3): verify each message by id.
      listing.agentPhone && process.env.QUO_API_KEY
        ? withBudget(
            getThreadVerified(cleanPhone(listing.agentPhone), 60 * 24 * 90, 60).then((t) => t.messages), // 90 days
            12_000,
            [] as Awaited<ReturnType<typeof getThreadVerified>>["messages"],
            "texts",
            degraded,
          )
        : Promise.resolve([] as Awaited<ReturnType<typeof getThreadVerified>>["messages"]),
      // 2. Gmail — live email thread with the agent (returns [] if Gmail not
      // configured). Wire #4: email threads INTO the conversation.
      listing.agentEmail
        ? withBudget(
            getThreadsForEmail(listing.agentEmail),
            12_000,
            [] as Awaited<ReturnType<typeof getThreadsForEmail>>,
            "email",
            degraded,
          )
        : Promise.resolve([] as Awaited<ReturnType<typeof getThreadsForEmail>>),
    ]);
    const { siblings, targetSoleEngaged } = siblingResult;

    // 3. Notes — emails/SMS/manual entries already logged to the record
    // (durable backstop; deduped against the live pulls by the merge engine).
    // Timestamp fixups (2026-07-11 Ivy Bend): prefer the embedded sync
    // metadata ts= (the carrier's message time); null fabricated pre-2015
    // parses so true chronological order holds.
    // Order matters: fixNoteTimestamp READS the sync marker (ts=…), so it
    // runs first; then the marker is stripped so BOTH the merge engine's
    // dedupe and the rendered bubble see the bare message. Before this
    // (2026-07-18 Canfield double-bubble), dedupe compared the RAW note —
    // marker/prefix included — missed the live Quo copy, and the thread
    // showed every deep-synced inbound twice.
    const notesEntries = (listing.notes ? parseConversation(listing.notes) : []).map((e) => ({
      ...e,
      timestamp: fixNoteTimestamp({ text: e.text, timestamp: e.timestamp }),
      text: stripSyncMarkers(e.text),
    }));

    // Single merge engine: texts + Gmail + notes, deduped, attributed, and
    // SORTED STRICTLY BY TIMESTAMP — so a $100 text 5:00, a $101 email 5:01,
    // and an "ok send it" text 5:02 thread in that exact order regardless of
    // channel. This sequencing is the source of truth downstream logic reads.
    const { timeline } = mergeTimeline(quoMessages, gmailMessages, notesEntries, {
      recordId: id,
      targetAddress: listing.address,
      // INV-016: include the OUTREACH OFFER alongside list price — H2
      // bodies cite the offer (≈65% of list), so a seller-agent reply
      // citing our number now triggers the +0.3 price-match bonus.
      targetPrices: [listing.listPrice, listing.outreachOfferPrice ?? null].filter(
        (n): n is number => typeof n === "number" && n > 0,
      ),
      agentName: listing.agentName ?? null,
      siblings,
      targetSoleEngaged,
    });

    // Keep only entries confidently attributed to THIS property (sibling- or
    // low-confidence messages stay out of this thread; they remain visible via
    // the AMBIGUOUS banner on /pipeline/[id]). Notes/system carry confidence
    // 1.0 for this record, so they always pass.
    const channelToSource: Record<string, "quo" | "email" | "notes"> = {
      sms: "quo", email: "email", note: "notes", system: "notes",
    };
    const messages: UnifiedMessage[] = timeline
      .filter((e) => e.propertyMatch.recordId === id && e.propertyMatch.confidence >= 0.6)
      .map((e, i) => {
        const source = channelToSource[e.channel] ?? "notes";
        const direction: UnifiedMessage["direction"] =
          e.channel === "system" ? "system" : e.direction === "in" ? "inbound" : "outbound";
        const rawId = (e.raw as { id?: string } | undefined)?.id;
        // P1.3 (2026-07-13): email bodies dump the ENTIRE quoted thread +
        // signature/IABS/wire-fraud boilerplate into one bubble. Strip that for
        // DISPLAY so each message reads like the SMS bubbles do. SMS/notes pass
        // through untouched. The raw body is preserved on `raw_body` when it
        // actually changed (never lose the verbatim record).
        let body = e.body;
        let rawBody: string | undefined;
        // Sync provenance markers ([Quo/Gmail inbound msg … src=…]) are
        // machine metadata glued onto notes entries by the parser — the
        // ledger keeps them verbatim; the bubble never shows them (Duane
        // Covert report, 2026-07-13).
        if (source === "notes" && body) {
          body = stripSyncMarkers(body);
        }
        if (source === "email" && e.body) {
          const cleaned = cleanEmailBody(e.body);
          // Keep the raw if cleaning left nothing (message was pure quote/
          // boilerplate) so the bubble isn't empty; otherwise show the clean
          // text and stash the original.
          if (cleaned && cleaned !== e.body) {
            body = cleaned;
            rawBody = e.body;
          }
        }
        const msg: UnifiedMessage = {
          id: `${e.channel}-${i}-${rawId ?? "x"}`,
          source,
          direction,
          body,
          timestamp: e.timestamp,
          from: e.sender,
          to: direction === "inbound" ? "Alex (AKB)" : (listing.agentName ?? "Agent"),
        };
        if (rawBody) msg.raw_body = rawBody;
        if (e.subject) msg.subject = e.subject;
        return msg;
      });

    // COMMS INTEGRITY (operator 2026-07-11, hard requirement): the record's
    // own contact stamps claim messages happened — if this record's merged
    // timeline is missing one (the 3731 Baltimore cross-thread class, a
    // vanished append, a sibling-attribution miss), the gap SURFACES as an
    // alert, never silently.
    const integrity = detectCaptureGaps({
      lastInboundAt: listing.lastInboundAt,
      lastOutboundAt: listing.lastOutboundAt,
      lastEmailOutreachDate: listing.lastEmailOutreachDate,
      messages: messages.map((m) => ({ direction: m.direction, timestamp: m.timestamp })),
      nowIso: new Date().toISOString(),
    });

    return Response.json({
      recordId: id,
      address: listing.address,
      agentName: listing.agentName,
      agentPhone: listing.agentPhone,
      agentEmail: listing.agentEmail,
      messageCount: messages.length,
      quoCount: messages.filter((m) => m.source === "quo").length,
      emailCount: messages.filter((m) => m.source === "email").length,
      notesCount: messages.filter((m) => m.source === "notes").length,
      messages,
      integrity,
      // Sources that timed out or failed this request — the panel surfaces
      // these so a degraded pull never masquerades as an empty thread.
      degraded: [...new Set(degraded)],
      // NUMBERS RAIL (sourced only — INVARIANTS §1/§3): the delivery-stamped
      // offer parsed from the [H2 sent …] stamp (the number the agent
      // actually received; fields drift, stamps don't), the operator's
      // ceiling, and list. Null when un-sourced — the UI renders "—".
      numbers: {
        // Offer: delivery-stamp authority, then the real working fields
        // (contract → value-anchored rough opener → legacy outreach). Never
        // MAO_V1 (List×0.65). P1.1 (2026-07-13).
        stamped_offer: resolveDisplayOffer(
          {
            contractOfferPrice: listing.contractOfferPrice,
            roughOpenerAmount: listing.roughOpenerAmount,
            outreachOfferPrice: listing.outreachOfferPrice,
          },
          extractStickyOffer(listing.notes)?.offer ?? null,
        ).amount,
        outreach_offer_field: listing.roughOpenerAmount ?? listing.outreachOfferPrice ?? null,
        // Ceiling: value-anchored Underwritten_MAO only. Was `?? listing.mao`
        // — MAO_V1, the retired List×0.65 formula — which showed a list-
        // anchored number as "your ceiling" on un-underwritten legacy deals
        // (Sunbeam). Null now → "—" until P1.2 underwrites the record.
        ceiling: resolveDisplayCeiling(listing),
        list_price: listing.listPrice ?? null,
      },
    });
  } catch (err) {
    console.error(`[conversations] Error for ${id}:`, err);
    return Response.json(
      { error: "Failed to load conversations", detail: String(err) },
      { status: 500 }
    );
  }
}
