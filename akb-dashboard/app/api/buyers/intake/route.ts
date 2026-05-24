import { NextResponse } from "next/server";
import { findBuyerByEmail, createBuyerV2, updateBuyerV2, BUYER_V2_FIELDS } from "@/lib/buyers-v2";
import { sendEmail, type GmailSendResult } from "@/lib/gmail";

export const runtime = "nodejs";
export const maxDuration = 30;

interface IntakeBody {
  name: string;
  email: string;
  entity?: string;
  phone?: string;
  markets?: string[];
  targetZips?: string;
  minPrice?: number;
  maxPrice?: number;
  minBeds?: number;
  propertyTypePreference?: string[];
  buyerType?: string;
  volumePerYear?: number;
  notes?: string;
}

function valid(body: unknown): body is IntakeBody {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  return typeof b.name === "string" && b.name.trim().length > 0
    && typeof b.email === "string" && /\S+@\S+\.\S+/.test(b.email);
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!valid(body)) {
    return NextResponse.json({ error: "Missing or invalid name/email" }, { status: 400 });
  }
  const input: IntakeBody = body;
  const nowIso = new Date().toISOString();

  const fields: Record<string, unknown> = {
    [BUYER_V2_FIELDS.Name]: input.name.trim(),
    [BUYER_V2_FIELDS.Email]: input.email.trim().toLowerCase(),
    [BUYER_V2_FIELDS.Entity]: input.entity ?? null,
    [BUYER_V2_FIELDS.Phone_Primary]: input.phone ?? null,
    [BUYER_V2_FIELDS.Markets]: input.markets && input.markets.length ? input.markets : null,
    [BUYER_V2_FIELDS.Target_ZIPs]: input.targetZips ?? null,
    [BUYER_V2_FIELDS.Min_Price]: input.minPrice ?? null,
    [BUYER_V2_FIELDS.Max_Price]: input.maxPrice ?? null,
    [BUYER_V2_FIELDS.Min_Beds]: input.minBeds ?? null,
    [BUYER_V2_FIELDS.Property_Type_Preference]: input.propertyTypePreference ?? null,
    [BUYER_V2_FIELDS.Buyer_Type]: input.buyerType ?? "unknown",
    [BUYER_V2_FIELDS.Linked_Deal_Count]: input.volumePerYear ?? null,
    [BUYER_V2_FIELDS.Source]: "Inbound Form",
    [BUYER_V2_FIELDS.Status]: "Form Completed",
    [BUYER_V2_FIELDS.Form_Completed_At]: nowIso,
    [BUYER_V2_FIELDS.Last_Engagement_At]: nowIso,
    [BUYER_V2_FIELDS.Notes]: input.notes ?? null,
  };

  let buyerId: string;
  try {
    const existing = await findBuyerByEmail(input.email);
    if (existing) {
      await updateBuyerV2(existing.id, fields);
      buyerId = existing.id;
    } else {
      buyerId = await createBuyerV2(fields);
    }
  } catch (err) {
    console.error("[buyers/intake] Airtable error:", err);
    return NextResponse.json({ error: "Failed to save", detail: String(err) }, { status: 502 });
  }

  // Confirmation email + Alex notification — both best-effort. The
  // buyer record is what we're committing to in this endpoint; emails
  // are a side effect. But "best-effort" doesn't mean "invisible" —
  // sendEmail now audit-logs its own result with three-state status,
  // and we surface email_status to the caller so Make.com / form
  // backend can see what actually happened. Per the Positive
  // Confirmation Principle: 2xx is not the whole truth.
  //
  // Pattern note (5/13): replaces void sendEmail(...).catch(() => {})
  // which discarded the result entirely — exactly the swallow pattern
  // the principle exists to catch. Side-effect failures stay
  // non-fatal but become observable.
  async function safeSend(opts: Parameters<typeof sendEmail>[0]): Promise<GmailSendResult> {
    try {
      return await sendEmail(opts);
    } catch (err) {
      return {
        success: false,
        audit_status: "confirmed_failure",
        error: `sendEmail threw: ${String(err)}`,
      };
    }
  }

  const buyerEmailResult = await safeSend({
    to: input.email,
    subject: "Thanks — you're on the AKB buyer list",
    body: `Hi ${input.name.split(" ")[0] || "there"},\n\nThanks for filling out the AKB buyer form. We'll send deals matching your criteria as they come up.\n\n— Alex / AKB Solutions / (815) 556-9965`,
  });

  const alexEmail = process.env.ALEX_NOTIFY_EMAIL;
  const alexEmailResult: GmailSendResult | null = alexEmail
    ? await safeSend({
        to: alexEmail,
        subject: `New buyer intake: ${input.name}`,
        body: `Buyer: ${input.name} <${input.email}>\nEntity: ${input.entity ?? "—"}\nMarkets: ${(input.markets ?? []).join(", ") || "—"}\nMin/Max: $${input.minPrice ?? "?"} – $${input.maxPrice ?? "?"}\nBuyer type: ${input.buyerType ?? "?"}\nNotes: ${input.notes ?? "—"}\n\nReview: /buyers (id ${buyerId})`,
      })
    : null;

  return NextResponse.json({
    success: true,
    buyerId,
    email_status: {
      buyer_confirmation: buyerEmailResult.audit_status,
      buyer_confirmation_error: buyerEmailResult.error ?? buyerEmailResult.verifyError ?? null,
      alex_notification: alexEmailResult?.audit_status ?? "skipped",
      alex_notification_error: alexEmailResult?.error ?? alexEmailResult?.verifyError ?? null,
    },
  });
}
