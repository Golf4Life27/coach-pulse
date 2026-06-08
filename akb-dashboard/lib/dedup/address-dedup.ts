// Address-level dedup analysis (pure) — v1_legacy vs v2 collision finder.
//
// The 346 Modder case (a v2 'Response Received' record AND a v1_legacy
// ScraperAPI record for the same property, the legacy one sitting at
// outreach_ready) showed the dedup gap is real and a double-contact risk.
// This groups every listing by normalized address and surfaces the
// collisions, flagging the ones that can actually double-contact.

import { normalizeAddressKey } from "@/lib/crawler/intake-filter";
import { SOURCE_VERSION_V2 } from "@/lib/source-version";

export interface DedupListing {
  id: string;
  address: string | null;
  sourceVersion: string | null;
  pipelineStage?: string | null;
  outreachStatus: string | null;
  liveStatus: string | null;
  doNotText: boolean;
}

// Pipeline stages at which a record is contactable (so a live dupe here is
// a double-contact risk). Mirrors the H2/Crier outreach-eligible band.
const CONTACTABLE_STAGES = new Set([
  "verified",
  "outreach_ready",
  "outreach_sent",
  "responded",
  "negotiating",
]);

export interface DedupGroup {
  addressKey: string;
  /** A representative human-readable address from the group. */
  sampleAddress: string | null;
  records: DedupListing[];
  hasV2: boolean;
  hasV1: boolean;
  /** v1↔v2 collision: a legacy dupe of a v2-surface record. */
  crossVersion: boolean;
  /** At least 2 records that could each still be contacted. */
  doubleContactRisk: boolean;
  /** The record ids that drive the double-contact risk. */
  contactableIds: string[];
}

function isContactable(l: DedupListing): boolean {
  if (l.doNotText) return false;
  if (l.liveStatus && l.liveStatus.toLowerCase() !== "active") return false;
  const stage = l.pipelineStage ?? "";
  if (stage === "dead") return false;
  // A record with no stage but an active/empty outreach status still counts.
  if (stage && !CONTACTABLE_STAGES.has(stage)) return false;
  return true;
}

/** Pure: group listings by normalized address, keep only true collisions
 *  (>1 record), and flag cross-version + double-contact risk. Sorted with
 *  the riskiest groups first. */
export function analyzeAddressDedup(listings: DedupListing[]): DedupGroup[] {
  const byKey = new Map<string, DedupListing[]>();
  for (const l of listings) {
    const key = normalizeAddressKey(l.address);
    if (!key) continue; // blank address → can't dedup, skip
    const arr = byKey.get(key) ?? [];
    arr.push(l);
    byKey.set(key, arr);
  }

  const groups: DedupGroup[] = [];
  for (const [addressKey, records] of byKey) {
    if (records.length < 2) continue;
    const hasV2 = records.some((r) => r.sourceVersion === SOURCE_VERSION_V2);
    const hasV1 = records.some((r) => r.sourceVersion !== SOURCE_VERSION_V2);
    const contactable = records.filter(isContactable);
    groups.push({
      addressKey,
      sampleAddress: records.find((r) => r.address)?.address ?? null,
      records,
      hasV2,
      hasV1,
      crossVersion: hasV2 && hasV1,
      doubleContactRisk: contactable.length >= 2,
      contactableIds: contactable.map((r) => r.id),
    });
  }

  // Riskiest first: double-contact, then cross-version, then group size.
  groups.sort((a, b) => {
    if (a.doubleContactRisk !== b.doubleContactRisk) return a.doubleContactRisk ? -1 : 1;
    if (a.crossVersion !== b.crossVersion) return a.crossVersion ? -1 : 1;
    return b.records.length - a.records.length;
  });
  return groups;
}

export interface DedupSummary {
  total_listings: number;
  collision_groups: number;
  cross_version_groups: number;
  double_contact_groups: number;
  /** Total records sitting in a collision group. */
  records_in_collisions: number;
}

export function summarizeDedup(listings: DedupListing[], groups: DedupGroup[]): DedupSummary {
  return {
    total_listings: listings.length,
    collision_groups: groups.length,
    cross_version_groups: groups.filter((g) => g.crossVersion).length,
    double_contact_groups: groups.filter((g) => g.doubleContactRisk).length,
    records_in_collisions: groups.reduce((n, g) => n + g.records.length, 0),
  };
}
