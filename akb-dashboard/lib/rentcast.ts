// RentCast API helpers — AS-IS valuation + sale comparables.
//
// Existing /api/verify-listing already uses RentCast for active-listing
// confirmation; here we add the AVM endpoints used by /api/arv-validate.

const RENTCAST_API_KEY = process.env.RENTCAST_API_KEY;
const BASE = "https://api.rentcast.io/v1";

export interface RentCastAvmValue {
  price: number | null;
  priceLow: number | null;
  priceHigh: number | null;
  comparables?: unknown;
}

export interface RentCastSaleComp {
  price: number | null;
  squareFootage: number | null;
  bedrooms: number | null;
  bathrooms: number | null;
  yearBuilt: number | null;
  distance: number | null;
  daysOnMarket: number | null;
  removedDate: string | null;
  saleDate: string | null;
}

interface AvmInput {
  address: string;
  city: string;
  state: string;
  zip: string;
  bedrooms?: number | null;
  bathrooms?: number | null;
  squareFootage?: number | null;
}

function buildAvmParams(input: AvmInput): URLSearchParams {
  const p = new URLSearchParams({
    address: input.address,
    city: input.city,
    state: input.state,
    zipCode: input.zip,
  });
  if (input.bedrooms != null) p.set("bedrooms", String(input.bedrooms));
  if (input.bathrooms != null) p.set("bathrooms", String(input.bathrooms));
  if (input.squareFootage != null) p.set("squareFootage", String(input.squareFootage));
  return p;
}

export async function getAvmValue(input: AvmInput): Promise<RentCastAvmValue | null> {
  if (!RENTCAST_API_KEY) {
    throw new Error("RENTCAST_API_KEY not set");
  }
  const url = `${BASE}/avm/value?${buildAvmParams(input).toString()}`;
  const res = await fetch(url, {
    headers: { "X-Api-Key": RENTCAST_API_KEY },
    cache: "no-store",
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`RentCast avm/value ${res.status}: ${errText}`);
  }
  const data = (await res.json()) as Record<string, unknown>;
  return {
    price: (data.price as number) ?? null,
    priceLow: (data.priceRangeLow as number) ?? null,
    priceHigh: (data.priceRangeHigh as number) ?? null,
    comparables: data.comparables,
  };
}

// RentCast doesn't publish a standalone /avm/sale-comparables endpoint;
// comparables are embedded in the /avm/value response. Earlier code hit
// /avm/sale-comparables which 404'd, and silently coerced the 404 to []
// — exactly the swallowed-error pattern the Positive Confirmation
// Principle (Rule 5) forbids. Now we call /avm/value, throw on non-2xx
// (caller surfaces to UI/audit), and let a zero-length comparables list
// be visible as a yellow flag, not invisible success.
export async function getSaleComparables(input: AvmInput): Promise<RentCastSaleComp[]> {
  if (!RENTCAST_API_KEY) {
    throw new Error("RENTCAST_API_KEY not set");
  }
  const url = `${BASE}/avm/value?${buildAvmParams(input).toString()}`;
  const res = await fetch(url, {
    headers: { "X-Api-Key": RENTCAST_API_KEY },
    cache: "no-store",
  });

  const bodyText = await res.text();
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(bodyText) as Record<string, unknown>;
  } catch {
    throw new Error(
      `RentCast avm/value ${res.status}: non-JSON body (${bodyText.slice(0, 200)})`,
    );
  }

  if (!res.ok) {
    // 404 == "property not found in RentCast index" — a real signal, not
    // success. Propagate so caller can surface it.
    throw new Error(
      `RentCast avm/value ${res.status}: ${JSON.stringify(data)}`,
    );
  }

  const raw = Array.isArray(data.comparables)
    ? (data.comparables as Array<Record<string, unknown>>)
    : [];
  return raw.map((c) => ({
    price: (c.price as number) ?? null,
    squareFootage: (c.squareFootage as number) ?? null,
    bedrooms: (c.bedrooms as number) ?? null,
    bathrooms: (c.bathrooms as number) ?? null,
    yearBuilt: (c.yearBuilt as number) ?? null,
    distance: (c.distance as number) ?? null,
    daysOnMarket: (c.daysOnMarket as number) ?? null,
    removedDate: (c.removedDate as string) ?? null,
    saleDate:
      (c.saleDate as string) ??
      (c.lastSeenDate as string) ??
      (c.removedDate as string) ??
      null,
  }));
}

// RentCast rent AVM. Returns the monthly rent estimate + range. Used by
// Phase 4C landlord-track math. Principle-compliant: throws on non-2xx
// (callers must surface to audit + UI). Empty/null results are valid
// signals — caller decides how to handle (e.g., flag deal as no-rent-data
// rather than silently zero out the landlord track).
export interface RentCastRentEstimate {
  rent: number | null;
  rentLow: number | null;
  rentHigh: number | null;
  raw: unknown;
}

export async function getRentEstimate(input: AvmInput): Promise<RentCastRentEstimate> {
  if (!RENTCAST_API_KEY) {
    throw new Error("RENTCAST_API_KEY not set");
  }
  const url = `${BASE}/avm/rent/long-term?${buildAvmParams(input).toString()}`;
  const res = await fetch(url, {
    headers: { "X-Api-Key": RENTCAST_API_KEY },
    cache: "no-store",
  });

  const bodyText = await res.text();
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(bodyText) as Record<string, unknown>;
  } catch {
    throw new Error(
      `RentCast avm/rent/long-term ${res.status}: non-JSON body (${bodyText.slice(0, 200)})`,
    );
  }

  if (!res.ok) {
    throw new Error(
      `RentCast avm/rent/long-term ${res.status}: ${JSON.stringify(data)}`,
    );
  }

  return {
    rent: (data.rent as number) ?? null,
    rentLow: (data.rentRangeLow as number) ?? null,
    rentHigh: (data.rentRangeHigh as number) ?? null,
    raw: data,
  };
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
