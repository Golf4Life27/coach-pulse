import { NextResponse } from "next/server";

// Web search + LLM inference can take 30-60s
export const maxDuration = 60;

const SYSTEM_PROMPT = `You are a real estate listing verification agent for AKB Solutions, a wholesale real estate company in Texas.

Your job is to analyze a property listing and return a structured JSON verdict. You have web search access to find and read Redfin listings.

Rules:
- NEVER use ARV, AVM, or estimated value in any reasoning
- Be conservative — false positives waste outreach budget and damage sender reputation
- If a listing is ambiguous, route to Manual Review, not Auto Proceed

For each property:
1. If no Redfin URL provided, search Redfin for the exact address
2. Read the listing — confirm status, price, DOM, description, agent info
3. Check for off-market signals in page text: "off the market", "sold on", "pending sale", "no longer available", "contingent", "sale pending"
4. Score flip/renovation keywords in description (1 point each): "completely renovated", "brand new", "move-in ready", "quartz countertops", "stainless steel appliances", "virtually staged", "LVP", "new cabinets", "modern finishes", "turnkey", "fully updated", "renovated", "remodeled", "updated kitchen", "updated bathrooms"
5. Auto-reject triggers (regardless of score): "new construction", "new build", "2024 build", "2025 build"
6. Determine execution path

Execution path logic:
- Auto-reject keywords found → execution_path: "Reject", reject_reason: state the keyword
- Off-market signals found → execution_path: "Reject", off_market_override: true
- flip_score >= 7 → execution_path: "Reject"
- flip_score >= 4 → execution_path: "Manual Review"
- Listing active, flip_score < 4 → execution_path: "Auto Proceed"

Respond ONLY with valid JSON, no markdown, no explanation:
{
  "verified_on_market": boolean,
  "off_market_override": boolean,
  "execution_path": "Auto Proceed" | "Manual Review" | "Reject",
  "flip_score": number,
  "redfin_url": string | null,
  "redfin_dom": number | null,
  "redfin_list_price": number | null,
  "agent_name": string | null,
  "agent_phone": string | null,
  "agent_email": string | null,
  "reject_reason": string | null,
  "verification_notes": "2-3 sentence plain English summary of what you found and why you made this verdict"
}`;

interface VerifyRequest {
  recordId: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  listPrice: number | null;
  domCalc: number | null;
  existingRedfinUrl: string | null;
  existingNotes?: string | null;
}

interface VerifyVerdict {
  verified_on_market: boolean;
  off_market_override: boolean;
  execution_path: string;
  flip_score: number;
  redfin_url: string | null;
  redfin_dom: number | null;
  redfin_list_price: number | null;
  agent_name: string | null;
  agent_phone: string | null;
  agent_email: string | null;
  reject_reason: string | null;
  verification_notes: string;
}

function buildUserMessage(req: VerifyRequest): string {
  const parts = [
    `Verify this property for wholesale acquisition:`,
    `Address: ${req.address}, ${req.city}, ${req.state} ${req.zip}`,
  ];

  if (req.existingRedfinUrl) {
    parts.push(`Known Redfin URL: ${req.existingRedfinUrl}`);
  } else {
    parts.push("No Redfin URL on file — please search for it.");
  }

  if (req.listPrice) {
    parts.push(
      `PropStream list price: $${req.listPrice.toLocaleString("en-US")}`
    );
  }
  if (req.domCalc) {
    parts.push(`PropStream DOM estimate: ${req.domCalc} days`);
  }

  parts.push(
    "",
    "Find the active Redfin listing, read the full description and status, and return your verdict as JSON."
  );

  return parts.join("\n");
}

function buildNotesAppend(
  existing: string | null,
  verdict: VerifyVerdict
): string {
  const today = new Date().toLocaleDateString("en-US", {
    month: "numeric",
    day: "numeric",
    year: "2-digit",
  });
  const newNote = `${today} — [Agent Verify] ${verdict.execution_path}. Flip score: ${verdict.flip_score}. ${verdict.verification_notes}`;
  return existing ? `${existing}\n\n${newNote}` : newNote;
}

export async function POST(request: Request) {
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  const AIRTABLE_PAT = process.env.AIRTABLE_PAT;
  const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID || "appp8inLAGTg4qpEZ";
  const AIRTABLE_TABLE_ID = process.env.AIRTABLE_TABLE_ID || "tbldMjKBgPiq45Jjs";

  if (!ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY not configured" },
      { status: 500 }
    );
  }
  if (!AIRTABLE_PAT) {
    return NextResponse.json(
      { error: "AIRTABLE_PAT not configured" },
      { status: 500 }
    );
  }

  let body: VerifyRequest;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { recordId, address, city } = body;
  if (!recordId || !address || !city) {
    return NextResponse.json(
      { error: "Missing required fields: recordId, address, city" },
      { status: 400 }
    );
  }

  // --- Call Anthropic API with web search ---
  let verdict: VerifyVerdict;

  try {
    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: buildUserMessage(body) }],
      }),
    });

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text();
      console.error(
        `[verify-listing] Anthropic API error ${anthropicRes.status}: ${errText}`
      );
      return NextResponse.json(
        { error: `Anthropic API error: ${anthropicRes.status}`, detail: errText },
        { status: 500 }
      );
    }

    const anthropicData = await anthropicRes.json();

    // Extract the last text block from the response
    const textBlocks = (
      anthropicData.content as Array<{ type: string; text?: string }>
    ).filter((block) => block.type === "text" && block.text);

    if (textBlocks.length === 0) {
      console.error(
        "[verify-listing] No text block in Anthropic response:",
        JSON.stringify(anthropicData.content)
      );
      return NextResponse.json(
        { error: "No text response from Anthropic", raw: anthropicData.content },
        { status: 500 }
      );
    }

    const rawText = textBlocks[textBlocks.length - 1].text!;

    // Strip markdown fences if present
    const cleaned = rawText
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

    try {
      verdict = JSON.parse(cleaned);
    } catch (parseErr) {
      console.error(
        "[verify-listing] JSON parse failed. Raw text:",
        rawText
      );
      return NextResponse.json(
        {
          error: "Failed to parse verdict JSON",
          rawText,
          parseError: String(parseErr),
        },
        { status: 500 }
      );
    }
  } catch (err) {
    console.error("[verify-listing] Anthropic fetch error:", err);
    return NextResponse.json(
      { error: "Failed to call Anthropic API", detail: String(err) },
      { status: 500 }
    );
  }

  // --- PATCH Airtable (skip for test calls) ---
  let airtableSuccess = false;

  if (recordId !== "TEST_ONLY") {
    try {
      const airtableFields: Record<string, unknown> = {
        fldCxApxYiiB8eYFI: verdict.verified_on_market,
        fldytROucQFdlPGLm: verdict.off_market_override,
        fldOrWvqKcc1g6Lka: verdict.execution_path,
        fldyiFT48fudbF34k: verdict.flip_score,
        fldwKGxZly6O8qyPu: buildNotesAppend(
          body.existingNotes ?? null,
          verdict
        ),
        fld2eUkKaC4pMjIdd: new Date().toISOString(),
      };

      if (verdict.redfin_url)
        airtableFields["fldXrW8CWUphUfKgJ"] = verdict.redfin_url;
      if (verdict.agent_name)
        airtableFields["fld69oB0no6tfguom"] = verdict.agent_name;
      if (verdict.agent_phone)
        airtableFields["fldee9MOstjNDKjnm"] = verdict.agent_phone;
      if (verdict.agent_email)
        airtableFields["fldzdck2fhd6DZ3Oq"] = verdict.agent_email;

      const airtableRes = await fetch(
        `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE_ID}/${recordId}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${AIRTABLE_PAT}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ fields: airtableFields, typecast: true }),
        }
      );

      if (!airtableRes.ok) {
        const errText = await airtableRes.text();
        console.error(
          `[verify-listing] Airtable PATCH failed ${airtableRes.status}: ${errText}`
        );
        // Don't fail the response — still return verdict
      } else {
        airtableSuccess = true;
      }
    } catch (err) {
      console.error("[verify-listing] Airtable fetch error:", err);
    }
  } else {
    airtableSuccess = true; // test mode
  }

  return NextResponse.json({
    success: true,
    recordId,
    airtableUpdated: airtableSuccess,
    verdict,
  });
}
