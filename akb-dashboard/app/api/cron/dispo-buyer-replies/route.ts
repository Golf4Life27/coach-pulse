// DISPO BUYER REPLY cron — reads a buyer's reply to a dispo blast (2026-09-07).
// @agent: scout
//
// THE GAP: dispo-trigger blasts up to ~10 buyers a deterministic template
// (lib/dispo/blast-email.ts) the moment a contract executes, and stamps the
// SEND. Nothing ever read the REPLY — a buyer answering "I'll take it at
// $190k" or "send me the contract" changed nothing on the record and paged
// nobody, inside a 10-day option window. This cron is the read/route half.
//
// MATCHING: dispo-trigger persisted NOTHING usable for this before this
// change — sendEmail's Gmail threadId was discarded after being logged into
// the Verification_Notes text as "[gmail:<id>]" (the SENT message id, not a
// thread key). This build adds the smallest field addition that makes a
// reply findable: dispo-trigger now stamps Dispo_Blast_Thread_Id +
// Dispo_Blast_Listing_Id on the Buyers row the moment a send succeeds (see
// lib/buyers-v2.ts BUYER_V2_FIELDS). This cron polls the (small, by
// construction) population of buyers carrying a thread id, pulls the whole
// thread by id (lib/gmail.getThreadById — the SAME linked-thread fetch
// gmail-sync uses for seller threads), and reads any message FROM the
// buyer's own address that isn't already ingested.
//
// IDEMPOTENCY: reuses extractCitedGmailIds (lib/inbound/gmail-capture.ts) —
// the exact function gmail-sync/quo-sync use to dedupe seller-side inbound
// against Verification_Notes — so a buyer-reply marker written here is
// invisible to nothing already scanning that field, and this cron never
// re-ingests a message id already cited.
//
// CLASSIFICATION: lib/dispo/buyer-reply.ts (pure, regex-only, tested) sorts
// each new reply into buyer_interest / buyer_question / buyer_pass. Every
// classification gets: a verbatim block appended to the LISTING's
// Verification_Notes (dossier parity with every other inbound channel),
// Last_Response_At + a one-line Buyer_Notes append on the BUYER row, and an
// audit row. Only buyer_interest additionally gets a structured
// "[DISPO BUYER INTEREST ...]" note line and a tier_2_urgent ACT NOW alert
// to the operator (lib/reply-alert.sendBuyerReplyAlert).
//
// NEVER sends anything to a buyer. Read/route/alert only — buyer email
// auto-replies are a later, gated step (operator rule: buyer SMS is Tier C;
// buyer email is further out still).
//
// GATED DARK: behind INBOUND_CAPTURE_LIVE (default OFF), same flag
// gmail-sync uses — this is an inbound-capture write path, just buyer-
// scoped. OFF => returns immediately, writes nothing.

import { NextResponse } from "next/server";
import { getListing, updateListingRecord } from "@/lib/airtable";
import { listBuyersWithDispoBlastThread, updateBuyerV2, BUYER_V2_FIELDS } from "@/lib/buyers-v2";
import { getThreadById } from "@/lib/gmail";
import { extractCitedGmailIds } from "@/lib/inbound/gmail-capture";
import { extractEmailAddress } from "@/lib/inbound/match";
import {
  classifyBuyerReply,
  isDispoBlastSubject,
  formatListingReplyNoteBlock,
  formatBuyerInterestLine,
  formatBuyerNoteLine,
} from "@/lib/dispo/buyer-reply";
import { dealPageUrl } from "@/lib/dispo/blast-email";
import { sendBuyerReplyAlert } from "@/lib/reply-alert";
import { isInboundCaptureLive } from "@/lib/inbound/flag";
import { audit } from "@/lib/audit-log";
import {
  authenticate,
  readAuthEnv,
  readAuthHeaders,
} from "@/lib/maverick/oauth/auth-waterfall";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";

export const runtime = "nodejs";
export const maxDuration = 120;

const BASE_URL = () => process.env.DASHBOARD_BASE_URL || "https://coach-pulse-ten.vercel.app";
const DEFAULT_LIMIT = 50;

interface BuyerOutcome {
  buyerId: string;
  buyerEmail: string | null;
  listingId: string | null;
  threadId: string | null;
  newReplies: number;
  classifications: string[];
  alertSent: boolean;
  outcome: "ingested" | "no_new_replies" | "skipped_missing_link" | "listing_not_found" | "error";
  detail?: string;
}

export async function GET(req: Request) {
  const t0 = Date.now();
  const env = readAuthEnv();
  const headers = readAuthHeaders(req);
  const auth = await authenticate(headers, env, kvProd);
  if (!auth.ok) return NextResponse.json({ error: "unauthorized", reason: auth.reason }, { status: 401 });
  if (auth.kind !== "cron" && auth.kind !== "oauth") {
    return NextResponse.json({ error: "unauthorized", reason: "unsupported_auth_kind" }, { status: 401 });
  }
  if (auth.kind === "oauth" && !kvConfigured()) {
    return NextResponse.json({ error: "kv_not_configured" }, { status: 500 });
  }

  // WATCHED-FIRST: same discipline as gmail-sync — this cron writes inbound
  // buyer content into Airtable, gated behind the same switch.
  if (!isInboundCaptureLive()) {
    return NextResponse.json({ ok: true, watched: true, reason: "INBOUND_CAPTURE_LIVE not set — no writes" });
  }

  const url = new URL(req.url);
  const limit = Math.max(1, Math.min(200, parseInt(url.searchParams.get("limit") ?? String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT));
  const onlyBuyerId = url.searchParams.get("buyer_id");
  const dryRun = url.searchParams.get("dry_run") === "1";

  let buyers;
  try {
    buyers = await listBuyersWithDispoBlastThread();
  } catch (err) {
    return NextResponse.json({ ok: false, error: "buyers_fetch_failed", message: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
  if (onlyBuyerId) buyers = buyers.filter((b) => b.id === onlyBuyerId);
  buyers = buyers.slice(0, limit);

  const outcomes: BuyerOutcome[] = [];
  let totalIngested = 0;
  let totalAlerts = 0;

  for (const buyer of buyers) {
    const threadId = buyer.dispoBlastThreadId;
    const listingId = buyer.dispoBlastListingId;
    const buyerEmail = buyer.email;
    const out: BuyerOutcome = {
      buyerId: buyer.id,
      buyerEmail,
      listingId,
      threadId,
      newReplies: 0,
      classifications: [],
      alertSent: false,
      outcome: "error",
    };
    outcomes.push(out);

    if (!threadId || !listingId || !buyerEmail) {
      out.outcome = "skipped_missing_link";
      continue;
    }

    try {
      const listing = await getListing(listingId);
      if (!listing) {
        out.outcome = "listing_not_found";
        continue;
      }

      const messages = await getThreadById(threadId);
      const wantEmail = extractEmailAddress(buyerEmail);
      const cited = extractCitedGmailIds(listing.notes);

      const newMessages = messages
        .filter((m) => extractEmailAddress(m.from) === wantEmail)
        .filter((m) => isDispoBlastSubject(m.subject))
        .filter((m) => !cited.has(m.id))
        .sort((a, b) => Date.parse(a.date) - Date.parse(b.date));

      if (newMessages.length === 0) {
        out.outcome = "no_new_replies";
        continue;
      }

      const nowIso = new Date().toISOString();
      const listingBlocks: string[] = [];
      const buyerNoteLines: string[] = [];
      let interestForAlert: { amountUsd: number | null } | null = null;
      let newestDate = buyer.lastResponseAt ?? "";

      for (const m of newMessages) {
        const cls = classifyBuyerReply(m.body, listing.assignmentPrice ?? null);
        out.classifications.push(cls.classification);

        listingBlocks.push(
          formatListingReplyNoteBlock({
            msgId: m.id,
            threadId: m.threadId,
            date: m.date,
            buyerName: buyer.name,
            buyerEmail,
            classification: cls.classification,
            amountUsd: cls.amountUsd,
            body: m.body,
            ingestedAt: nowIso,
          }),
        );
        if (cls.classification === "buyer_interest") {
          listingBlocks.push(
            formatBuyerInterestLine({
              buyerName: buyer.name,
              buyerEmail,
              amountUsd: cls.amountUsd,
              body: m.body,
              nowIso,
            }),
          );
          // Alert on the LATEST interest message in this batch — one ping,
          // not one per historical message on a first sweep.
          interestForAlert = { amountUsd: cls.amountUsd };
        }
        buyerNoteLines.push(
          formatBuyerNoteLine({
            classification: cls.classification,
            amountUsd: cls.amountUsd,
            address: listing.address,
            nowIso: m.date || nowIso,
          }),
        );
        if (!newestDate || Date.parse(m.date) > Date.parse(newestDate)) newestDate = m.date;

        await audit({
          agent: "scout",
          event: "dispo_buyer_reply_ingested",
          status: "confirmed_success",
          recordId: listingId,
          externalId: m.id,
          inputSummary: { buyerId: buyer.id, buyerEmail, threadId },
          outputSummary: { classification: cls.classification, amountUsd: cls.amountUsd, reason: cls.reason },
          decision: cls.classification,
        });
      }

      out.newReplies = newMessages.length;
      totalIngested += newMessages.length;

      if (!dryRun) {
        const existingListingNotes = listing.notes ?? "";
        const sep = existingListingNotes.trim().length > 0 ? "\n\n" : "";
        await updateListingRecord(listingId, {
          Verification_Notes: `${existingListingNotes}${sep}${listingBlocks.join("\n\n")}`,
        });

        const existingBuyerNotes = buyer.buyerNotes ?? "";
        const bsep = existingBuyerNotes.trim().length > 0 ? "\n" : "";
        await updateBuyerV2(buyer.id, {
          [BUYER_V2_FIELDS.Last_Response_At]: newestDate || nowIso,
          [BUYER_V2_FIELDS.Buyer_Notes]: `${existingBuyerNotes}${bsep}${buyerNoteLines.join("\n")}`,
        });

        if (interestForAlert) {
          const res = await sendBuyerReplyAlert({
            recordId: listingId,
            address: listing.address,
            buyerName: buyer.name,
            amountUsd: interestForAlert.amountUsd,
            dealUrl: dealPageUrl(BASE_URL(), listingId),
          });
          out.alertSent = res.sent;
          if (res.sent) totalAlerts++;
        }
      }

      out.outcome = "ingested";
    } catch (err) {
      out.outcome = "error";
      out.detail = err instanceof Error ? err.message : String(err);
      console.error(`[dispo-buyer-replies] ${buyer.id}:`, err);
    }
  }

  const summary = {
    buyers_polled: buyers.length,
    replies_ingested: totalIngested,
    alerts_sent: totalAlerts,
    errors: outcomes.filter((o) => o.outcome === "error").length,
    duration_ms: Date.now() - t0,
  };
  console.log("[dispo_buyer_replies]", JSON.stringify(summary).slice(0, 500));
  await audit({
    agent: "scout",
    event: "dispo_buyer_replies_sweep",
    status: "confirmed_success",
    inputSummary: { limit, auth_kind: auth.kind, dry_run: dryRun },
    outputSummary: summary,
  });

  return NextResponse.json({ ok: true, dry_run: dryRun, summary, outcomes });
}
