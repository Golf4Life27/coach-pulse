export const runtime = "nodejs";
export const maxDuration = 60;

const AIRTABLE_PAT = process.env.AIRTABLE_PAT!;
const BASE_ID = process.env.AIRTABLE_BASE_ID || "appp8inLAGTg4qpEZ";
const LISTINGS_TABLE = "tbldMjKBgPiq45Jjs";
const RENTCAST_API_KEY = process.env.RENTCAST_API_KEY!;

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

const W = {
  liveStatus: "fldCKnC1nnXEnTUKL",
  executionPath: "fldOrWvqKcc1g6Lka",
  verifiedOnMarket: "fldCxApxYiiB8eYFI",
  verificationSource: "flddEHrMOoBPVfqgk",
  lastVerified: "fld2eUkKaC4pMjIdd",
  notes: "fldwKGxZly6O8qyPu",
  restrictionRiskLevel: "fld5dV65Wr9b6bjo3",
  restrictionKeywordFlag: "fldSpBUMzTzFtp59k",
};

// --- RentCast API ---

async function queryRentCast(
  address: string, city: string, state: string, zip: string
): Promise<Record<string, unknown>[]> {
  const params = new URLSearchParams({
    address, city, state, zipCode: zip, status: "active",
  });

  const res = await fetch(
    `https://api.rentcast.io/v1/listings/sale?${params.toString()}`,
    { headers: { "X-Api-Key": RENTCAST_API_KEY }, cache: "no-store" }
  );

  if (!res.ok) {
    if (res.status === 404 || res.status === 422) return [];
    const errText = await res.text();
    throw new Error(`RentCast error ${res.status}: ${errText}`);
  }

  return await res.json();
}

// --- Flip detection ---

const FLIP_THRESHOLD = 2.0; // list price >= 2x last sale = flip
const FLIP_WINDOW_MONTHS = 24;

interface FlipCheck {
  flipDetected: boolean;
  flipScore: number;
  lastSalePrice: number | null;
  lastSaleDate: string | null;
  priceRatio: number | null;
  details: string;
}

function checkFlip(listing: Record<string, unknown>): FlipCheck {
  const listPrice = listing.price as number | undefined;
  const lastSalePrice = listing.lastSalePrice as number | undefined;
  const lastSaleDate = listing.lastSaleDate as string | undefined;

  if (!listPrice || !lastSalePrice || !lastSaleDate) {
    return {
      flipDetected: false, flipScore: 0,
      lastSalePrice: lastSalePrice ?? null,
      lastSaleDate: lastSaleDate ?? null,
      priceRatio: null,
      details: "No sale history available for flip check.",
    };
  }

  const saleDate = new Date(lastSaleDate);
  const monthsAgo = (Date.now() - saleDate.getTime()) / (1000 * 60 * 60 * 24 * 30);
  const ratio = listPrice / lastSalePrice;

  if (monthsAgo > FLIP_WINDOW_MONTHS) {
    return {
      flipDetected: false, flipScore: 0,
      lastSalePrice, lastSaleDate,
      priceRatio: Math.round(ratio * 100) / 100,
      details: `Last sale $${lastSalePrice.toLocaleString()} on ${lastSaleDate} (${Math.round(monthsAgo)}mo ago, outside ${FLIP_WINDOW_MONTHS}mo window).`,
    };
  }

  const flipDetected = ratio >= FLIP_THRESHOLD;
  // Score 0-10: 0 = no flip concern, 10 = extreme flip
  const flipScore = flipDetected ? Math.min(10, Math.round((ratio - 1) * 5)) : Math.round(Math.max(0, (ratio - 1) * 3));

  return {
    flipDetected,
    flipScore,
    lastSalePrice,
    lastSaleDate,
    priceRatio: Math.round(ratio * 100) / 100,
    details: flipDetected
      ? `FLIP DETECTED: List $${listPrice.toLocaleString()} is ${ratio.toFixed(1)}x last sale $${lastSalePrice.toLocaleString()} (${lastSaleDate}, ${Math.round(monthsAgo)}mo ago).`
      : `Last sale $${lastSalePrice.toLocaleString()} on ${lastSaleDate} (${Math.round(monthsAgo)}mo ago). Ratio: ${ratio.toFixed(1)}x. No flip concern.`,
  };
}

// --- Stale data check ---

const STALE_DAYS = 7;

function isStaleData(lastSeenDate: string | undefined): { stale: boolean; daysSince: number | null } {
  if (!lastSeenDate) return { stale: true, daysSince: null };
  const d = new Date(lastSeenDate);
  if (isNaN(d.getTime())) return { stale: true, daysSince: null };
  const days = Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24));
  return { stale: days > STALE_DAYS, daysSince: days };
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
      { headers: { Authorization: `Bearer ${AIRTABLE_PAT}` }, cache: "no-store" }
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

async function patchRecord(recordId: string, fields: Record<string, unknown>): Promise<void> {
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

const NEVER_RESURFACE = new Set([
  "2715 monterey st", "714 hallie ave", "4330 pensacola ct",
  "9618 tamalpais dr", "811 manhattan dr", "1635 arbor pl",
  "4448 marcell ave", "2725 bowling green ave", "2011 ramsey ave",
  "707 n pine st", "8641 craige dr", "910 green st",
]);

// --- Main verification ---

interface VerifyResult {
  recordId: string;
  address: string;
  liveStatus: string;
  executionPath: string;
  source: string;
  flipDetected: boolean;
  flipScore: number;
  flipDetails: string;
  rentCast: {
    status: string | null;
    price: number | null;
    dom: number | null;
    lastSeenDate: string | null;
    lastSalePrice: number | null;
    lastSaleDate: string | null;
    stale: boolean;
  };
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

  const emptyResult = (overrides: Partial<VerifyResult>): VerifyResult => ({
    recordId, address, liveStatus: "Unknown", executionPath: "Reject",
    source: "skip", flipDetected: false, flipScore: 0, flipDetails: "",
    rentCast: { status: null, price: null, dom: null, lastSeenDate: null, lastSalePrice: null, lastSaleDate: null, stale: false },
    ...overrides,
  });

  if (!address.trim()) {
    return emptyResult({ error: "Empty address" });
  }

  if (NEVER_RESURFACE.has(address.trim().toLowerCase())) {
    await patchRecord(recordId, {
      [W.executionPath]: "Reject",
      [W.notes]: appendNote(existingNotes, "Auto-rejected: never-resurface list."),
      [W.lastVerified]: new Date().toISOString(),
    });
    return emptyResult({ liveStatus: "Rejected", source: "blocklist" });
  }

  if (!isValidPhone(agentPhone)) {
    await patchRecord(recordId, {
      [W.executionPath]: "Manual Review",
      [W.notes]: appendNote(existingNotes, "Agent phone missing or invalid."),
      [W.lastVerified]: new Date().toISOString(),
    });
    return emptyResult({ executionPath: "Manual Review", source: "phone_validation" });
  }

  // RentCast query
  let rcListings: Record<string, unknown>[] = [];
  try {
    rcListings = await queryRentCast(address, city, state, zip);
  } catch (err) {
    await patchRecord(recordId, {
      [W.liveStatus]: "Off Market",
      [W.executionPath]: "Reject",
      [W.verifiedOnMarket]: false,
      [W.verificationSource]: `RentCast error: ${String(err)}`,
      [W.lastVerified]: new Date().toISOString(),
      [W.notes]: appendNote(existingNotes, `RentCast error: ${String(err)}.`),
    });
    return emptyResult({ liveStatus: "Off Market", source: "RentCast-error", error: String(err) });
  }

  if (rcListings.length === 0) {
    await patchRecord(recordId, {
      [W.liveStatus]: "Off Market",
      [W.executionPath]: "Reject",
      [W.verifiedOnMarket]: false,
      [W.verificationSource]: "RentCast (no active listing)",
      [W.lastVerified]: new Date().toISOString(),
      [W.notes]: appendNote(existingNotes, "RentCast: no active listing found. Off Market."),
    });
    return emptyResult({ liveStatus: "Off Market", source: "RentCast" });
  }

  const rc = rcListings[0];
  const rcStatus = (rc.status as string) ?? null;
  const rcPrice = (rc.price as number) ?? null;
  const rcDom = (rc.daysOnMarket as number) ?? null;
  const rcLastSeen = (rc.lastSeenDate as string) ?? null;

  // Flip detection
  const flip = checkFlip(rc);

  // Stale data check
  const staleCheck = isStaleData(rcLastSeen ?? undefined);

  const rcData = {
    status: rcStatus, price: rcPrice, dom: rcDom,
    lastSeenDate: rcLastSeen,
    lastSalePrice: flip.lastSalePrice,
    lastSaleDate: flip.lastSaleDate,
    stale: staleCheck.stale,
  };

  console.log(`[verify] ${address}: RentCast status=${rcStatus}, price=${rcPrice}, dom=${rcDom}, lastSeen=${rcLastSeen}, stale=${staleCheck.stale}, flip=${flip.flipDetected} (${flip.priceRatio}x)`);

  // Decision: flip detected → Manual Review
  if (flip.flipDetected) {
    await patchRecord(recordId, {
      [W.liveStatus]: "Active",
      [W.executionPath]: "Manual Review",
      [W.verifiedOnMarket]: true,
      [W.verificationSource]: "RentCast",
      [W.lastVerified]: new Date().toISOString(),
      [W.restrictionRiskLevel]: "High",
      [W.restrictionKeywordFlag]: true,
      [W.notes]: appendNote(existingNotes, `RentCast active. ${flip.details}`),
    });
    return {
      recordId, address, liveStatus: "Active", executionPath: "Manual Review",
      source: "RentCast", flipDetected: true, flipScore: flip.flipScore,
      flipDetails: flip.details, rentCast: rcData,
    };
  }

  // Decision: stale lastSeenDate → Manual Review
  if (staleCheck.stale) {
    const staleNote = staleCheck.daysSince !== null
      ? `lastSeenDate is ${staleCheck.daysSince} days old (threshold: ${STALE_DAYS}).`
      : "No lastSeenDate — data freshness unknown.";
    await patchRecord(recordId, {
      [W.liveStatus]: "Active",
      [W.executionPath]: "Manual Review",
      [W.verifiedOnMarket]: true,
      [W.verificationSource]: "RentCast (stale data)",
      [W.lastVerified]: new Date().toISOString(),
      [W.notes]: appendNote(existingNotes, `RentCast active but stale. ${staleNote} ${flip.details}`),
    });
    return {
      recordId, address, liveStatus: "Active", executionPath: "Manual Review",
      source: "RentCast-stale", flipDetected: false, flipScore: flip.flipScore,
      flipDetails: flip.details, rentCast: rcData,
    };
  }

  // Active, fresh, no flip → Auto Proceed
  await patchRecord(recordId, {
    [W.liveStatus]: "Active",
    [W.executionPath]: "Auto Proceed",
    [W.verifiedOnMarket]: true,
    [W.verificationSource]: "RentCast",
    [W.lastVerified]: new Date().toISOString(),
    [W.restrictionRiskLevel]: flip.flipScore > 0 ? "Low" : "None",
    [W.restrictionKeywordFlag]: false,
    [W.notes]: appendNote(existingNotes, `RentCast verified active (price: $${rcPrice?.toLocaleString() ?? "?"}, DOM: ${rcDom ?? "?"}, lastSeen: ${rcLastSeen ?? "?"}). ${flip.details}`),
  });
  return {
    recordId, address, liveStatus: "Active", executionPath: "Auto Proceed",
    source: "RentCast", flipDetected: false, flipScore: flip.flipScore,
    flipDetails: flip.details, rentCast: rcData,
  };
}

// --- Route handler ---

export async function POST(req: Request) {
  if (!AIRTABLE_PAT) {
    return Response.json({ error: "AIRTABLE_PAT not set" }, { status: 500 });
  }
  if (!RENTCAST_API_KEY) {
    return Response.json({ error: "RENTCAST_API_KEY not set" }, { status: 500 });
  }

  let body: { recordId?: string; recordIds?: string[]; batch?: boolean };
  try {
    const text = await req.text();
    if (!text.trim()) return Response.json({ error: "Empty body" }, { status: 400 });
    body = JSON.parse(text);
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  try {
    // Single record
    if (body.recordId) {
      const record = await fetchRecord(body.recordId);
      if (!record || record.rawError) {
        return Response.json(
          { error: "Record not found", detail: record?.rawError },
          { status: 404 }
        );
      }
      const result = await verifyOne(body.recordId, record.fields);
      return Response.json({ results: [result], total: 1 });
    }

    // Multiple specific records
    if (body.recordIds && Array.isArray(body.recordIds)) {
      const results: VerifyResult[] = [];
      for (const rid of body.recordIds.slice(0, 50)) {
        try {
          const record = await fetchRecord(rid);
          if (!record || record.rawError) {
            results.push({
              recordId: rid, address: "", liveStatus: "Error", executionPath: "Manual Review",
              source: "error", flipDetected: false, flipScore: 0, flipDetails: "",
              rentCast: { status: null, price: null, dom: null, lastSeenDate: null, lastSalePrice: null, lastSaleDate: null, stale: false },
              error: record?.rawError ?? "not found",
            });
            continue;
          }
          results.push(await verifyOne(rid, record.fields));
        } catch (err) {
          results.push({
            recordId: rid, address: "", liveStatus: "Error", executionPath: "Manual Review",
            source: "error", flipDetected: false, flipScore: 0, flipDetails: "",
            rentCast: { status: null, price: null, dom: null, lastSeenDate: null, lastSalePrice: null, lastSaleDate: null, stale: false },
            error: String(err),
          });
        }
      }
      return Response.json({ results, total: results.length });
    }

    // Batch unverified
    if (body.batch) {
      const records = await fetchUnverifiedRecords();
      const results: VerifyResult[] = [];
      for (const rec of records) {
        try {
          results.push(await verifyOne(rec.id, rec.fields));
        } catch (err) {
          results.push({
            recordId: rec.id, address: (rec.fields[F.address] as string) ?? "",
            liveStatus: "Error", executionPath: "Manual Review",
            source: "error", flipDetected: false, flipScore: 0, flipDetails: "",
            rentCast: { status: null, price: null, dom: null, lastSeenDate: null, lastSalePrice: null, lastSaleDate: null, stale: false },
            error: String(err),
          });
        }
      }
      const summary = {
        total: results.length,
        autoProceed: results.filter((r) => r.executionPath === "Auto Proceed").length,
        manualReview: results.filter((r) => r.executionPath === "Manual Review").length,
        rejected: results.filter((r) => r.executionPath === "Reject").length,
        flipsDetected: results.filter((r) => r.flipDetected).length,
        errors: results.filter((r) => r.error).length,
      };
      return Response.json({ summary, results });
    }

    return Response.json(
      { error: "Provide recordId, recordIds (array), or batch: true" },
      { status: 400 }
    );
  } catch (err) {
    console.error("[verify-listing] Error:", err);
    return Response.json({ error: "Verification failed", detail: String(err) }, { status: 500 });
  }
}
