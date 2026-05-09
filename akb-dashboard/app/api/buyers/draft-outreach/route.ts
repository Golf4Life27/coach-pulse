import { NextResponse } from "next/server";
import { getListing } from "@/lib/airtable";
import { getBuyerV2 } from "@/lib/buyers-v2";
import { buildJarvisSystemPrompt } from "@/lib/jarvis-system-prompt";
import type { BuyerDraft } from "@/types/jarvis";

export const runtime = "nodejs";
export const maxDuration = 120;

const ANTHROPIC_MODEL = "claude-sonnet-4-5-20250929";

interface RequestBody {
  recordId: string;
  buyerIds: string[];
  assignmentPrice: number;
  channel: "email" | "sms";
}

interface DraftOutput {
  subject?: string;
  body: string;
}

function fallbackEmail(buyerName: string, address: string, assignmentPrice: number): DraftOutput {
  return {
    subject: `Off-market deal — ${address}`,
    body:
`Hi ${buyerName.split(" ")[0] || "there"},

Quick off-market opportunity at ${address}. Assignment price ${formatUsd(assignmentPrice)}, cash close, 10-day inspection.

Want photos and the inspection window? Reply yes and I'll get you the package.

— Alex
AKB Solutions
(815) 556-9965`,
  };
}

function fallbackSms(buyerName: string, address: string, assignmentPrice: number): DraftOutput {
  return {
    body: `Hey ${buyerName.split(" ")[0] || "there"} — off-market at ${address}, ${formatUsd(assignmentPrice)} assignment, cash close, 10-day inspection. Interested? — Alex / AKB`,
  };
}

function formatUsd(n: number): string {
  return "$" + Math.round(n).toLocaleString("en-US");
}

export async function POST(req: Request) {
  let body: RequestBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { recordId, buyerIds, assignmentPrice, channel } = body;
  if (!recordId || !Array.isArray(buyerIds) || buyerIds.length === 0) {
    return NextResponse.json({ error: "Missing recordId or buyerIds" }, { status: 400 });
  }
  if (typeof assignmentPrice !== "number" || assignmentPrice <= 0) {
    return NextResponse.json({ error: "Invalid assignmentPrice" }, { status: 400 });
  }
  if (channel !== "email" && channel !== "sms") {
    return NextResponse.json({ error: "channel must be 'email' or 'sms'" }, { status: 400 });
  }

  const listing = await getListing(recordId);
  if (!listing) {
    return NextResponse.json({ error: "Listing not found" }, { status: 404 });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "ANTHROPIC_API_KEY not set" }, { status: 500 });
  }

  const buyers = await Promise.all(buyerIds.map((id) => getBuyerV2(id)));
  const valid = buyers.filter((b) => b != null) as NonNullable<typeof buyers[number]>[];
  if (valid.length === 0) {
    return NextResponse.json({ error: "No valid buyers" }, { status: 400 });
  }

  const system = buildJarvisSystemPrompt({ context: "reply_draft", includeBuyerRules: true })
    + `\n\n## BUYER OUTREACH FORMAT\nNEVER disclose contract price, assignment fee, spread, ARV, repair estimate, or anything beyond the assignment price + basic property facts. Buyers see ONE number: the assignment price.\n\nFormat constraints:\n- ${channel.toUpperCase()} channel.\n- For SMS: under 280 chars, no signature line, friendly but professional.\n- For email: 3-5 short sentences max, signature: "— Alex / AKB Solutions / (815) 556-9965".\n- Match buyer's volume tier — high-volume (Tier A) buyers get terse + numbers; low-volume get more context.`;

  const propLine = `${listing.address}, ${listing.city ?? ""} ${listing.state ?? ""} ${listing.zip ?? ""}`.trim();
  const dealContext = `PROPERTY: ${propLine}
Bed/Bath: ${listing.bedrooms ?? "?"} / ${listing.bathrooms ?? "?"}
SqFt: ${listing.buildingSqFt ?? "?"}
Condition (from photo analysis): ${listing.redFlags ? `flagged: ${typeof listing.redFlags === "string" ? listing.redFlags : (listing.redFlags as string[]).join(", ")}` : "no flags"}
ASSIGNMENT PRICE: ${formatUsd(assignmentPrice)}`;

  const drafts: BuyerDraft[] = [];
  for (const buyer of valid) {
    const buyerLine = `${buyer.name} | type=${buyer.buyerType ?? "?"} | tier=${buyer.buyerVolumeTier ?? "?"} | last purchase: ${buyer.lastPurchaseAddress ?? "—"} for ${buyer.lastPurchasePrice ? formatUsd(buyer.lastPurchasePrice) : "?"} | markets=${(buyer.markets ?? []).join(",")}`;
    const userPrompt = `Draft a ${channel} for this buyer:
${buyerLine}

${dealContext}

Output ONLY a JSON object, no prose:
{
  ${channel === "email" ? `"subject": "...",\n  ` : ""}"body": "..."
}`;

    let draft: DraftOutput | null = null;
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: ANTHROPIC_MODEL,
          max_tokens: 600,
          system,
          messages: [{ role: "user", content: userPrompt }],
        }),
      });
      if (res.ok) {
        const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
        const text = data.content?.find((b) => b.type === "text")?.text ?? "";
        try {
          const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
          const parsed = JSON.parse(cleaned) as DraftOutput;
          if (typeof parsed.body === "string") draft = parsed;
        } catch {
          /* fall through to fallback */
        }
      }
    } catch (err) {
      console.error(`[buyers/draft-outreach] LLM call failed for ${buyer.id}:`, err);
    }

    if (!draft) {
      draft = channel === "email"
        ? fallbackEmail(buyer.name, listing.address, assignmentPrice)
        : fallbackSms(buyer.name, listing.address, assignmentPrice);
    }

    drafts.push({
      buyerId: buyer.id,
      buyerName: buyer.name,
      buyerEmail: buyer.email,
      buyerPhone: buyer.phonePrimary,
      channel,
      subject: channel === "email" ? draft.subject : undefined,
      body: draft.body,
    });
  }

  return NextResponse.json({ drafts });
}
