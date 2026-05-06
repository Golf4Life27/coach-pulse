export const runtime = "nodejs";
export const maxDuration = 60;

const AIRTABLE_PAT = process.env.AIRTABLE_PAT!;
const BASE_ID = process.env.AIRTABLE_BASE_ID || "appp8inLAGTg4qpEZ";
const LISTINGS_TABLE = "tbldMjKBgPiq45Jjs";
const RENTCAST_API_KEY = process.env.RENTCAST_API_KEY!;

// Field IDs for reading
const F = {
  address: "fldwvp72hKTfiHHjj",
  city: "fldjbiNuHXzPzVWFk",
  state: "fldSlDQvgCyr0J8tI",
  zip: "fld9PTaKkgBNtvWbB",
  agentPhone: "fldee9MOstjNDKjnm",
  executionPath: "fldOrWvqKcc1g6Lka",
  liveStatus: "fldCKnC1nnXEnTUKL",
  notes: "fldwKGxZly6O8qyPu",
};

// Field IDs for writing
const W = {
  liveStatus: "fldCKnC1nnXEnTUKL",
  executionPath: "fldOrWvqKcc1g6Lka",
  verifiedOnMarket: "fldCxApxYiiB8eYFI",
  verificationSource: "flddEHrMOoBPVfqgk",
  verificationUrl: "fldXrW8CWUphUfKgJ",
  lastVerified: "fld2eUkKaC4pMjIdd",
  notes: "fldwKGxZly6O8qyPu",
  restrictionRiskLevel: "fld5dV65Wr9b6bjo3",
  restrictionKeywordFlag: "fldSpBUMzTzFtp59k",
  restrictionText: "fldapf2ZXpIWTZfSX",
};

// --- Keyword scoring ---

const HARD_REJECT_KEYWORDS = [
  "no wholesalers", "auction", "hud", "bank-owned reo",
];

const FLIP_KEYWORDS = [
  "remodeled", "renovated", "fully updated", "move-in ready",
  "new kitchen", "new bathroom", "new roof", "new hvac",
  "granite", "quartz countertops", "stainless steel",
  "open concept", "fresh paint", "new flooring",
];

const DISTRESS_KEYWORDS = [
  "as-is", "investor special", "needs work", "tlc", "fixer",
  "handyman", "estate sale", "probate", "vacant", "fire damage",
  "foundation issues", "mold",
];

interface KeywordResult {
  score: number;
  executionPath: "Auto Proceed" | "Manual Review" | "Reject";
  riskLevel: "None" | "Low" | "High";
  keywordFlag: boolean;
  details: string;
}

function scoreDescription(description: string): KeywordResult {
  const lower = description.toLowerCase();
  let score = 0;
  const matched: string[] = [];

  for (const kw of HARD_REJECT_KEYWORDS) {
    if (lower.includes(kw)) {
      score += 10;
      matched.push(`HARD REJECT: "${kw}"`);
    }
  }

  for (const kw of FLIP_KEYWORDS) {
    if (lower.includes(kw)) {
      score += 1;
      matched.push(`flip: "${kw}"`);
    }
  }

  for (const kw of DISTRESS_KEYWORDS) {
    if (lower.includes(kw)) {
      score -= 1;
      matched.push(`distress: "${kw}"`);
    }
  }

  let executionPath: "Auto Proceed" | "Manual Review" | "Reject";
  let riskLevel: "None" | "Low" | "High";

  if (score >= 10) {
    executionPath = "Reject";
    riskLevel = "High";
  } else if (score >= 4) {
    executionPath = "Manual Review";
    riskLevel = "High";
  } else {
    executionPath = "Auto Proceed";
    riskLevel = score > 0 ? "Low" : "None";
  }

  return {
    score,
    executionPath,
    riskLevel,
    keywordFlag: matched.length > 0,
    details: matched.length > 0
      ? `Score ${score}. Matches: ${matched.join(", ")}`
      : `Score ${score}. No keyword matches.`,
  };
}

// --- Off-market detection ---

const OFF_MARKET_PHRASES = [
  "off the market", "no longer available", "sold on",
  "pending sale", "sale pending", "this home is not for sale",
  "this listing has been removed",
];

function detectOffMarket(text: string): boolean {
  const lower = text.toLowerCase();
  return OFF_MARKET_PHRASES.some((phrase) => lower.includes(phrase));
}

// --- RentCast API ---

interface RentCastListing {
  id: string;
  addressLine1?: string;
  city?: string;
  state?: string;
  zipCode?: string;
  status?: string;
  price?: number;
  daysOnMarket?: number;
  listedDate?: string;
}

async function queryRentCast(
  address: string, city: string, state: string, zip: string
): Promise<RentCastListing[]> {
  const params = new URLSearchParams({
    address: address,
    city: city,
    state: state,
    zipCode: zip,
    status: "active",
  });

  const res = await fetch(
    `https://api.rentcast.io/v1/listings/sale?${params.toString()}`,
    {
      headers: { "X-Api-Key": RENTCAST_API_KEY },
      cache: "no-store",
    }
  );

  if (!res.ok) {
    if (res.status === 404 || res.status === 422) return [];
    const errText = await res.text();
    throw new Error(`RentCast error ${res.status}: ${errText}`);
  }

  return await res.json();
}

// --- Redfin search + fetch ---

async function fetchRedfinUrl(
  address: string, city: string, state: string, zip: string
): Promise<{ url: string | null; error?: string }> {
  // Use Redfin's own search endpoint instead of Google (which blocks server IPs)
  const query = encodeURIComponent(`${address} ${city} ${state} ${zip}`);
  try {
    const res = await fetch(
      `https://www.redfin.com/stingray/do/location-autocomplete?location=${query}&v=2`,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          "Accept": "application/json",
        },
        cache: "no-store",
      }
    );
    if (!res.ok) {
      return { url: null, error: `Redfin autocomplete ${res.status}` };
    }
    const text = await res.text();
    // Redfin wraps JSON in {}&&{...} — strip the prefix
    const jsonStr = text.replace(/^\{\}&&/, "");
    const data = JSON.parse(jsonStr);

    const results = data?.payload?.sections ?? [];
    for (const section of results) {
      for (const row of section.rows ?? []) {
        if (row.url && row.type === "2") {
          // type 2 = address match
          return { url: `https://www.redfin.com${row.url}` };
        }
      }
    }

    // Fallback: any result with a /home/ URL
    for (const section of results) {
      for (const row of section.rows ?? []) {
        if (row.url && row.url.includes("/home/")) {
          return { url: `https://www.redfin.com${row.url}` };
        }
      }
    }

    return { url: null, error: "No address match in Redfin autocomplete" };
  } catch (err) {
    return { url: null, error: `Redfin search failed: ${String(err)}` };
  }
}

async function fetchRedfinPage(
  url: string
): Promise<{ description: string; isOffMarket: boolean } | null> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const html = await res.text();

    // Extract description from meta tag
    const descMatch = html.match(
      /<meta\s+name="description"\s+content="([^"]*)"/i
    );
    const description = descMatch ? descMatch[1] : "";

    // Check schema.org availability
    const schemaOffMarket = html.includes('"availability":"OutOfStock"') ||
      html.includes('"availability":"https://schema.org/OutOfStock"');

    const phraseOffMarket = detectOffMarket(html);

    return {
      description,
      isOffMarket: schemaOffMarket || phraseOffMarket,
    };
  } catch {
    return null;
  }
}

// --- Phone validation ---

function isValidPhone(phone: string | null): boolean {
  if (!phone) return false;
  return /[\d]/.test(phone);
}

// --- Airtable helpers ---

async function fetchRecord(recordId: string): Promise<{ fields: Record<string, unknown>; rawError?: string } | null> {
  const params = new URLSearchParams();
  params.set("returnFieldsByFieldId", "true");

  const url = `https://api.airtable.com/v0/${BASE_ID}/${LISTINGS_TABLE}/${recordId}?${params.toString()}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${AIRTABLE_PAT}` },
    cache: "no-store",
  });
  if (!res.ok) {
    const errText = await res.text();
    console.error(`[verify] fetchRecord ${recordId} failed: ${res.status} ${errText}`);
    return { fields: {}, rawError: `Airtable ${res.status}: ${errText}` };
  }
  const data = await res.json();
  return { fields: data.fields as Record<string, unknown> };
}

async function fetchUnverifiedRecords(): Promise<Array<{ id: string; fields: Record<string, unknown> }>> {
  const records: Array<{ id: string; fields: Record<string, unknown> }> = [];
  let offset: string | undefined;

  do {
    const params = new URLSearchParams();
    params.set("filterByFormula", `AND({Execution_Path}='',{Address}!='')`);
    Object.values(F).forEach((f) => params.append("fields[]", f));
    params.set("returnFieldsByFieldId", "true");
    params.set("maxRecords", "50");
    if (offset) params.set("offset", offset);

    const res = await fetch(
      `https://api.airtable.com/v0/${BASE_ID}/${LISTINGS_TABLE}?${params.toString()}`,
      {
        headers: { Authorization: `Bearer ${AIRTABLE_PAT}` },
        cache: "no-store",
      }
    );
    if (!res.ok) break;

    const data = await res.json();
    for (const rec of data.records) {
      records.push({ id: rec.id, fields: rec.fields });
    }
    offset = data.offset;
  } while (offset && records.length < 50);

  return records;
}

async function patchRecord(
  recordId: string,
  fields: Record<string, unknown>
): Promise<void> {
  await fetch(
    `https://api.airtable.com/v0/${BASE_ID}/${LISTINGS_TABLE}/${recordId}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${AIRTABLE_PAT}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ fields, typecast: true }),
    }
  );
}

function appendNote(existing: string | null, newNote: string): string {
  const today = new Date().toLocaleDateString("en-US", {
    month: "numeric", day: "numeric", year: "2-digit",
  });
  const stamped = `${today} — [Verify] ${newNote}`;
  return existing ? `${existing}\n\n${stamped}` : stamped;
}

// --- Never-resurface list ---

const NEVER_RESURFACE = new Set([
  "2715 monterey st", "714 hallie ave", "4330 pensacola ct",
  "9618 tamalpais dr", "811 manhattan dr", "1635 arbor pl",
  "4448 marcell ave", "2725 bowling green ave", "2011 ramsey ave",
  "707 n pine st", "8641 craige dr", "910 green st",
]);

// --- Main verification logic ---

interface VerifyResult {
  recordId: string;
  address: string;
  liveStatus: string;
  executionPath: string;
  source: string;
  redfinUrl: string | null;
  keywordScore: number | null;
  error?: string;
}

async function verifyOne(
  recordId: string,
  fields: Record<string, unknown>
): Promise<VerifyResult> {
  const address = (fields[F.address] as string) ?? "";
  const city = (fields[F.city] as string) ?? "";
  const state = (fields[F.state] as string) ?? "";
  const zip = (fields[F.zip] as string) ?? "";
  const agentPhone = (fields[F.agentPhone] as string) ?? "";
  const existingNotes = (fields[F.notes] as string) ?? null;

  if (!address.trim()) {
    return { recordId, address, liveStatus: "Unknown", executionPath: "Reject", source: "skip", redfinUrl: null, keywordScore: null, error: "Empty address" };
  }

  // Never-resurface check
  if (NEVER_RESURFACE.has(address.trim().toLowerCase())) {
    await patchRecord(recordId, {
      [W.executionPath]: "Reject",
      [W.notes]: appendNote(existingNotes, "Auto-rejected: address is on the never-resurface list."),
      [W.lastVerified]: new Date().toISOString(),
    });
    return { recordId, address, liveStatus: "Rejected", executionPath: "Reject", source: "blocklist", redfinUrl: null, keywordScore: null };
  }

  // Phone validation
  if (!isValidPhone(agentPhone)) {
    await patchRecord(recordId, {
      [W.executionPath]: "Manual Review",
      [W.notes]: appendNote(existingNotes, "Agent phone missing or invalid. Manual review required."),
      [W.lastVerified]: new Date().toISOString(),
    });
    return { recordId, address, liveStatus: "Unknown", executionPath: "Manual Review", source: "phone_validation", redfinUrl: null, keywordScore: null };
  }

  // Step 1: RentCast
  let rentCastActive = false;
  let rentCastError: string | null = null;
  try {
    const listings = await queryRentCast(address, city, state, zip);
    rentCastActive = listings.length > 0;
  } catch (err) {
    rentCastError = String(err);
    console.error(`[verify] RentCast error for ${address}:`, err);
  }

  // Step 2: Redfin search + page fetch (always attempted)
  const redfin = await fetchRedfinUrl(address, city, state, zip);
  const redfinUrl = redfin.url;
  let redfinPage: { description: string; isOffMarket: boolean } | null = null;
  let redfinBlocked = false;

  if (redfinUrl) {
    redfinPage = await fetchRedfinPage(redfinUrl);
    if (!redfinPage) redfinBlocked = true;
  }

  // --- Decision logic ---
  // Rule: NEVER auto-approve on RentCast alone. Redfin must confirm.

  // Case 1: Redfin confirms off-market → Reject regardless of RentCast
  if (redfinPage?.isOffMarket) {
    await patchRecord(recordId, {
      [W.liveStatus]: "Off Market",
      [W.executionPath]: "Reject",
      [W.verifiedOnMarket]: false,
      [W.verificationSource]: `RentCast (${rentCastActive ? "active" : "empty"}) + Redfin (off-market)`,
      [W.verificationUrl]: redfinUrl,
      [W.lastVerified]: new Date().toISOString(),
      [W.restrictionText]: redfinPage.description.slice(0, 5000),
      [W.notes]: appendNote(existingNotes, `Redfin confirms off-market.${rentCastActive ? " RentCast had active listing (stale data)." : ""}`),
    });
    return { recordId, address, liveStatus: "Off Market", executionPath: "Reject", source: "Redfin", redfinUrl, keywordScore: null };
  }

  // Case 2: Redfin page loaded, not off-market → run keyword scoring
  if (redfinPage) {
    const kw = scoreDescription(redfinPage.description);
    await patchRecord(recordId, {
      [W.liveStatus]: "Active",
      [W.executionPath]: kw.executionPath,
      [W.verifiedOnMarket]: true,
      [W.verificationSource]: `RentCast (${rentCastActive ? "active" : "empty"}) + Redfin (verified)`,
      [W.verificationUrl]: redfinUrl,
      [W.lastVerified]: new Date().toISOString(),
      [W.restrictionRiskLevel]: kw.riskLevel,
      [W.restrictionKeywordFlag]: kw.keywordFlag,
      [W.restrictionText]: redfinPage.description.slice(0, 5000),
      [W.notes]: appendNote(existingNotes, `Redfin verified active. ${kw.details}`),
    });
    return { recordId, address, liveStatus: "Active", executionPath: kw.executionPath, source: "RentCast+Redfin", redfinUrl, keywordScore: kw.score };
  }

  // Case 3: No Redfin URL found AND RentCast empty → Off Market
  if (!redfinUrl && !rentCastActive) {
    await patchRecord(recordId, {
      [W.liveStatus]: "Off Market",
      [W.executionPath]: "Reject",
      [W.verifiedOnMarket]: false,
      [W.verificationSource]: "RentCast (empty) + Redfin (no URL)",
      [W.lastVerified]: new Date().toISOString(),
      [W.notes]: appendNote(existingNotes, `RentCast: no active listing. Redfin: ${redfin.error ?? "no match found"}. Off Market.`),
    });
    return { recordId, address, liveStatus: "Off Market", executionPath: "Reject", source: "RentCast+Redfin", redfinUrl: null, keywordScore: null };
  }

  // Case 4: Redfin unreachable (blocked, no URL, or page fetch failed)
  // RentCast may say active but we can't confirm → Manual Review
  const sourceNote = [
    `RentCast: ${rentCastActive ? "active" : rentCastError ? `error (${rentCastError})` : "empty"}`,
    redfinUrl ? `Redfin URL found but page ${redfinBlocked ? "blocked (403/captcha)" : "not fetchable"}` : `Redfin: ${redfin.error ?? "no URL found"}`,
  ].join(". ");

  await patchRecord(recordId, {
    [W.liveStatus]: rentCastActive ? "Active" : "URL Not Found",
    [W.executionPath]: "Manual Review",
    [W.verifiedOnMarket]: false,
    [W.verificationSource]: sourceNote,
    ...(redfinUrl ? { [W.verificationUrl]: redfinUrl } : {}),
    [W.lastVerified]: new Date().toISOString(),
    [W.notes]: appendNote(existingNotes, `${sourceNote}. Cannot confirm on Redfin — routing to Manual Review.`),
  });
  return { recordId, address, liveStatus: rentCastActive ? "Active" : "URL Not Found", executionPath: "Manual Review", source: "unconfirmed", redfinUrl, keywordScore: null };
}

// --- Route handler ---

export async function POST(req: Request) {
  if (!AIRTABLE_PAT) {
    return Response.json({ error: "AIRTABLE_PAT not set" }, { status: 500 });
  }
  if (!RENTCAST_API_KEY) {
    return Response.json({ error: "RENTCAST_API_KEY not set — add it to Vercel env vars" }, { status: 500 });
  }

  let body: { recordId?: string; batch?: boolean };
  try {
    const text = await req.text();
    if (!text.trim()) {
      return Response.json({ error: "Empty body" }, { status: 400 });
    }
    body = JSON.parse(text);
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  try {
    // Single record mode
    if (body.recordId) {
      const record = await fetchRecord(body.recordId);
      if (!record || record.rawError) {
        return Response.json(
          { error: "Record not found or Airtable error", detail: record?.rawError ?? "fetchRecord returned null" },
          { status: 404 }
        );
      }

      const result = await verifyOne(body.recordId, record.fields);
      return Response.json({ results: [result], total: 1 });
    }

    // Batch mode — process all unverified
    if (body.batch) {
      const records = await fetchUnverifiedRecords();
      const results: VerifyResult[] = [];

      for (const rec of records) {
        try {
          const result = await verifyOne(rec.id, rec.fields);
          results.push(result);
        } catch (err) {
          results.push({
            recordId: rec.id,
            address: (rec.fields[F.address] as string) ?? "",
            liveStatus: "Error",
            executionPath: "Manual Review",
            source: "error",
            redfinUrl: null,
            keywordScore: null,
            error: String(err),
          });
        }
      }

      const summary = {
        total: results.length,
        active: results.filter((r) => r.liveStatus === "Active").length,
        offMarket: results.filter((r) => r.liveStatus === "Off Market").length,
        manualReview: results.filter((r) => r.executionPath === "Manual Review").length,
        rejected: results.filter((r) => r.executionPath === "Reject").length,
        errors: results.filter((r) => r.error).length,
      };

      return Response.json({ summary, results });
    }

    return Response.json(
      { error: "Provide either recordId (string) or batch (true)" },
      { status: 400 }
    );
  } catch (err) {
    console.error("[verify-listing] Error:", err);
    return Response.json(
      { error: "Verification failed", detail: String(err) },
      { status: 500 }
    );
  }
}
