// POST /api/verify-listing — Called by Make.com to verify listings via Anthropic + web search
import { NextResponse } from "next/server";

// Force Node.js runtime (not Edge) — we need full Node APIs
export const runtime = "nodejs";

// Web search + LLM inference can take 30-60s
export const maxDuration = 60;

const SYSTEM_PROMPT = `You are a real estate listing verification and valuation agent for AKB Solutions, a wholesale real estate company in Texas.

Your job is to do TWO things for every property:
1. Verify the listing status on Redfin
2. Estimate the After Repair Value (ARV) using recent sold comps

You have web search access. Use it thoroughly.

---

PART 1 — LISTING VERIFICATION

Steps:
1. If no Redfin URL provided, search Redfin for the exact address
2. Read the listing page — confirm status, price, days on market, description, agent info
3. Check for off-market signals in page text: "off the market", "sold on", "pending sale", "no longer available", "contingent", "sale pending"
4. Score flip/renovation keywords in description (1 point each): "completely renovated", "brand new", "move-in ready", "quartz countertops", "stainless steel appliances", "virtually staged", "LVP", "new cabinets", "modern finishes", "turnkey", "fully updated", "renovated", "remodeled", "updated kitchen", "updated bathrooms"
5. Auto-reject triggers (regardless of score): "new construction", "new build", "2024 build", "2025 build"

Execution path logic:
- Auto-reject keywords found → execution_path: "Reject", reject_reason: state the keyword
- Off-market signals found → execution_path: "Reject", off_market_override: true
- flip_score >= 7 → execution_path: "Reject"
- flip_score >= 4 → execution_path: "Manual Review"
- Listing active, flip_score < 4 → execution_path: "Auto Proceed"

---

PART 2 — ARV ESTIMATION

Only run this if the listing is NOT rejected in Part 1. If execution_path is "Reject", return null for all ARV fields.

Steps:
1. Search Redfin or Zillow for recently SOLD comparable properties near the subject address
2. Target: 3-6 comps within 0.5 miles, sold within 90 days, similar sqft (within 20%), same bed/bath count, same property type (SFR)
3. If 90-day comps are scarce, expand to 180 days and note this in reasoning
4. For each comp, note: address, sale price, sqft, beds, baths, sale date, distance from subject
5. Calculate adjusted $/sqft for RENOVATED condition (use comps that were renovated/updated as your benchmark)
6. ARV = adjusted $/sqft × subject sqft
7. Estimate rehab cost based on condition signals from the listing description and photos:
   - Light cosmetic (paint, flooring, fixtures): $8-15/sqft
   - Moderate (kitchen/bath updates + cosmetic): $15-25/sqft
   - Heavy (systems + full interior): $25-40/sqft
   - Gut rehab (structural issues): $40-60/sqft
8. Assign confidence level:
   - HIGH: 3+ strong comps within 0.5mi sold <90 days, tight price cluster
   - MEDIUM: 2-3 decent comps with some gaps in recency or distance
   - LOW: fewer than 2 relevant comps or wide price variance

ARV rules:
- NEVER use list price or PropStream estimated value as a proxy for ARV
- Base ARV on what the property would sell for AFTER renovation, not current condition
- Be conservative — it is better to underestimate ARV than overestimate it

---

CRITICAL RULES:
- Never use AVM, Zestimate, or PropStream Est_Value in any calculation
- ARV is always based on sold comp analysis only
- Be conservative on both ARV and rehab estimates
- If you cannot find reliable comps, set arv_confidence to "LOW" and explain why

---

Respond ONLY with valid JSON, no markdown, no explanation, no backticks:

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
  "arv_estimated": number | null,
  "arv_confidence": "HIGH" | "MEDIUM" | "LOW" | null,
  "arv_comp_count": number | null,
  "arv_comp_avg_psf": number | null,
  "arv_comp_details": string | null,
  "rehab_est_low": number | null,
  "rehab_est_high": number | null,
  "condition_score": number | null,
  "verification_notes": "2-3 sentence plain English summary of listing status, flip risk, ARV confidence, and verdict"
}`;

interface VerifyRequest {
  recordId: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  listPrice: number | string | null;
  domCalc: number | string | null;
  existingRedfinUrl: string | null;
  existingNotes?: string | null;
}

interface VerifyVerdict {
  verified_on_market: boolean;
  off_market_override: boolean;
  execution_path: "Auto Proceed" | "Manual Review" | "Reject";
  flip_score: number;
  redfin_url: string | null;
  redfin_dom: number | null;
  redfin_list_price: number | null;
  agent_name: string | null;
  agent_phone: string | null;
  agent_email: string | null;
  reject_reason: string | null;
  arv_estimated: number | null;
  arv_confidence: "HIGH" | "MEDIUM" | "LOW" | null;
  arv_comp_count: number | null;
  arv_comp_avg_psf: number | null;
  arv_comp_details: string | null;
  rehab_est_low: number | null;
  rehab_est_high: number | null;
  condition_score: number | null;
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

  const listPrice =
    req.listPrice != null && req.listPrice !== ""
      ? parseFloat(String(req.listPrice))
      : NaN;
  const domCalc =
    req.domCalc != null && req.domCalc !== ""
      ? parseFloat(String(req.domCalc))
      : NaN;

  if (!isNaN(listPrice)) {
    parts.push(
      `PropStream list price: $${listPrice.toLocaleString("en-US")}`
    );
  }
  if (!isNaN(domCalc)) {
    parts.push(`PropStream DOM estimate: ${domCalc} days`);
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
  const arvLine = verdict.arv_estimated
    ? ` ARV: $${verdict.arv_estimated.toLocaleString()} (${verdict.arv_confidence} confidence, ${verdict.arv_comp_count} comps). Rehab est: $${verdict.rehab_est_low?.toLocaleString()}\u2013$${verdict.rehab_est_high?.toLocaleString()}.`
    : "";
  const newNote = `${today} \u2014 [Agent Verify+ARV] ${verdict.execution_path}. Flip score: ${verdict.flip_score}.${arvLine} ${verdict.verification_notes}`;
  return existing ? `${existing}\n\n${newNote}` : newNote;
}

export async function POST(request: Request) {
  console.log("[verify-listing] called", request.method, request.url);

  try {
    const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    const AIRTABLE_PAT = process.env.AIRTABLE_PAT;
    const AIRTABLE_BASE_ID =
      process.env.AIRTABLE_BASE_ID || "appp8inLAGTg4qpEZ";
    const AIRTABLE_TABLE_ID =
      process.env.AIRTABLE_TABLE_ID || "tbldMjKBgPiq45Jjs";

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
    const rawText = await request.text();
    console.log("[verify-listing] raw body length:", rawText.length);
    try {
      body = JSON.parse(rawText);
    } catch {
      console.error("[verify-listing] JSON parse failed, rawBody:", rawText);
      return NextResponse.json(
        { error: "Invalid JSON body", rawBody: rawText },
        { status: 400 }
      );
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
        max_tokens: 16000,
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

    // Extract JSON object from response — Claude may prefix with prose
    const jsonStart = rawText.indexOf("{");
    const jsonEnd = rawText.lastIndexOf("}");

    if (jsonStart === -1 || jsonEnd === -1 || jsonEnd <= jsonStart) {
      console.error(
        "[verify-listing] No JSON object found in response. Raw text:",
        rawText
      );
      return NextResponse.json(
        { error: "No JSON found in Anthropic response", rawText },
        { status: 500 }
      );
    }

    const jsonStr = rawText.slice(jsonStart, jsonEnd + 1);

    try {
      verdict = JSON.parse(jsonStr);
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
        // Verification fields
        fldCxApxYiiB8eYFI: verdict.verified_on_market,
        fldytROucQFdlPGLm: verdict.off_market_override,
        fldOrWvqKcc1g6Lka: verdict.execution_path,
        fldyiFT48fudbF34k: verdict.flip_score,
        fldwKGxZly6O8qyPu: buildNotesAppend(
          body.existingNotes ?? null,
          verdict
        ),
        fld2eUkKaC4pMjIdd: new Date().toISOString(),
        // ARV fields (only write if not null)
        ...(verdict.arv_estimated !== null && {
          fldGrbFgkHVxkqJSX: verdict.arv_estimated,
        }),
        ...(verdict.arv_confidence !== null && {
          fldDcIiUajkvi8Wz3: verdict.arv_confidence,
        }),
        ...(verdict.arv_comp_count !== null && {
          fldyukQHGzGdxoDGf: verdict.arv_comp_count,
        }),
        ...(verdict.arv_comp_avg_psf !== null && {
          fld9uJ3xRjkHGYruM: verdict.arv_comp_avg_psf,
        }),
        ...(verdict.arv_comp_details !== null && {
          fld82wv8rM9t6Awjd: verdict.arv_comp_details,
        }),
        ...(verdict.rehab_est_low !== null && {
          fld1I0vcWZbp56GKc: verdict.rehab_est_low,
        }),
        ...(verdict.rehab_est_high !== null && {
          fldAcdeYJQbEyYNU2: verdict.rehab_est_high,
        }),
        ...(verdict.condition_score !== null && {
          fldkE6xgHeCvmyKJy: verdict.condition_score,
        }),
        fldqmB24Iog0t2r0a: new Date().toISOString(), // ARV_Last_Run
      };

      // Conditional fields
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

  } catch (topLevelErr) {
    console.error("[verify-listing] Unhandled error:", topLevelErr);
    return NextResponse.json(
      {
        error: "Unhandled server error",
        detail: String(topLevelErr),
      },
      { status: 500 }
    );
  }
}
