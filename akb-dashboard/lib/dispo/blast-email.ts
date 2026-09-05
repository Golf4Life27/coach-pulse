// DISPO BLAST — deterministic buyer email + recipient selection (2026-09-05).
//
// The cron (app/api/cron/dispo-trigger) fires this automatically the first
// time it sees a contract executed with no blast on record. No LLM in the
// path on purpose: an automated send to a buyer list must be word-for-word
// predictable and testable against the ONE-NUMBER rule — a buyer sees the
// assignment price and basic property facts, never contract price, ARV,
// rehab, fee, spread, agent, or seller detail.
//
// Pure. No I/O.

import type { ShortlistResult } from "@/lib/dispo/buyer-shortlist";

export interface BlastEmailInput {
  buyerName: string | null;
  address: string;
  city: string | null;
  state: string | null;
  zip: string | null;
  beds: number | null;
  baths: number | null;
  sqft: number | null;
  assignmentPrice: number;
  /** YYYY-MM-DD or ISO; rendered as a plain date. */
  optionDeadline: string | null;
  dealUrl: string;
}

export interface BlastEmail {
  subject: string;
  body: string;
}

export function formatUsd(n: number): string {
  return "$" + Math.round(n).toLocaleString("en-US");
}

function firstName(name: string | null): string {
  const f = (name ?? "").trim().split(/\s+/)[0] ?? "";
  return f.length > 0 ? f : "there";
}

function prettyDate(raw: string | null): string | null {
  if (!raw) return null;
  const s = raw.trim();
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T12:00:00Z`) : new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** Public deal page URL — the ONE link a buyer gets. */
export function dealPageUrl(baseUrl: string, recordId: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/d/${recordId}`;
}

export function composeDispoBlastEmail(input: BlastEmailInput): BlastEmail {
  const cityLine = [input.city, input.state].filter(Boolean).join(", ") + (input.zip ? ` ${input.zip}` : "");
  const facts: string[] = [];
  if (input.beds != null || input.baths != null) {
    facts.push(`${input.beds ?? "?"} bed / ${input.baths ?? "?"} bath`);
  }
  if (input.sqft != null && input.sqft > 0) facts.push(`${Math.round(input.sqft).toLocaleString("en-US")} sq ft`);
  const factLine = facts.length > 0 ? facts.join(", ") : null;
  const deadline = prettyDate(input.optionDeadline);

  const lines = [
    `Hi ${firstName(input.buyerName)},`,
    ``,
    `We just put ${input.address}${cityLine ? ` (${cityLine.trim()})` : ""} under contract and it's available off-market.`,
    ``,
    `Assignment price: ${formatUsd(input.assignmentPrice)}`,
    ...(factLine ? [factLine] : []),
    `Cash close, ${deadline ? `inspection window through ${deadline}` : "10-day inspection window"}.`,
    ``,
    `Photos and details: ${input.dealUrl}`,
    ``,
    `Reply to this email or text me at (815) 556-9965 if you want to walk it. First buyer with proof of funds gets it.`,
    ``,
    `— Alex`,
    `AKB Solutions`,
    `(815) 556-9965`,
  ];
  return {
    subject: `Off-market: ${input.address}${input.city ? `, ${input.city}` : ""} — ${formatUsd(input.assignmentPrice)}`,
    body: lines.join("\n"),
  };
}

export interface BlastRecipient {
  buyerId: string;
  name: string;
  email: string;
  score: number;
  reasons: string[];
}

/**
 * Pure. Picks who gets the automatic email: the shortlist's callable top
 * slice (already inside the buyer's stated box), email on file, one send per
 * address. Buyers with no email are the operator's phone list, not ours.
 */
export function selectBlastRecipients(shortlist: ShortlistResult, max: number): BlastRecipient[] {
  const seen = new Set<string>();
  const out: BlastRecipient[] = [];
  for (const b of shortlist.top) {
    const email = (b.email ?? "").trim().toLowerCase();
    if (!email || !email.includes("@") || seen.has(email)) continue;
    seen.add(email);
    out.push({ buyerId: b.buyerId, name: b.name, email, score: b.score, reasons: b.reasons });
    if (out.length >= max) break;
  }
  return out;
}

/** Deal_Photo_URLs wire format — a JSON array string the public page parses. */
export function photoUrlsJson(photos: ReadonlyArray<{ url: string }>): string {
  const urls = Array.from(new Set(photos.map((p) => p.url).filter((u) => typeof u === "string" && u.length > 0)));
  return JSON.stringify(urls.slice(0, 12));
}
