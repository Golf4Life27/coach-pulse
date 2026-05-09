import { NextResponse } from "next/server";
import { listBuyersV2, updateBuyerV2, BUYER_V2_FIELDS } from "@/lib/buyers-v2";
import { sendEmail } from "@/lib/gmail";
import { buildJarvisSystemPrompt } from "@/lib/jarvis-system-prompt";
import type { BuyerRecord } from "@/types/jarvis";

export const runtime = "nodejs";
export const maxDuration = 300;

const ANTHROPIC_MODEL = "claude-sonnet-4-5-20250929";
const DAILY_CAP = 25;

interface DraftedEmail {
  subject: string;
  body: string;
}

function fallbackEmail1(b: BuyerRecord): DraftedEmail {
  const firstName = b.name.split(" ")[0] || "there";
  return {
    subject: `Quick intro — AKB Solutions`,
    body:
`Hi ${firstName},

Saw your most recent purchase${b.lastPurchaseAddress ? ` at ${b.lastPurchaseAddress}` : ""} — looks like you're active in ${(b.markets ?? ["the area"]).join(" / ")}.

I'm Alex with AKB Solutions. We source off-market wholesale deals across distressed listings. I'd love to send you anything that fits your buy box.

Quick form (60 seconds): [Buyer intake form]

— Alex / AKB Solutions / (815) 556-9965`,
  };
}

async function draftWithLLM(buyer: BuyerRecord, apiKey: string): Promise<DraftedEmail | null> {
  const system = buildJarvisSystemPrompt({ context: "reply_draft", includeBuyerRules: true })
    + `\n\nYou are drafting Email 1 of a 3-step warmup sequence to a buyer pulled from InvestorBase. Tone: professional but conversational. 4-6 sentences max. Reference the buyer's last purchase (if known) or markets. Mention an "Off-market deals matching your buy box" pitch. Include a short CTA pointing them to the buyer intake form.`;
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
        messages: [
          {
            role: "user",
            content: `Draft email 1 for: ${buyer.name} <${buyer.email}>. Markets: ${(buyer.markets ?? []).join(", ")}. Last purchase: ${buyer.lastPurchaseAddress ?? "—"}${buyer.lastPurchasePrice ? ` for $${buyer.lastPurchasePrice}` : ""}. Buyer type: ${buyer.buyerType ?? "?"}. Volume tier: ${buyer.buyerVolumeTier ?? "?"}.

Output JSON only: { "subject": "...", "body": "..." }`,
          },
        ],
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    const text = data.content?.find((b) => b.type === "text")?.text ?? "";
    const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
    const parsed = JSON.parse(cleaned) as DraftedEmail;
    if (typeof parsed.body === "string" && typeof parsed.subject === "string") return parsed;
    return null;
  } catch {
    return null;
  }
}

export async function GET(req: Request) {
  // Vercel cron sends GET. Optionally check a CRON_SECRET in headers.
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization") ?? "";
    if (!auth.includes(secret)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "ANTHROPIC_API_KEY not set" }, { status: 500 });
  }

  // Pull Cold buyers with no Email_Sent_At yet.
  const formula = `AND({${BUYER_V2_FIELDS.Status}}="Cold", {${BUYER_V2_FIELDS.Email_Sent_At}}="", {${BUYER_V2_FIELDS.Email}}!="")`;
  const cold = await listBuyersV2({ filterByFormula: formula, maxRecords: DAILY_CAP });

  const drafted: Array<{ buyerId: string; subject: string; draftId?: string; draftUrl?: string; success: boolean; error?: string }> = [];
  for (const buyer of cold) {
    if (!buyer.email) continue;
    const llm = await draftWithLLM(buyer, apiKey);
    const draft = llm ?? fallbackEmail1(buyer);

    // CREATE A DRAFT — never auto-send (per spec).
    const r = await sendEmail({ to: buyer.email, subject: draft.subject, body: draft.body, asDraft: true });
    if (r.success) {
      try {
        await updateBuyerV2(buyer.id, {
          [BUYER_V2_FIELDS.Email_Sent_At]: null,  // not yet sent — only drafted
          [BUYER_V2_FIELDS.Notes]: `${buyer.notes ? buyer.notes + "\n" : ""}[${new Date().toISOString().slice(0, 10)}] Email 1 drafted: ${r.draftUrl ?? "(no url)"}`,
        });
      } catch {
        /* non-fatal */
      }
      drafted.push({ buyerId: buyer.id, subject: draft.subject, draftId: r.draftId, draftUrl: r.draftUrl, success: true });
    } else {
      drafted.push({ buyerId: buyer.id, subject: draft.subject, success: false, error: r.error });
    }
  }

  return NextResponse.json({
    pulled: cold.length,
    drafted: drafted.filter((d) => d.success).length,
    failed: drafted.filter((d) => !d.success).length,
    items: drafted,
    note: "Drafts created in Gmail — review in Buyer Warmup Queue and send manually.",
  });
}
