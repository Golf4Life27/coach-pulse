// Agent_Prior_Outreach_Count recomputation — pure logic.
//
// Replaces the Make scenario that previously populated this field.
// Make's scan grouped by raw Agent_Phone string, which double-counted
// agents whose phone is stored in different formats ("(713) 231-1129"
// vs "713-231-1129") and missed cross-format matches. Path Y moves
// the logic into the repo so the count signal stays accurate after
// every PropStream intake batch.
//
// Pure function. No I/O. Tested under lib/agent-prior-counts.test.ts.
//
// Semantic (matches the field's original spec):
//   Agent_Prior_Outreach_Count = number of OTHER Listings_V1 records
//   that share this record's normalized Agent_Phone AND have an
//   Outreach_Status of Texted or Negotiating.
//
// "OTHER" excludes the current record itself. A solo listing returns 0.
// Records whose phone can't normalize (null, malformed, or email-in-
// phone-field) are skipped entirely — they get no update row.

import type { Listing } from "@/lib/types";
import { normalizePhone } from "@/lib/phone-normalize";

// Outreach statuses that count as "active outreach" for the sibling
// match. Matches the existing field's intent: agents we've Texted OR
// are currently Negotiating with.
const SIBLING_STATUSES = new Set(["texted", "negotiating"]);

export interface PriorCountUpdate {
  recordId: string;
  agentPhoneRaw: string | null;
  agentPhoneNormalized: string;
  previousCount: number | null;
  newCount: number;
}

export interface PriorCountSkipped {
  recordId: string;
  reason:
    | "phone_failed_to_normalize"
    | "status_not_eligible";
  agentPhoneRaw: string | null;
}

export interface PriorCountResult {
  updates: PriorCountUpdate[];
  skipped: PriorCountSkipped[];
  // Diagnostics — useful in audit logs and for surfacing to humans.
  distinctNormalizedPhones: number;
  phonesOnMultipleListings: number;
}

/**
 * Compute the corrected Agent_Prior_Outreach_Count for every eligible
 * listing. Eligible = status in {Texted, Negotiating} with a phone that
 * normalizes to E.164. Result.updates includes ALL eligible records
 * with their computed count (whether or not it differs from the stored
 * value) — caller decides what to write.
 */
export function computeAgentPriorCounts(listings: Listing[]): PriorCountResult {
  // Phase 1: count siblings per normalized phone (Texted/Negotiating only).
  const phoneToCount = new Map<string, number>();
  for (const l of listings) {
    const status = (l.outreachStatus ?? "").toLowerCase();
    if (!SIBLING_STATUSES.has(status)) continue;
    const normalized = normalizePhone(l.agentPhone);
    if (!normalized) continue;
    phoneToCount.set(normalized, (phoneToCount.get(normalized) ?? 0) + 1);
  }

  // Phase 2: per-record decision. Eligible records get an update row;
  // ineligible records get a skip row with reason.
  const updates: PriorCountUpdate[] = [];
  const skipped: PriorCountSkipped[] = [];
  for (const l of listings) {
    const status = (l.outreachStatus ?? "").toLowerCase();
    if (!SIBLING_STATUSES.has(status)) {
      // Non-Texted/Negotiating records don't get updated. Cadence
      // doesn't read prior_count on them, so stale values are harmless.
      skipped.push({
        recordId: l.id,
        reason: "status_not_eligible",
        agentPhoneRaw: l.agentPhone,
      });
      continue;
    }
    const normalized = normalizePhone(l.agentPhone);
    if (!normalized) {
      skipped.push({
        recordId: l.id,
        reason: "phone_failed_to_normalize",
        agentPhoneRaw: l.agentPhone,
      });
      continue;
    }
    // Self contributes 1 to the total; "OTHER records" = total - 1.
    const total = phoneToCount.get(normalized) ?? 0;
    const newCount = Math.max(0, total - 1);
    updates.push({
      recordId: l.id,
      agentPhoneRaw: l.agentPhone,
      agentPhoneNormalized: normalized,
      previousCount: l.agentPriorOutreachCount ?? null,
      newCount,
    });
  }

  return {
    updates,
    skipped,
    distinctNormalizedPhones: phoneToCount.size,
    phonesOnMultipleListings: [...phoneToCount.values()].filter((c) => c > 1).length,
  };
}

/**
 * Filter updates to just the ones whose new count differs from the
 * stored value. Endpoint uses this to skip noise writes.
 */
export function changedUpdates(updates: PriorCountUpdate[]): PriorCountUpdate[] {
  return updates.filter((u) => (u.previousCount ?? null) !== u.newCount);
}
