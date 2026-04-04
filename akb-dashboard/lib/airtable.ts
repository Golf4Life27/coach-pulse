import { Listing, Deal, Buyer } from "./types";

const AIRTABLE_PAT = process.env.AIRTABLE_PAT!;
const BASE_ID = process.env.AIRTABLE_BASE_ID || "appp8inLAGTg4qpEZ";

const LISTINGS_TABLE = "tbldMjKBgPiq45Jjs";
const DEALS_TABLE = "tblKDYhaghKe6dToW";
const BUYERS_TABLE = "tbl4Rr07vq0mTftZB";

// Field IDs
const LISTING_FIELDS: Record<string, string> = {
  fldwvp72hKTfiHHjj: "address",
  fldjbiNuHXzPzVWFk: "city",
  fld9PTaKkgBNtvWbB: "zip",
  fld9J3Vi9fTq3zzMU: "listPrice",
  flduPNI7iLK8Yj07E: "mao",
  fldfsGAAae2mGXzvC: "dom",
  fldyOByFmw33i17I2: "offerTier",
  fldCKnC1nnXEnTUKL: "liveStatus",
  fldOrWvqKcc1g6Lka: "executionPath",
  fldGIgqwyCJg4uFyv: "outreachStatus",
  fldbRrOW3IEoLtnFE: "lastOutreachDate",
  fld69oB0no6tfguom: "agentName",
  fldee9MOstjNDKjnm: "agentPhone",
  fldzdck2fhd6DZ3Oq: "agentEmail",
  fldXrW8CWUphUfKgJ: "verificationUrl",
  fldwKGxZly6O8qyPu: "verificationNotes",
  fldwSjhdhEKVzpVRQ: "distressScore",
  fldpFHAXujnz9x72x: "distressBucket",
  fld5GBaHtwvLY3sq8: "bedrooms",
  fldvZ8hU1aREVg3Gs: "bathrooms",
  fld5bKGJLlN7GmiE9: "buildingSqFt",
  fldA8B9zOCneF0rjp: "stageCalc",
  fldbYzkL24aQ1Y1xz: "approvedForOutreach",
  fldyiFT48fudbF34k: "flipScore",
  fldytROucQFdlPGLm: "offMarketOverride",
  fldapf2ZXpIWTZfSX: "restrictionText",
};

const DEAL_FIELDS: Record<string, string> = {
  fld2AaqbSahBMY62j: "propertyAddress",
  fldoVbMXZxZV08sqG: "city",
  fldGZO10DHc9evl0L: "contractPrice",
  fldnxxzcMRzL1j1hJ: "offerPrice",
  flddXvwvKdx47Xa9X: "assignmentFee",
  flddrZGXOxRn2BqNA: "estimatedRepairs",
  fld00Ag0rvgtUu48R: "arv",
  fldned9bMeMSKWruL: "status",
  fldTvNokAK5AEqz9z: "closingStatus",
  fld7KTawggpBzGwzh: "dispoReady",
  fldACzlhQcnEfy4D4: "propertyImageUrl",
  fldxsnwsG1wExkW96: "beds",
  fldPSZKOxGvU7sLY8: "baths",
  fldExcij4rL2mmYdb: "sqft",
};

const BUYER_FIELDS: Record<string, string> = {
  fldN8egymEy2rQTrt: "buyerName",
  fld7ImZoouFS2Zok2: "buyerEmail",
  fldGGjLc0DUeHVsK7: "buyerStatus",
  fld0ASNdbqufj8e0Y: "preferredCities",
  fldzL2ooNWPZbxJOa: "cashBuyer",
  fldgjfPuBQkfRoebT: "proofOfFundsOnFile",
  fldhZbgY7oTHbuFTO: "buyerActiveFlag",
};

// Simple in-memory cache
const cache: Record<string, { data: unknown; timestamp: number }> = {};
const CACHE_TTL = 60_000; // 60 seconds

function getCached<T>(key: string): T | null {
  const entry = cache[key];
  if (entry && Date.now() - entry.timestamp < CACHE_TTL) {
    return entry.data as T;
  }
  return null;
}

function setCache(key: string, data: unknown): void {
  cache[key] = { data, timestamp: Date.now() };
}

async function fetchAllRecords(
  tableId: string,
  fieldIds: string[]
): Promise<Record<string, unknown>[]> {
  const allRecords: Record<string, unknown>[] = [];
  let offset: string | undefined;

  do {
    const params = new URLSearchParams();
    fieldIds.forEach((f) => params.append("fields[]", f));
    params.set("returnFieldsByFieldId", "true");
    if (offset) params.set("offset", offset);

    const url = `https://api.airtable.com/v0/${BASE_ID}/${tableId}?${params.toString()}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${AIRTABLE_PAT}` },
      cache: "no-store",
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Airtable error ${res.status}: ${errText}`);
    }

    const data = await res.json();
    allRecords.push(...data.records);
    offset = data.offset;
  } while (offset);

  return allRecords;
}

function mapRecord<T>(
  record: Record<string, unknown>,
  fieldMap: Record<string, string>
): T {
  const fields = record.fields as Record<string, unknown>;
  const mapped: Record<string, unknown> = { id: record.id };

  for (const [fieldId, propName] of Object.entries(fieldMap)) {
    mapped[propName] = fields[fieldId] ?? null;
  }

  return mapped as T;
}

export async function getListings(): Promise<Listing[]> {
  const cacheKey = "listings";
  const cached = getCached<Listing[]>(cacheKey);
  if (cached) return cached;

  const records = await fetchAllRecords(
    LISTINGS_TABLE,
    Object.keys(LISTING_FIELDS)
  );
  const listings = records.map((r) => mapRecord<Listing>(r, LISTING_FIELDS));
  setCache(cacheKey, listings);
  return listings;
}

export async function getDeals(): Promise<Deal[]> {
  const cacheKey = "deals";
  const cached = getCached<Deal[]>(cacheKey);
  if (cached) return cached;

  const records = await fetchAllRecords(
    DEALS_TABLE,
    Object.keys(DEAL_FIELDS)
  );
  const deals = records.map((r) => mapRecord<Deal>(r, DEAL_FIELDS));
  setCache(cacheKey, deals);
  return deals;
}

export async function getBuyers(): Promise<Buyer[]> {
  const cacheKey = "buyers";
  const cached = getCached<Buyer[]>(cacheKey);
  if (cached) return cached;

  const records = await fetchAllRecords(
    BUYERS_TABLE,
    Object.keys(BUYER_FIELDS)
  );
  const buyers = records.map((r) => mapRecord<Buyer>(r, BUYER_FIELDS));
  setCache(cacheKey, buyers);
  return buyers;
}

export async function updateListingRecord(
  recordId: string,
  fields: Record<string, unknown>
): Promise<void> {
  const url = `https://api.airtable.com/v0/${BASE_ID}/${LISTINGS_TABLE}/${recordId}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${AIRTABLE_PAT}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ fields }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Airtable update error ${res.status}: ${errText}`);
  }

  // Invalidate listings cache after write
  delete cache["listings"];
}
