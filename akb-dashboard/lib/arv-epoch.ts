// ARV engine epoch — the trust boundary for stored ARV stamps. @agent: appraiser
//
// WHY (2026-07-17, the 1122 West Ave contamination, PR #126): every ARV
// stamped before the sold-comps-only engine deployed was produced by an
// engine that (a) fabricated sale dates for active listings and (b) let the
// subject property comp against itself. A read-only sweep of all 197 stamped
// records found 185 contaminated — 161 with a MAJORITY of comps tainted.
// Those numbers are not stale; they are fiction.
//
// THE MECHANISM: rather than hand-editing 185 records (the daily-manual-fix
// anti-pattern), the stamp itself carries the verdict. A stamp EARLIER than
// the epoch is untrusted — the freshness gates (engaged-underwrite select,
// P2 done-gate ARV leg) treat it as "never underwritten", and the existing
// crons re-run every record through the fixed engine on their own schedule,
// hottest deals first. Zero record edits; the system heals itself.

/** The moment the CURRENT ARV engine was live in production. Stamps at or
 *  after this instant came from it. Env-overridable (ARV_ENGINE_EPOCH,
 *  ISO 8601). Advance lineage: 07-17 lastSeenDate kill · 07-18 AM
 *  removedDate kill · 07-18 PM deed-record feed · 07-19 AM 365d window ·
 *  07-19 PM county-deed source live for Detroit (open government ledger,
 *  sales days old vs the vendor's ~9-12mo lag) · 07-20 ATTOM /sale/snapshot
 *  promoted to primary for non-registry markets (benchmark 37/8/19/45
 *  qualifying comps vs RentCast's 1/0/1/0; RentCast demoted to audited
 *  last resort). Each advance re-invalidates every earlier stamp and the
 *  crons re-verify the fleet on their own schedule — the designed
 *  engine-revision mechanism. */
export const ARV_SOLD_COMPS_EPOCH_ISO = "2026-07-20T01:10:00.000Z";

function epochMs(): number {
  const raw = process.env.ARV_ENGINE_EPOCH;
  if (raw) {
    const t = Date.parse(raw);
    if (Number.isFinite(t)) return t;
  }
  return Date.parse(ARV_SOLD_COMPS_EPOCH_ISO);
}

/** Pure: is this ARV_Validated_At stamp from the fixed engine? Null,
 *  unparseable, or pre-epoch → NOT trusted (treat as never underwritten). */
export function arvStampTrusted(stampIso: string | null | undefined): boolean {
  if (!stampIso) return false;
  const t = Date.parse(stampIso);
  if (!Number.isFinite(t)) return false;
  return t >= epochMs();
}
