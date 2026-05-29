// H2 first-touch outreach — pure routing logic.
// @agent: crier
//
// Migrates the Make scenario `H2. Quo_Outreach_V1` (id 4724197) into the
// repo. Make had a latent bug: when its Airtable "Search Records" module
// returned 0 prior contacts it passed no bundle downstream, so the router
// never fired — first-touch SMS to brand-new agents silently never sent.
// This module reimplements the loop as plain, tested code.
//
// PURE. No I/O, no SMS, no sleep, no clock — the caller (the cron route)
// supplies `nowIso` and performs the Quo send + Airtable write. That keeps
// every routing decision deterministic and unit-testable.
//
// Per eligible record, in order, exactly one of four routes:
//   1. bad_phone_quarantine — Agent_Phone can't normalize to a US E.164
//      number. Write Outreach_Status="Dead", do NOT text.
//   2. prior_contact_stall — another listing already carries a non-empty
//      Outreach_Status for the same agent phone (or this run already
//      first-touched that phone). Write Outreach_Status="Manual Review",
//      do NOT text — a human decides whether to multi-touch.
//   3. skipped — MAO_V1 is null/zero; we will not text "cash offer at $0".
//      No write.
//   4. first_touch — the only path that sends SMS. On send success the
//      route writes Outreach_Status="Texted".
//
// DEVIATIONS from the INV-H2-VERCEL spec (deliberate, see route header):
//   - Prior-contact matching uses normalizePhone (E.164), NOT the spec's
//     raw-string match. Raw match is the exact undercount bug lib/phone-
//     normalize.ts was written to kill; mirroring it here would re-text an
//     agent stored as "713-231-1129" who was already contacted as
//     "(713) 231-1129". The migration exists to fix Make's bugs, not port
//     them. Flip MATCH_NORMALIZED to false to restore literal parity.

import type { Listing } from "@/lib/types";
import { normalizePhone } from "@/lib/phone-normalize";
import { SOURCE_VERSION_V2 } from "@/lib/source-version";

export const AUTO_PROCEED = "Auto Proceed";
export const LIVE_ACTIVE = "Active";

// See deviation note above. Toggle only to restore Make's raw-match parity.
const MATCH_NORMALIZED = true;

export type H2Route =
  | "first_touch"
  | "prior_contact_stall"
  | "bad_phone_quarantine"
  | "skipped";

export interface H2Plan {
  recordId: string;
  address: string;
  city: string;
  agentName: string | null;
  agentPhoneRaw: string | null;
  /** E.164 destination for Quo — non-null only for first_touch. */
  toE164: string | null;
  mao: number | null;
  route: H2Route;
  /** Fully-composed SMS body — non-null only for first_touch. */
  message: string | null;
  /** Why a record was skipped (route === "skipped"). */
  skipReason: string | null;
  /** The prior-contact record that triggered a stall, if any. */
  prior: { recordId: string; address: string; status: string } | null;
}

function outreachStatusEmpty(l: Listing): boolean {
  return !l.outreachStatus || l.outreachStatus.trim() === "";
}

function agentPhonePresent(l: Listing): boolean {
  return !!l.agentPhone && l.agentPhone.trim() !== "";
}

/** Pure: the Airtable eligibility filter (spec §Eligibility). The
 *  Source_Version gate (INV-LEGACY-BACKSTOP) is defense-in-depth — legacy
 *  records are already excluded de facto (non-empty Outreach_Status or
 *  Execution_Path != "Auto Proceed"), but this hard-stops any that slip through. */
export function isH2Eligible(l: Listing): boolean {
  return (
    outreachStatusEmpty(l) &&
    l.liveStatus === LIVE_ACTIVE &&
    l.executionPath === AUTO_PROCEED &&
    l.doNotText !== true &&
    agentPhonePresent(l) &&
    l.sourceVersion === SOURCE_VERSION_V2
  );
}

export function selectH2Eligible(listings: Listing[]): Listing[] {
  return listings.filter(isH2Eligible);
}

/** Key used to detect "same agent" across listings. */
function phoneKey(raw: string | null | undefined): string | null {
  if (MATCH_NORMALIZED) return normalizePhone(raw);
  const v = (raw ?? "").trim();
  return v === "" ? null : v;
}

// Street-type suffixes + directionals dropped when building the address key.
// Dropping directionals is deliberate: it lets "1610 22nd" match "1610 NW
// 22nd St" (the real same-property/two-phone dup that slipped phone-only
// dedupe — Spine recwkHvBMTjeMLECp, 1803 Mardell + 1610 22nd). The cost is
// an occasional over-merge (e.g. "100 N Main" vs "100 S Main") — acceptable
// because the dedupe ACTION is prior_contact_stall → Manual Review (a human
// decides), never a silent kill or a wrong text.
const STREET_SUFFIXES = new Set([
  "st", "street", "ave", "avenue", "dr", "drive", "rd", "road", "ln", "lane",
  "blvd", "boulevard", "ct", "court", "cir", "circle", "pl", "place", "way",
  "ter", "terrace", "trl", "trail", "pkwy", "parkway", "hwy", "highway", "sq",
  "loop", "run", "path", "pass", "cv", "cove", "row", "walk",
]);
const DIRECTIONALS = new Set([
  "n", "s", "e", "w", "ne", "nw", "se", "sw",
  "north", "south", "east", "west", "northeast", "northwest", "southeast", "southwest",
]);

/** Pure: normalize a street address to a dedupe key — house number + street
 *  core, dropping the city/state/zip tail, punctuation, directionals, and
 *  street-type suffixes. Returns null when there's not enough to match safely
 *  (so a blank/number-only address never collides). See STREET_SUFFIXES note.
 *  "1610 22nd, San Antonio, TX 78201"     → "1610|22nd"
 *  "1610 Nw 22nd St, San Antonio, TX ..." → "1610|22nd"
 *  "1803 Mardell St" / "1803 Mardell"     → "1803|mardell" */
export function addressKey(address: string | null | undefined): string | null {
  if (!address) return null;
  const head = address.toLowerCase().split(",")[0];
  const tokens = head.replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return null;
  const num = tokens[0];
  const rest = tokens.slice(1).filter((t) => !DIRECTIONALS.has(t) && !STREET_SUFFIXES.has(t));
  if (rest.length === 0) return null;
  return `${num}|${rest.join(" ")}`;
}

/** Prefix so address keys never collide with phone keys in the shared index. */
const ADDR_PREFIX = "addr:";

/**
 * Pure: build the prior-contact index from the FULL listing set — the set
 * of agent-phone keys that already carry a non-empty Outreach_Status, each
 * mapped to one representative record (for the stall note). A record only
 * counts as prior contact for OTHER records, so the candidate excludes
 * itself by id at lookup time.
 */
export function buildPriorContactIndex(
  listings: Listing[],
): Map<string, { recordId: string; address: string; status: string }> {
  const index = new Map<string, { recordId: string; address: string; status: string }>();
  for (const l of listings) {
    if (outreachStatusEmpty(l)) continue;
    const rec = { recordId: l.id, address: l.address, status: (l.outreachStatus ?? "").trim() };
    // Index by phone (same-agent) AND by normalized address (same-property),
    // independently — a record with a bad phone still contributes its address.
    const pKey = phoneKey(l.agentPhone);
    if (pKey && !index.has(pKey)) index.set(pKey, rec);
    const aKey = addressKey(l.address);
    if (aKey) {
      const k = ADDR_PREFIX + aKey;
      if (!index.has(k)) index.set(k, rec);
    }
  }
  return index;
}

/** Pure: extract the greeting first name from the combined Agent_Name field.
 *  The Listings table has no first/last split — only one Agent_Name string —
 *  so the first whitespace-delimited token is the first name. Empty/blank
 *  falls back to "there". */
export function firstNameOnly(agentName: string | null): string {
  return (agentName ?? "").trim().split(/\s+/)[0] || "there";
}

/** Pure: compose the first-touch SMS body (spec §Step 3).
 *  Greets on FIRST NAME ONLY per the proven outreach rule (5/8/2026). The
 *  RentCast address already carries city/state/zip ("1138 Santa Anna, San
 *  Antonio, TX 78201"), so it is used verbatim — no city clause is appended
 *  (that produced the "…, San Antonio, TX 78201 in San Antonio" redundancy). */
export function buildH2Message(
  agentName: string | null,
  address: string,
  mao: number,
): string {
  const name = firstNameOnly(agentName);
  const offer = `$${Math.round(mao).toLocaleString("en-US")}`;
  return (
    `Hi ${name}, this is Alex with AKB Solutions. I am interested in your ` +
    `listing at ${address}. I would like to make a cash offer at ${offer} ` +
    `with a quick close. Is the seller open to offers in that range?`
  );
}

function append(existing: string | null, line: string): string {
  const prior = existing ?? "";
  return prior ? `${prior}\n\n${line}` : line;
}

export function buildSentNote(
  existing: string | null,
  iso: string,
  messageId: string | null,
  message: string,
): string {
  return append(existing, `[H2 sent ${iso}] Quo msg ${messageId ?? "(no id)"}: ${message}`);
}

export function buildStallNote(
  existing: string | null,
  iso: string,
  prior: { recordId: string; address: string; status: string },
): string {
  return append(
    existing,
    `[H2 stall ${iso}] Prior contact found at record ${prior.recordId} ` +
      `(${prior.address}, status: ${prior.status})`,
  );
}

export function buildQuarantineNote(
  existing: string | null,
  iso: string,
  originalPhone: string | null,
): string {
  return append(existing, `[H2 quarantine ${iso}] Bad phone format: '${originalPhone ?? ""}'`);
}

/**
 * Pure: plan the route for an in-order queue of eligible records.
 *
 * Sequential because same-agent listings within a single run must not both
 * first-touch: the first occurrence sends, every later occurrence stalls
 * (matching the prior outreach-fire batch-dedup behaviour). `seenThisRun`
 * threads that state. The static `priorIndex` covers prior contact from
 * earlier runs / other statuses.
 */
export function planQueue(
  queue: Listing[],
  priorIndex: Map<string, { recordId: string; address: string; status: string }>,
): H2Plan[] {
  const seenThisRun = new Map<string, { recordId: string; address: string }>();
  const seenAddrThisRun = new Map<string, { recordId: string; address: string }>();
  const plans: H2Plan[] = [];

  for (const l of queue) {
    const base = {
      recordId: l.id,
      address: l.address,
      city: l.city,
      agentName: l.agentName,
      agentPhoneRaw: l.agentPhone,
      mao: l.mao,
      toE164: null as string | null,
      message: null as string | null,
      skipReason: null as string | null,
      prior: null as H2Plan["prior"],
    };

    // Step 1 — phone validation.
    const e164 = normalizePhone(l.agentPhone);
    if (!e164) {
      plans.push({ ...base, route: "bad_phone_quarantine" });
      continue;
    }

    const key = phoneKey(l.agentPhone)!;
    const aKey = addressKey(l.address);

    // Step 2 — prior contact. Two independent dedupe axes, both → stall:
    //   (a) same AGENT phone, (b) same PROPERTY address. The address axis
    //   closes the same-property/two-phone gap that let 1803 Mardell + 1610
    //   22nd both first-touch (Spine recwkHvBMTjeMLECp). Prior-run/other-status
    //   hits first, then within-this-run hits.
    const priorHit = priorIndex.get(key);
    if (priorHit && priorHit.recordId !== l.id) {
      plans.push({ ...base, route: "prior_contact_stall", prior: priorHit });
      continue;
    }
    const priorAddrHit = aKey ? priorIndex.get(ADDR_PREFIX + aKey) : undefined;
    if (priorAddrHit && priorAddrHit.recordId !== l.id) {
      plans.push({ ...base, route: "prior_contact_stall", prior: priorAddrHit });
      continue;
    }
    const runHit = seenThisRun.get(key);
    if (runHit) {
      plans.push({
        ...base,
        route: "prior_contact_stall",
        prior: { recordId: runHit.recordId, address: runHit.address, status: "Texted (this run)" },
      });
      continue;
    }
    const runAddrHit = aKey ? seenAddrThisRun.get(aKey) : undefined;
    if (runAddrHit) {
      plans.push({
        ...base,
        route: "prior_contact_stall",
        prior: { recordId: runAddrHit.recordId, address: runAddrHit.address, status: "Texted (this run)" },
      });
      continue;
    }

    // Step 3 — MAO guard (never text "cash offer at $0").
    if (l.mao == null || l.mao <= 0) {
      plans.push({ ...base, route: "skipped", skipReason: "mao_null_or_zero" });
      continue;
    }

    // Step 4 — first touch.
    seenThisRun.set(key, { recordId: l.id, address: l.address });
    if (aKey) seenAddrThisRun.set(aKey, { recordId: l.id, address: l.address });
    plans.push({
      ...base,
      route: "first_touch",
      toE164: e164,
      message: buildH2Message(l.agentName, l.address, l.mao),
    });
  }

  return plans;
}
