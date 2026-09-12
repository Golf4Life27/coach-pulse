// DISPO PACKAGE — the copy kit a human (or a Cowork browser mission) works a
// deal from (2026-09-12).
//
// WHY THIS FILE EXISTS: the buyer hunt happens in the operator's own browser —
// Facebook groups, Marketplace, DMs. Whatever a mission pastes there is public
// forever and is not reviewable after the fact, so the words cannot be
// improvised per-post by a model with the whole Listing in context. They are
// composed HERE, once, deterministically, from the buyer-safe projection only.
//
// The leak posture is structural, not a promise: the ONLY input is
// PublicDealView (lib/dispo/public-deal.ts). ARV, rehab, contract price, the
// wholesale fee, the spread, the agent and the seller are not fields of that
// type, so no amount of later editing in this file can reference them — there
// is nothing to reference. The one money figure that exists on the projection
// is assignmentPrice, and package.test.ts greps the serialized package for the
// literal banned vocabulary so a future "helpful" line fails CI.
//
// Second rule, learned the expensive way (lib/sms/gsm7.ts): ASCII only. One
// em-dash or curly quote in a body that later reaches SMS doubles the billed
// segments. Every string this file returns goes through normalizeForGsm7 and
// then has any surviving non-ASCII character dropped.
//
// Pure. No I/O. Nothing here sends anything: posts.sms is a TEMPLATE the
// operator pastes by hand.

import { dealPageUrl, formatUsd } from "@/lib/dispo/blast-email";
import { DISPO_DISCLOSURE, DISPO_DISCLOSURE_SHORT } from "@/lib/dispo/disclosure";
import type { PublicDealView } from "@/lib/dispo/public-deal";
import { normalizeForGsm7 } from "@/lib/sms/gsm7";

export { DISPO_DISCLOSURE, DISPO_DISCLOSURE_SHORT };

export interface DispoPackageFact {
  label: string;
  value: string;
}

export interface DispoPackage {
  dealUrl: string;
  disclosure: string;
  onePager: {
    title: string;
    facts: DispoPackageFact[];
    body: string[];
  };
  posts: {
    facebookGroup: string;
    marketplaceTitle: string;
    marketplaceDescription: string;
    dmReply: string;
    sms: string;
  };
  photos: string[];
}

/** Hard caps the composer guarantees by construction. */
export const SMS_MAX_CHARS = 300;
export const MARKETPLACE_TITLE_MAX = 80;
export const MARKETPLACE_DESCRIPTION_MAX = 900;
export const DM_REPLY_MAX = 500;

const NON_ASCII = /[^\x20-\x7E\n]/g;

/** GSM-7 normalization first (em-dash -> hyphen, curly quote -> straight),
 *  then drop anything still outside printable ASCII. Belt AND suspenders:
 *  normalizeForGsm7 is a denylist and has been caught short twice. */
function plain(text: string): string {
  return normalizeForGsm7(text).replace(NON_ASCII, "");
}

const CALL_TO_ACTION_POF = "Proof of funds gets the address details and lockbox.";

function nonEmpty(parts: Array<string | null | undefined>): string[] {
  return parts.map((p) => (p ?? "").trim()).filter((p) => p.length > 0);
}

/** "Sep 29, 2026", or null when the date is absent or unparseable. Never
 *  echoes a raw unparseable string into buyer-facing copy. */
function prettyDate(raw: string | null): string | null {
  if (!raw) return null;
  const s = raw.trim();
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T12:00:00Z`) : new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/** Anti-staleness: an inspection window that already closed is worse than no
 *  line at all — it invites a buyer to ask about a deadline that is gone. This
 *  is the only thing opts.nowIso is for. */
function isPast(raw: string | null, nowIso: string): boolean {
  if (!raw) return true;
  const s = raw.trim();
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T23:59:59Z`) : new Date(s);
  const now = new Date(nowIso);
  if (Number.isNaN(d.getTime()) || Number.isNaN(now.getTime())) return false;
  return d.getTime() < now.getTime();
}

/** Truncate on a word boundary so a long address can never blow the SMS cap. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd();
}

/** "3 bed / 2 bath, 1,412 sq ft, built 1968, Single Family" — present fields
 *  only. A null never renders as the string "null". */
function factSentence(view: PublicDealView): string | null {
  const bits: string[] = [];
  if (view.beds != null && view.baths != null) bits.push(`${view.beds} bed / ${view.baths} bath`);
  else if (view.beds != null) bits.push(`${view.beds} bed`);
  else if (view.baths != null) bits.push(`${view.baths} bath`);
  if (view.sqft != null && view.sqft > 0) bits.push(`${Math.round(view.sqft).toLocaleString("en-US")} sq ft`);
  if (view.yearBuilt != null && view.yearBuilt > 0) bits.push(`built ${view.yearBuilt}`);
  if (view.propertyType) bits.push(view.propertyType.trim());
  return bits.length > 0 ? bits.join(", ") : null;
}

function addressLineOf(view: PublicDealView): string {
  const regionLine = nonEmpty([view.state, view.zip]).join(" ");
  const line = nonEmpty([view.address, view.city, regionLine]).join(", ");
  return line.length > 0 ? line : "Investment property";
}

/** City, state and ZIP only. This is what the PUBLIC copy (group post,
 *  Marketplace, SMS, DM) carries. The street address is on the one-pager and
 *  the deal page, which sit behind the intake form. Two reasons, both learned
 *  from other wholesalers' scars: a full address in a public group lets any
 *  buyer go straight to the listing agent around us, and the copy's own call
 *  to action promises the address for proof of funds, so it cannot also give
 *  it away in line one. */
function areaLineOf(view: PublicDealView): string {
  const regionLine = nonEmpty([view.state, view.zip]).join(" ");
  const line = nonEmpty([view.city, regionLine]).join(", ");
  return line.length > 0 ? line : "Investment property";
}

/**
 * Pure. Composes every copy block the buyer hunt needs from the buyer-safe
 * projection. `opts.nowIso` decides only whether the inspection window is
 * still live; `opts.baseUrl` is the public origin the /d/ link hangs off.
 */
export function composeDispoPackage(
  view: PublicDealView,
  opts: { baseUrl: string; nowIso: string },
): DispoPackage {
  const dealUrl = dealPageUrl(opts.baseUrl, view.recordId);
  const addressLine = addressLineOf(view);
  const areaLine = areaLineOf(view);
  // "Contract assignment", not "off-market": some of these houses are on the
  // MLS with a listing agent, and Texas (Occupations Code 1101.0045) lets an
  // unlicensed party market its contract interest, not the property. The
  // headline says exactly what is for sale.
  const headline = `Contract assignment: ${addressLine}`;
  const publicHeadline = `Contract assignment: ${areaLine}`;
  const facts = factSentence(view);
  const priceLine = view.assignmentPrice != null ? `Price: ${formatUsd(view.assignmentPrice)}` : null;
  const closeLabel = prettyDate(view.closeDate);
  const inspectionLabel = isPast(view.optionDeadline, opts.nowIso) ? null : prettyDate(view.optionDeadline);
  const inspectionLine = inspectionLabel ? `Inspection period ends ${inspectionLabel}.` : null;
  const termsLine = closeLabel ? `Cash or hard money, as-is, close by ${closeLabel}.` : "Cash or hard money, as-is.";
  const linkLine = `Details and photos: ${dealUrl}`;

  // ── One-pager: the printable sheet. Ends with the FULL disclosure. ──
  const onePagerFacts: DispoPackageFact[] = [];
  if (view.beds != null) onePagerFacts.push({ label: "Beds", value: String(view.beds) });
  if (view.baths != null) onePagerFacts.push({ label: "Baths", value: String(view.baths) });
  if (view.sqft != null && view.sqft > 0) {
    onePagerFacts.push({ label: "Sq Ft", value: Math.round(view.sqft).toLocaleString("en-US") });
  }
  if (view.yearBuilt != null && view.yearBuilt > 0) {
    onePagerFacts.push({ label: "Year Built", value: String(view.yearBuilt) });
  }
  if (view.propertyType) onePagerFacts.push({ label: "Type", value: plain(view.propertyType.trim()) });
  if (view.assignmentPrice != null) onePagerFacts.push({ label: "Price", value: formatUsd(view.assignmentPrice) });
  if (closeLabel) onePagerFacts.push({ label: "Close By", value: closeLabel });
  if (inspectionLabel) onePagerFacts.push({ label: "Inspection Ends", value: inspectionLabel });

  // The title already carries the address line; the body is the paragraph flow
  // under it, so it does not repeat it.
  const onePagerBody = nonEmpty([
    facts,
    priceLine,
    termsLine,
    inspectionLine,
    linkLine,
    CALL_TO_ACTION_POF,
    DISPO_DISCLOSURE,
  ]).map(plain);

  // ── Facebook group post: 6-10 short lines, two hashtags, no emoji. ──
  const facebookGroup = plain(
    nonEmpty([
      publicHeadline,
      facts,
      priceLine,
      termsLine,
      inspectionLine,
      linkLine,
      CALL_TO_ACTION_POF,
      "#offmarket #cashbuyers",
      DISPO_DISCLOSURE_SHORT,
    ]).join("\n"),
  );

  // ── Marketplace listing. ──
  const titleParts = nonEmpty([
    nonEmpty([view.city, view.state]).join(", ") || view.zip || "Investment property",
    view.beds != null && view.baths != null ? `${view.beds}bd/${view.baths}ba` : null,
    view.assignmentPrice != null ? formatUsd(view.assignmentPrice) : null,
  ]);
  const marketplaceTitle = clip(plain(`Contract assignment: ${titleParts.join(" - ")}`), MARKETPLACE_TITLE_MAX);

  const marketplaceDescription = clip(
    plain(
      nonEmpty([
        publicHeadline,
        facts,
        priceLine,
        termsLine,
        inspectionLine,
        linkLine,
        CALL_TO_ACTION_POF,
        DISPO_DISCLOSURE_SHORT,
      ]).join("\n"),
    ),
    MARKETPLACE_DESCRIPTION_MAX,
  );

  // ── DM reply to a comment of "interested". ──
  const dmReply = clip(
    plain(
      [
        "Thanks for reaching out.",
        `Photos and details: ${dealUrl}`,
        CALL_TO_ACTION_POF,
        DISPO_DISCLOSURE_SHORT,
      ].join(" "),
    ),
    DM_REPLY_MAX,
  );

  // ── SMS template. 300 characters is the hard cap, and the link, the ask and
  // the disclosure are the parts that must survive it — a text that got
  // truncated into "Photos:" with no URL is worse than no text. So parts are
  // added by PRIORITY (link, ask, address, price, facts) and rendered in
  // reading order, dropping the least important until it fits.
  const smsParts: Array<{ priority: number; text: string }> = [
    { priority: 2, text: `Contract assignment: ${areaLine}.` },
    { priority: 4, text: facts ? `${facts}.` : "" },
    { priority: 3, text: priceLine ? `${priceLine}.` : "" },
    { priority: 0, text: `Photos: ${dealUrl}` },
    { priority: 1, text: "POF gets the address details and lockbox." },
  ];
  const keep = smsParts.map(() => false);
  const renderSms = (flags: boolean[]) =>
    [...nonEmpty(smsParts.map((p, i) => (flags[i] ? p.text : ""))), DISPO_DISCLOSURE_SHORT].join(" ");
  for (const idx of smsParts
    .map((p, i) => i)
    .sort((a, b) => smsParts[a].priority - smsParts[b].priority)) {
    if (smsParts[idx].text.length === 0) continue;
    keep[idx] = true;
    if (renderSms(keep).length > SMS_MAX_CHARS) keep[idx] = false;
  }
  const sms = clip(plain(renderSms(keep)), SMS_MAX_CHARS);

  return {
    dealUrl,
    disclosure: DISPO_DISCLOSURE,
    onePager: {
      title: plain(headline),
      facts: onePagerFacts,
      body: onePagerBody,
    },
    posts: { facebookGroup, marketplaceTitle, marketplaceDescription, dmReply, sms },
    photos: view.photos,
  };
}
