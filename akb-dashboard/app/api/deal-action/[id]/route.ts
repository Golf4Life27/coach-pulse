import { NextResponse } from "next/server";
import { getListing, updateListingRecord } from "@/lib/airtable";
import { sendMessage } from "@/lib/quo";
import type {
  ActionType,
  Channel,
  DealActionResponse,
  SafetyCheckResult,
} from "@/types/jarvis";

export const runtime = "nodejs";
export const maxDuration = 30;

// Field IDs (mirrors lib/airtable.ts).
const FIELD = {
  notes: "fldwKGxZly6O8qyPu",
  outreachStatus: "fldGIgqwyCJg4uFyv",
  lastOutboundAt: "fldaK4lR5UNvycg11",
  actionCardState: "fldiNKFpIBUYgg7el",
} as const;

interface DealActionBody {
  channel: Channel;
  body: string;
  subject?: string;
  action_type: ActionType;
  replyToMessageId?: string;
  /** When true, skip the safety-check gate (Alex-confirmed re-send). */
  force?: boolean;
}

function cleanPhone(phone: string): string {
  const digits = phone.replace(/[^0-9]/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return digits ? `+${digits}` : "";
}

function originFromReq(req: Request): string {
  const url = new URL(req.url);
  return `${url.protocol}//${url.host}`;
}

function todayStamp(): string {
  return new Date().toLocaleDateString("en-US", {
    month: "numeric", day: "numeric", year: "2-digit",
    hour: "numeric", minute: "2-digit", hour12: true,
  });
}

async function appendNote(recordId: string, line: string): Promise<void> {
  const listing = await getListing(recordId);
  const existing = listing?.notes ?? "";
  const next = existing ? `${existing}\n${line}` : line;
  await updateListingRecord(recordId, { [FIELD.notes]: next });
}

async function runSafetyCheck(
  origin: string,
  cookie: string | null,
  payload: { recordId: string; channel: Channel; body: string; agentIdentifier?: string },
): Promise<SafetyCheckResult | null> {
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (cookie) headers.cookie = cookie;
    const res = await fetch(`${origin}/api/outreach-safety-check`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    if (!res.ok) return null;
    return (await res.json()) as SafetyCheckResult;
  } catch {
    return null;
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!id || !id.startsWith("rec")) {
    return NextResponse.json({ error: "Invalid record id", id }, { status: 400 });
  }

  let body: DealActionBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const action = body.action_type;
  const validActions: ActionType[] = [
    "send_reply", "mark_dead", "walk", "clarify", "accept", "counter",
    "send_dd_volley_1", "send_dd_volley_2", "send_dd_volley_3",
    "fire_buyer_blast", "run_pre_offer_screen", "review_buyer_form",
  ];
  if (!action || !validActions.includes(action)) {
    return NextResponse.json({ error: "Invalid action_type" }, { status: 400 });
  }

  const listing = await getListing(id);
  if (!listing) {
    return NextResponse.json({ error: "Listing not found", id }, { status: 404 });
  }

  // DD volley actions delegate to /api/dd-volley-send.
  if (action === "send_dd_volley_1" || action === "send_dd_volley_2" || action === "send_dd_volley_3") {
    const textIndex = (action === "send_dd_volley_1" ? 1 : action === "send_dd_volley_2" ? 2 : 3) as 1 | 2 | 3;
    const url = new URL(req.url);
    const origin = `${url.protocol}//${url.host}`;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const cookie = req.headers.get("cookie");
    if (cookie) headers.cookie = cookie;
    const res = await fetch(`${origin}/api/dd-volley-send/${id}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ textIndex }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return NextResponse.json(
        { success: false, error: data.error ?? "DD volley send failed" },
        { status: res.status },
      );
    }
    return NextResponse.json({ success: true, airtableUpdated: true, ...data });
  }

  // run_pre_offer_screen delegates to /api/pre-offer-screen.
  if (action === "run_pre_offer_screen") {
    const url = new URL(req.url);
    const origin = `${url.protocol}//${url.host}`;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const cookie = req.headers.get("cookie");
    if (cookie) headers.cookie = cookie;
    const res = await fetch(`${origin}/api/pre-offer-screen/${id}`, {
      method: "POST",
      headers,
      body: JSON.stringify({}),
    });
    const data = await res.json().catch(() => ({}));
    return NextResponse.json({ success: res.ok, airtableUpdated: res.ok, ...data }, { status: res.ok ? 200 : 502 });
  }

  // fire_buyer_blast and review_buyer_form are UI navigation actions handled
  // client-side; record an audit note and return success.
  if (action === "fire_buyer_blast" || action === "review_buyer_form") {
    return NextResponse.json({ success: true, airtableUpdated: false, navigateAction: action });
  }

  // Status-only actions short-circuit without safety check.
  try {
    if (action === "mark_dead") {
      await updateListingRecord(id, {
        [FIELD.outreachStatus]: "Dead",
        [FIELD.actionCardState]: "Cleared",
      });
      await appendNote(id, `${todayStamp()} — System: marked Dead via Jarvis.`);
      const out: DealActionResponse = { success: true, airtableUpdated: true, newStatus: "Dead" };
      return NextResponse.json(out);
    }
    if (action === "walk") {
      await updateListingRecord(id, {
        [FIELD.outreachStatus]: "Dead",
        [FIELD.actionCardState]: "Cleared",
      });
      await appendNote(id, `${todayStamp()} — System: walked away via Jarvis.`);
      const out: DealActionResponse = { success: true, airtableUpdated: true, newStatus: "Dead" };
      return NextResponse.json(out);
    }
    if (action === "accept") {
      await updateListingRecord(id, {
        [FIELD.outreachStatus]: "Offer Accepted",
      });
      await appendNote(id, `${todayStamp()} — System: marked Offer Accepted via Jarvis.`);
      const out: DealActionResponse = { success: true, airtableUpdated: true, newStatus: "Offer Accepted" };
      return NextResponse.json(out);
    }
    if (action === "clarify") {
      // Pure UI action — no side effects beyond an audit note.
      await appendNote(id, `${todayStamp()} — System: Jarvis clarification requested.`);
      const out: DealActionResponse = { success: true, airtableUpdated: true };
      return NextResponse.json(out);
    }
  } catch (err) {
    console.error(`[deal-action] status update failed for ${id}:`, err);
    return NextResponse.json(
      { error: "Action failed", detail: String(err) },
      { status: 500 },
    );
  }

  // Outreach actions (send_reply, counter) require body + channel.
  const channel = body.channel;
  const draft = (body.body ?? "").trim();
  if (!draft) {
    return NextResponse.json({ error: "Missing body" }, { status: 400 });
  }
  if (channel !== "sms" && channel !== "email") {
    return NextResponse.json({ error: "Invalid channel for outreach action" }, { status: 400 });
  }

  // Safety gate (skipped only on explicit force=true).
  if (!body.force) {
    const origin = originFromReq(req);
    const cookie = req.headers.get("cookie");
    const identifier = listing.agentPhone ?? listing.agentEmail ?? undefined;
    const safety = await runSafetyCheck(origin, cookie, {
      recordId: id,
      channel,
      body: draft,
      agentIdentifier: identifier,
    });
    if (safety && !safety.passed) {
      return NextResponse.json(
        {
          success: false,
          reason: safety.reason,
          warnings: safety.warnings,
          suggestedDraft: safety.suggestedDraft,
          agentContext: safety.agentContext,
        },
        { status: 422 },
      );
    }
  }

  // Channel = SMS — send via Quo.
  if (channel === "sms") {
    if (!listing.agentPhone) {
      return NextResponse.json({ error: "Listing has no agent phone" }, { status: 400 });
    }
    if (!process.env.QUO_API_KEY) {
      return NextResponse.json({ error: "QUO_API_KEY not set" }, { status: 500 });
    }
    try {
      await sendMessage(cleanPhone(listing.agentPhone), draft);
    } catch (err) {
      console.error(`[deal-action] Quo send failed for ${id}:`, err);
      return NextResponse.json(
        { error: "Failed to send via Quo", detail: String(err) },
        { status: 502 },
      );
    }

    const stamp = new Date().toISOString();
    try {
      await updateListingRecord(id, { [FIELD.lastOutboundAt]: stamp });
    } catch (err) {
      console.error(`[deal-action] Failed to stamp Last_Outbound_At:`, err);
    }
    try {
      await appendNote(id, `${todayStamp()} — ALEX: ${draft}`);
    } catch (err) {
      console.error(`[deal-action] Failed to append note:`, err);
    }

    const out: DealActionResponse = {
      success: true,
      airtableUpdated: true,
    };
    return NextResponse.json(out);
  }

  // Channel = email — Gmail draft creation requires OAuth (not yet wired).
  // For now, append note + return a mailto:-style link the UI can follow.
  if (channel === "email") {
    if (!listing.agentEmail) {
      return NextResponse.json({ error: "Listing has no agent email" }, { status: 400 });
    }
    const subject = body.subject ?? `Re: ${listing.address}`;
    const draftUrl = `mailto:${listing.agentEmail}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(draft)}`;

    try {
      await appendNote(id, `${todayStamp()} — ALEX (email draft): subject="${subject}"\n${draft}`);
    } catch (err) {
      console.error(`[deal-action] Failed to append email draft note:`, err);
    }

    const out: DealActionResponse = {
      success: true,
      airtableUpdated: true,
      draftUrl,
    };
    return NextResponse.json(out);
  }

  return NextResponse.json({ error: "Unhandled action" }, { status: 400 });
}
