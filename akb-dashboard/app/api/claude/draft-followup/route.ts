import Anthropic from "@anthropic-ai/sdk";
import {
  getNegotiationContext,
  RecordNotFoundError,
  NotNegotiatingError,
} from "@/lib/negotiation";
import { formatCurrency } from "@/lib/utils";

export const runtime = "nodejs";
export const maxDuration = 30;

const SYSTEM_PROMPT = `You are drafting an SMS follow-up from Alex, an investor at AKB Solutions LLC, to a real estate agent representing a seller. The agent previously replied to Alex's initial cash offer and the conversation has gone quiet.

RULES (non-negotiable):
- Our offer is exactly 65% of list price. Never propose going above that for the "Hold firm" variant.
- For "Small concession", you may propose up to an additional 3% of list price, but NEVER frame it as our max. Frame any movement as conditional ("if we can close fast", "given the DOM", etc.)
- NEVER use the word "assignable". If closing-entity language is needed, say: "We may close under a different entity name, just want to make sure that won't be an issue."
- Use first name only. Casual but professional. No emojis. No exclamation points.
- Keep each variant to 2 sentences, 40 words max.
- Reference the days of silence as leverage without stating the number directly.
- Do NOT mention ARV, AVM, renovation estimates, or comps.
- Start with "Hey [FirstName]," — no other greeting forms.

Return exactly this JSON and nothing else:
{
  "variants": [
    { "label": "Hold firm", "body": "..." },
    { "label": "Small concession", "body": "..." }
  ]
}`;

// Rate limit: 3 calls per recordId per 60s
const rateLimitMap = new Map<string, number[]>();

function checkRateLimit(recordId: string): boolean {
  const now = Date.now();
  const window = 60_000;
  const max = 3;

  let timestamps = rateLimitMap.get(recordId) ?? [];
  timestamps = timestamps.filter((t) => now - t < window);

  if (timestamps.length >= max) return false;

  timestamps.push(now);
  rateLimitMap.set(recordId, timestamps);
  return true;
}

export async function POST(req: Request) {
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) {
    return Response.json(
      { error: "Add ANTHROPIC_API_KEY to Vercel environment variables" },
      { status: 500 }
    );
  }

  let body: { recordId?: string };
  try {
    const text = await req.text();
    if (!text || text.trim() === "") {
      return Response.json({ error: "Empty body" }, { status: 400 });
    }
    body = JSON.parse(text);
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { recordId } = body;
  if (!recordId) {
    return Response.json({ error: "Missing recordId" }, { status: 400 });
  }

  if (!checkRateLimit(recordId)) {
    return Response.json(
      { error: "Rate limit: max 3 drafts per record per minute" },
      { status: 429 }
    );
  }

  // Fetch negotiation context from Airtable
  let context;
  try {
    context = await getNegotiationContext(recordId);
  } catch (err) {
    if (err instanceof RecordNotFoundError) {
      return Response.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof NotNegotiatingError) {
      return Response.json({ error: err.message }, { status: 400 });
    }
    console.error("[draft-followup] Airtable error:", err);
    return Response.json(
      { error: "Failed to read Airtable record", detail: String(err) },
      { status: 500 }
    );
  }

  // Call Claude
  const userMessage = `Property: ${context.address}
List price: ${formatCurrency(context.list_price)}
Our standing offer: ${formatCurrency(context.our_offer)} (65% of list)
Agent: ${context.agent_first_name}
Days since last contact: ${context.days_since_contact}
Agent's last reply (truncated to 500 chars): ${context.last_reply_excerpt}
Current Outreach_Status: Negotiating`;

  try {
    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    const message = await client.messages.create({
      model: "claude-sonnet-4-5-20250514",
      max_tokens: 512,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }],
    });

    const textBlock = message.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      return Response.json(
        { error: "Claude returned no text response" },
        { status: 502 }
      );
    }

    const raw = textBlock.text;
    const jsonStart = raw.indexOf("{");
    const jsonEnd = raw.lastIndexOf("}");
    if (jsonStart === -1 || jsonEnd <= jsonStart) {
      console.error("[draft-followup] Unparseable Claude output:", raw);
      return Response.json(
        { error: "Claude returned unparseable output", raw },
        { status: 502 }
      );
    }

    let parsed: { variants: Array<{ label: string; body: string }> };
    try {
      parsed = JSON.parse(raw.slice(jsonStart, jsonEnd + 1));
    } catch {
      console.error("[draft-followup] JSON parse failed:", raw);
      return Response.json(
        { error: "Claude returned unparseable output", raw },
        { status: 502 }
      );
    }

    if (!Array.isArray(parsed.variants) || parsed.variants.length < 2) {
      return Response.json(
        { error: "Claude returned unexpected shape", raw },
        { status: 502 }
      );
    }

    return Response.json({
      variants: parsed.variants,
      context: {
        address: context.address,
        list_price: context.list_price,
        our_offer: context.our_offer,
        agent_first_name: context.agent_first_name,
        days_since_contact: context.days_since_contact,
        last_reply_excerpt: context.last_reply_excerpt,
      },
    });
  } catch (err) {
    console.error("[draft-followup] Anthropic error:", err);
    return Response.json(
      { error: "Claude API call failed", detail: String(err) },
      { status: 500 }
    );
  }
}
