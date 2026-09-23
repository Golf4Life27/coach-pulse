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
// NEVER sends anything to a buyer on THIS loop (the dispo-blast reply loop,
// above). Read/route/alert only — buyer email auto-replies for a BLAST
// reply are a later, gated step (operator rule: buyer SMS is Tier C; buyer
// email is further out still).
//
// EXCEPTION, narrower loop below (2026-09-23, Spine recgpvLksvIVzgB2h,
// operator verbatim: "yes on the revised auto reply"): the buy-box DRIP
// reply loop further down this file DOES send — exactly one templated
// thank-you, only when the reply captured a box, only once per buyer ever.
// See lib/buyers/box-ack.ts. Every other genuine drip reply still never
// sends anything; it gets an operator card instead. This carve-out is
// scoped to the drip loop only — it changes nothing about the blast loop
// above.
//
// GATED DARK: behind INBOUND_CAPTURE_LIVE (default OFF), same flag
// gmail-sync uses — this is an inbound-capture write path, just buyer-
// scoped. OFF => returns immediately, writes nothing.

import { NextResponse } from "next/server";
import { getListing, updateListingRecord } from "@/lib/airtable";
import {
  listBuyersWithDispoBlastThread,
  listBuyersWithBoxDripThread,
  updateBuyerV2,
  BUYER_V2_FIELDS,
} from "@/lib/buyers-v2";
import type { BuyerRecord } from "@/types/jarvis";
import { getThreadById, getThreadByIdResult } from "@/lib/gmail";
import { extractCitedGmailIds } from "@/lib/inbound/gmail-capture";
import { extractEmailAddress } from "@/lib/inbound/match";
import {
  classifyBuyerReply,
  isDispoBlastSubject,
  isOptOutReply,
  formatListingReplyNoteBlock,
  formatBuyerInterestLine,
  formatBuyerNoteLine,
  classifyDripThreadMessages,
  formatDripBounceNoteLine,
  captureBuyBoxFromReply,
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
import { isDoNotContact, hasUsableEmail } from "@/lib/buyers/box-drip";
import { shouldSendBoxAck, composeBoxAckEmail, buildBoxAckCard } from "@/lib/buyers/box-ack";
import { upsertOperatorActions } from "@/lib/maverick/operator-actions";
import { sendEmail } from "@/lib/gmail";

export const runtime = "nodejs";
export const maxDuration = 120;

const BASE_URL = () => process.env.DASHBOARD_BASE_URL || "https://coach-pulse-ten.vercel.app";
const DEFAULT_LIMIT = 50;

// Pacing between sequential threads.get calls on the SAME OAuth token
// (2026-09-22: ~45 buyers fetched back-to-back tripped Gmail's per-user
// rate limit mid-run — mostly 403s with a few 200s interleaved). At
// DEFAULT_LIMIT=50 this adds well under 10s to a run inside the 120s
// maxDuration; lib/gmail.ts also retries a rate-limited fetch itself, this
// just makes hitting the limit less likely in the first place.
const THREAD_FETCH_PACING_MS = 120;
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Buy-box ack (2026-09-23, Spine recgpvLksvIVzgB2h) — per-run send cap.
const ACK_SEND_CAP = 30;

/** Short, stable code for a failed ack send — NEVER the raw Gmail error
 *  string, which can carry response body text. Only the HTTP status (or
 *  "unknown") survives into the audit row / outcome. */
function ackSendErrorCode(error: string | undefined): string {
  const m = /Gmail send (\d+)/.exec(error ?? "");
  return m ? `gmail_${m[1]}` : "send_failed";
}

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
  /** Drip loop only — every message the thread fetch returned (before any
   *  filtering), so a dry run can tell "the fetch failed", "the thread is
   *  genuinely empty", and "we filtered everything out" apart from each
   *  other. Sender addresses only, never bodies. */
  threadMessageCount?: number;
  threadSenders?: string[];
  /** Drip loop only (2026-09-23, Spine recgpvLksvIVzgB2h) — what the buy-box
   *  ack gate decided for this buyer's genuine reply(ies) this run, or
   *  undefined when no genuine reply fired the gate at all (bounce-only /
   *  opt-out-only / no new replies / blast-loop rows). */
  ack?: "sent" | "would_send" | "card" | `skipped:${string}` | `failed:${string}`;
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
      await sleep(THREAD_FETCH_PACING_MS);
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

  // ── Buy-box drip STOP handling (2026-09-18) ──────────────────────────
  // Separate population, separate thread key (Box_Drip_Thread_Id), no
  // listing to write into — the drip is buyer-only. Same idempotency
  // discipline (extractCitedGmailIds), dedupe source is the BUYER's own
  // Notes field instead of a listing's Verification_Notes. Never alerts.
  // Kept fully separate from the blast loop above so that path's behavior
  // is untouched.
  //
  // BUY-BOX ACK (2026-09-23, Spine recgpvLksvIVzgB2h) — the one exception to
  // "never sends": in the SAME pass that ingests a genuine reply here, a
  // captured box gets exactly one templated thank-you (lib/buyers/box-ack.ts,
  // shouldSendBoxAck/composeBoxAckEmail); anything else gets an operator
  // card via lib/maverick/operator-actions.upsertOperatorActions, no send.
  // See the file-header comment above for the full scope.
  let dripBuyers: BuyerRecord[];
  try {
    dripBuyers = await listBuyersWithBoxDripThread();
  } catch (err) {
    console.error("[dispo-buyer-replies] drip buyers fetch failed:", err instanceof Error ? err.message : String(err));
    dripBuyers = [];
  }
  if (onlyBuyerId) dripBuyers = dripBuyers.filter((b) => b.id === onlyBuyerId);
  dripBuyers = dripBuyers.slice(0, limit);

  let totalDripReplies = 0;
  let totalOptOuts = 0;
  let ackSendCount = 0;
  let totalAcksSent = 0;
  let totalAckCards = 0;
  const killSwitchOn = process.env.BUYER_AUTO_REPLY_DISABLE === "1";

  for (const buyer of dripBuyers) {
    const threadId = buyer.boxDripThreadId;
    const buyerEmail = buyer.email;
    const out: BuyerOutcome = {
      buyerId: buyer.id,
      buyerEmail,
      listingId: null,
      threadId,
      newReplies: 0,
      classifications: [],
      alertSent: false,
      outcome: "error",
    };
    outcomes.push(out);

    if (!threadId || !buyerEmail) {
      out.outcome = "skipped_missing_link";
      continue;
    }

    try {
      // Result-returning fetch (2026-09-22 bug hunt) — a failed fetch must
      // be visible as "error", never silently identical to "no replies"
      // (the Julius Florendo / Jacob Horn miss: the reply WAS on the
      // thread, but a swallowed fetch failure and a genuinely empty thread
      // both came back as []).
      const threadResult = await getThreadByIdResult(threadId);
      await sleep(THREAD_FETCH_PACING_MS);
      out.threadMessageCount = threadResult.messages.length;
      out.threadSenders = Array.from(new Set(threadResult.messages.map((m) => extractEmailAddress(m.from))));

      if (threadResult.error) {
        out.outcome = "error";
        out.detail = `gmail_thread_fetch_${threadResult.status ?? "unknown"}`;
        continue;
      }

      const cited = extractCitedGmailIds(buyer.notes);
      // Robust matching (2026-09-22): a message counts as a buyer reply
      // when it isn't OUR send (derived from the thread itself, never a
      // hardcoded address) and isn't a mail-system notice — the buyer's
      // own From==email match still applies, it's just no longer required.
      const { bounces, replies } = classifyDripThreadMessages(threadResult.messages, cited);
      const bounceIds = new Set(bounces.map((m) => m.id));
      const newMessages = [...bounces, ...replies].sort((a, b) => Date.parse(a.date) - Date.parse(b.date));

      if (newMessages.length === 0) {
        out.outcome = "no_new_replies";
        continue;
      }

      const nowIso = new Date().toISOString();
      const noteLines: string[] = [];
      let optedOut = false;
      const capturedZips: string[] = [];
      let capturedMaxPrice: number | null = null;

      for (const m of newMessages) {
        if (bounceIds.has(m.id)) {
          out.classifications.push("bounce");
          noteLines.push(formatDripBounceNoteLine({ dateIso: nowIso, buyerEmail }));
          noteLines.push(`[Gmail inbound msg ${m.id} thread=${m.threadId} ts=${m.date} src=box_drip_bounce ingested_at=${nowIso}]`);
          await audit({
            agent: "scout",
            event: "buyer_drip_bounce",
            status: "confirmed_success",
            recordId: buyer.id,
            externalId: m.id,
            inputSummary: { buyerId: buyer.id, threadId },
            decision: "bounced",
          });
          continue;
        }

        const stop = isOptOutReply(m.body);
        out.classifications.push(stop ? "opt_out" : "reply");

        if (stop) {
          optedOut = true;
          noteLines.push(`[${nowIso.slice(0, 10)}] Opted out via drip reply`);
        } else {
          noteLines.push(`[drip reply ${m.id}] ${m.body.trim().slice(0, 500)}`);
          const capture = captureBuyBoxFromReply(m.body);
          capturedZips.push(...capture.zips);
          if (capture.maxPriceUsd != null && capturedMaxPrice == null) capturedMaxPrice = capture.maxPriceUsd;
        }
        // Dedupe marker — extractCitedGmailIds only recognizes this exact
        // form (lib/inbound/gmail-capture.ts), so every processed message
        // (opt-out or not) gets one, or the next sweep re-ingests it.
        noteLines.push(`[Gmail inbound msg ${m.id} thread=${m.threadId} ts=${m.date} src=box_drip_reply ingested_at=${nowIso}]`);

        await audit({
          agent: "scout",
          event: stop ? "buyer_drip_opt_out" : "buyer_drip_reply",
          status: "confirmed_success",
          recordId: buyer.id,
          externalId: m.id,
          inputSummary: { buyerId: buyer.id, threadId },
          decision: stop ? "opted_out" : "logged",
        });
      }

      out.newReplies = newMessages.length;
      totalDripReplies += newMessages.length;
      if (optedOut) totalOptOuts++;

      // Conservative structured capture (task 7) — only fills a field that
      // is currently empty; never overwrites what's on file. Computed here
      // (not inside the `!dryRun` write gate below) because the buy-box ack
      // decision needs to know whether a box was captured even on a dry run.
      const dedupedZips = Array.from(new Set(capturedZips));
      const wouldWriteZips = !buyer.targetZips && dedupedZips.length > 0;
      const wouldWriteMaxPrice = (buyer.maxPrice == null || buyer.maxPrice === 0) && capturedMaxPrice != null;
      const boxCaptured = wouldWriteZips || wouldWriteMaxPrice;

      // ── Buy-box ack (2026-09-23, Spine recgpvLksvIVzgB2h, operator
      // verbatim: "yes on the revised auto reply") — decided BEFORE the
      // Buyer_Notes write below so a successful send's `[box_ack_sent ...]`
      // marker lands in the SAME updateBuyerV2 call as the reply ingestion
      // (spec item 5: "same updateBuyerV2 path"). Only fires when this run
      // actually saw a genuine (non-bounce, non-opt-out) reply, and never
      // for a buyer this run just opted out.
      const hasGenuineReply = out.classifications.includes("reply");
      let ackMarkerLine: string | null = null;

      if (hasGenuineReply && !optedOut) {
        const alreadyAcked = (buyer.notes ?? "").includes("[box_ack_sent ");
        const decision = shouldSendBoxAck({
          boxCaptured,
          alreadyAcked,
          doNotContact: isDoNotContact(buyer),
          hasUsableEmail: hasUsableEmail(buyer.email),
          killSwitchOn,
          capReached: ackSendCount >= ACK_SEND_CAP,
        });

        if (decision.action === "skip") {
          out.ack = `skipped:${decision.reason}`;
        } else if (decision.action === "card") {
          out.ack = "card";
          if (!dryRun) {
            // Excerpt from the LATEST genuine reply this run — mirrors the
            // dispo-blast loop's "alert on the latest interest message"
            // rule above (one card, not one per historical message).
            const lastReply = [...replies]
              .filter((m) => !isOptOutReply(m.body))
              .sort((a, b) => Date.parse(a.date) - Date.parse(b.date))
              .pop();
            const card = buildBoxAckCard({
              buyerId: buyer.id,
              buyerName: buyer.name,
              replyBody: lastReply?.body ?? "",
              threadId,
              nowIso,
            });
            if (kvConfigured()) {
              try {
                await upsertOperatorActions(kvProd, [card]);
                totalAckCards++;
                await audit({
                  agent: "scout",
                  event: "buyer_box_ack_card_posted",
                  status: "confirmed_success",
                  recordId: buyer.id,
                  inputSummary: { buyerId: buyer.id, threadId },
                  decision: "card",
                });
              } catch (err) {
                console.error(`[dispo-buyer-replies] box-ack card write failed for ${buyer.id}:`, err instanceof Error ? err.message : String(err));
              }
            } else {
              console.error(`[dispo-buyer-replies] box-ack card skipped for ${buyer.id}: kv_not_configured`);
            }
          }
        } else {
          // decision.action === "send"
          if (dryRun) {
            out.ack = "would_send";
          } else {
            ackSendCount++;
            const sortedThread = [...threadResult.messages].sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
            const originalSubject = sortedThread[0]?.subject ?? null;
            const lastReply = [...replies]
              .filter((m) => !isOptOutReply(m.body))
              .sort((a, b) => Date.parse(a.date) - Date.parse(b.date))
              .pop();
            const { subject, body } = composeBoxAckEmail({ buyerName: buyer.name, originalSubject });
            try {
              // Reply to whoever actually wrote on the thread — the record's
              // email can differ from the replying address (e.g. an intake
              // form that updated the email after the drip went out).
              const replyTo = extractEmailAddress(lastReply?.from ?? "") || buyerEmail;
              const res = await sendEmail({
                to: replyTo,
                subject,
                body,
                threadId,
                inReplyTo: lastReply?.messageIdHeader || undefined,
                references: lastReply?.messageIdHeader || undefined,
              });
              if (!res.success) throw new Error(res.error ?? "send_failed");
              out.ack = "sent";
              totalAcksSent++;
              ackMarkerLine = `[box_ack_sent ${nowIso} gmail:${res.messageId ?? "unknown"}]`;
              await audit({
                agent: "crier",
                event: "buyer_box_ack_sent",
                status: "confirmed_success",
                recordId: buyer.id,
                externalId: res.messageId,
                inputSummary: { buyerId: buyer.id, threadId },
                decision: "sent",
              });
            } catch (err) {
              const code = ackSendErrorCode(err instanceof Error ? err.message : undefined);
              out.ack = `failed:${code}`;
              await audit({
                agent: "crier",
                event: "buyer_box_ack_failed",
                status: "confirmed_failure",
                recordId: buyer.id,
                inputSummary: { buyerId: buyer.id, threadId },
                error: code,
              });
            }
          }
        }
      }

      if (!dryRun) {
        const existingNotes = buyer.notes ?? "";
        const sep = existingNotes.trim().length > 0 ? "\n" : "";
        const allNoteLines = ackMarkerLine ? [...noteLines, ackMarkerLine] : noteLines;
        const fields: Record<string, unknown> = {
          [BUYER_V2_FIELDS.Notes]: `${existingNotes}${sep}${allNoteLines.join("\n")}`,
        };
        if (optedOut) {
          fields[BUYER_V2_FIELDS.Status] = "Opted_Out";
          // Buyer_Status is the OTHER status column on the physical table
          // (Active/Warm/Inactive/Do Not Contact) — box-drip.ts and
          // matchPricingBuyer both check it, so an opt-out has to land on
          // both columns or a later sweep can still contact this buyer.
          fields[BUYER_V2_FIELDS.Buyer_Status] = "Do Not Contact";
        }
        // A bounce, an opt-out, or a genuine reply all mean the drip is
        // done firing on this buyer (2026-09-22: previously only opt-out
        // stopped it — a buyer who already answered kept getting follow-ups,
        // e.g. Clarance's step-2 follow-up scheduled after their 9/21 reply).
        fields[BUYER_V2_FIELDS.Box_Drip_Step] = 3;

        if (wouldWriteZips) {
          fields[BUYER_V2_FIELDS.Target_ZIPs] = dedupedZips.join(", ");
        }
        if (wouldWriteMaxPrice) {
          fields[BUYER_V2_FIELDS.Max_Price] = capturedMaxPrice;
        }

        await updateBuyerV2(buyer.id, fields);
      }

      out.outcome = "ingested";
    } catch (err) {
      out.outcome = "error";
      out.detail = err instanceof Error ? err.message : String(err);
      console.error(`[dispo-buyer-replies] drip ${buyer.id}:`, err);
    }
  }

  const summary = {
    buyers_polled: buyers.length,
    replies_ingested: totalIngested,
    alerts_sent: totalAlerts,
    drip_buyers_polled: dripBuyers.length,
    drip_replies_ingested: totalDripReplies,
    drip_opt_outs: totalOptOuts,
    box_acks_sent: totalAcksSent,
    box_ack_cards_posted: totalAckCards,
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
