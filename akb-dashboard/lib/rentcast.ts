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
  if (!RENTCAST_API_KEY) return null;
  const url = `${BASE}/avm/value?${buildAvmParams(input).toString()}`;
  const res = await fetch(url, {
    headers: { "X-Api-Key": RENTCAST_API_KEY },
    cache: "no-store",
  });
  if (!res.ok) {
    if (res.status === 404 || res.status === 422) return null;
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

export async function getSaleComparables(input: AvmInput): Promise<RentCastSaleComp[]> {
  if (!RENTCAST_API_KEY) return [];
  const url = `${BASE}/avm/sale-comparables?${buildAvmParams(input).toString()}`;
  const res = await fetch(url, {
    headers: { "X-Api-Key": RENTCAST_API_KEY },
    cache: "no-store",
  });
  if (!res.ok) {
    if (res.status === 404 || res.status === 422) return [];
    const errText = await res.text().catch(() => "");
    throw new Error(`RentCast avm/sale-comparables ${res.status}: ${errText}`);
  }
  const data = (await res.json()) as Record<string, unknown>;
  const raw = (data.comparables as Array<Record<string, unknown>>) ?? [];
  return raw.map((c) => ({
    price: (c.price as number) ?? null,
    squareFootage: (c.squareFootage as number) ?? null,
    bedrooms: (c.bedrooms as number) ?? null,
    bathrooms: (c.bathrooms as number) ?? null,
    yearBuilt: (c.yearBuilt as number) ?? null,
    distance: (c.distance as number) ?? null,
    daysOnMarket: (c.daysOnMarket as number) ?? null,
    removedDate: (c.removedDate as string) ?? null,
    saleDate: (c.saleDate as string) ?? null,
  }));
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
