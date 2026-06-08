// ATTOM Data intake source adapter (Ship 2 — replaces PropStream).
// @agent: scout
//
// Base: https://api.gateway.attomdata.com/propertyapi/v1.0.0
// Auth: header `apikey: <ATTOM_API_KEY>` + `accept: application/json`
// Discovery: /property/snapshot?postalcode={zip}
//
// fetchListingsByZip(zip) → IntakeCandidate[] (the vendor-agnostic shape
// lib/crawler/intake-filter.ts consumes).
//
// ⚠️ FIELD-PATH + ENDPOINT CAVEATS (surfaced to operator 2026-05-25):
//   1. Could not run OpenAPI codegen in the build container, and
//      ATTOM_API_KEY is prod-only (no live call from here to inspect a
//      real response). The mapping below follows ATTOM property/snapshot
//      v1.0.0's DOCUMENTED shape and is defensively coded (optional
//      chaining throughout) — it MUST be validated against the live
//      response on the first dry-run before going live.
//   2. /property/snapshot returns property characteristics + sale +
//      assessment history. It does NOT carry active-MLS LIST PRICE or
//      LISTING DATE — those live in ATTOM's listings/MLS package
//      (separate endpoint + entitlement). listPrice + listedDate below
//      resolve to null today, so the intake filter will reject every
//      candidate on list_price_missing / listed_date_missing until the
//      listings endpoint is wired. This is the open blocker, not a bug.
//   3. Distress signal: snapshot doesn't expose foreclosure/lien flags
//      by default; hasDistressSignal defaults false pending the events/
//      assessment package. Flagged.

import type { IntakeCandidate } from "@/lib/crawler/intake-filter";
import { auditPaidCall } from "@/lib/spend/audit-paid-call";

const ATTOM_API_KEY = process.env.ATTOM_API_KEY;
const ATTOM_BASE = "https://api.gateway.attomdata.com/propertyapi/v1.0.0";

/** Pure: build the snapshot discovery URL for a ZIP. */
export function buildSnapshotUrl(zip: string, base: string = ATTOM_BASE): string {
  const u = new URL(`${base}/property/snapshot`);
  u.searchParams.set("postalcode", zip);
  return u.toString();
}

// Minimal structural view of an ATTOM property object (documented v1.0.0
// snapshot shape). Every field optional — defensive against drift.
interface AttomProperty {
  identifier?: { attomId?: number; Id?: number };
  address?: { line1?: string; locality?: string; countrySubd?: string; postal1?: string };
  summary?: { proptype?: string; propclass?: string; propsubtype?: string; yearbuilt?: number };
  building?: { rooms?: { beds?: number }; size?: { livingsize?: number; universalsize?: number } };
  sale?: { amount?: { saleamt?: number }; salesearchdate?: string };
  assessment?: unknown;
  vintage?: unknown;
}

interface AttomSnapshotResponse {
  status?: { code?: number; msg?: string; total?: number };
  property?: AttomProperty[];
}

/** Pure: map one ATTOM property object → vendor-agnostic IntakeCandidate.
 *  listPrice / listedDate are null by design (snapshot lacks active-MLS
 *  fields — see header caveat #2). Testable without network. */
export function mapSnapshotToCandidate(p: AttomProperty): IntakeCandidate {
  const sourceId =
    p.identifier?.attomId != null
      ? `attom:${p.identifier.attomId}`
      : p.identifier?.Id != null
        ? `attom:${p.identifier.Id}`
        : `attom:${p.address?.line1 ?? "unknown"}:${p.address?.postal1 ?? ""}`;
  return {
    sourceId,
    address: p.address?.line1 ?? null,
    city: p.address?.locality ?? null,
    state: p.address?.countrySubd ?? null,
    zip: p.address?.postal1 ?? null,
    propertyType: p.summary?.propsubtype ?? p.summary?.proptype ?? p.summary?.propclass ?? null,
    beds: p.building?.rooms?.beds ?? null,
    // listPrice + listedDate: NOT in /property/snapshot. null until the
    // ATTOM listings/MLS endpoint is wired (open blocker).
    listPrice: null,
    listedDate: null,
    // ATTOM /property/snapshot carries no listing-agent contact — null by
    // design (ATTOM is retained for the Underwriter, not active-MLS intake).
    agentName: null,
    agentPhone: null,
    agentEmail: null,
    brokerageName: null,
  };
}

/** Pure: map a full snapshot response → candidates. */
export function mapSnapshotResponse(body: AttomSnapshotResponse): IntakeCandidate[] {
  if (!Array.isArray(body.property)) return [];
  return body.property.map(mapSnapshotToCandidate);
}

export interface AttomFetchResult {
  candidates: IntakeCandidate[];
  credentialed: boolean;
  error: string | null;
  raw_count: number;
}

/** Fetch + normalize ATTOM snapshot for one ZIP. Returns credentialed=false
 *  (no candidates) when ATTOM_API_KEY is unset — caller surfaces it.
 *  Throws are caught and returned as `error` so a single bad ZIP doesn't
 *  abort the cron's ZIP loop. */
export async function fetchListingsByZip(zip: string): Promise<AttomFetchResult> {
  if (!ATTOM_API_KEY) {
    return { candidates: [], credentialed: false, error: "ATTOM_API_KEY not set", raw_count: 0 };
  }
  const t0 = Date.now();
  try {
    const res = await fetch(buildSnapshotUrl(zip), {
      headers: { apikey: ATTOM_API_KEY, accept: "application/json" },
      cache: "no-store",
    });
    await auditPaidCall({
      source: "attom",
      endpoint: "property/snapshot",
      http: res.status,
      ms: Date.now() - t0,
      error: res.ok ? undefined : `HTTP ${res.status}`,
    });
    if (!res.ok) {
      return {
        candidates: [],
        credentialed: true,
        error: `ATTOM snapshot ${res.status}: ${await res.text().catch(() => "")}`.slice(0, 300),
        raw_count: 0,
      };
    }
    const body = (await res.json()) as AttomSnapshotResponse;
    const candidates = mapSnapshotResponse(body);
    return { candidates, credentialed: true, error: null, raw_count: candidates.length };
  } catch (err) {
    await auditPaidCall({
      source: "attom",
      endpoint: "property/snapshot",
      http: -1,
      ms: Date.now() - t0,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      candidates: [],
      credentialed: true,
      error: err instanceof Error ? err.message : String(err),
      raw_count: 0,
    };
  }
}
