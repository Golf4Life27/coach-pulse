// WRITTEN-OFFER LETTER — pure assembly + rendering. @agent: scribe
//
// One-click official offer letter for a listing agent who asks "put it in
// writing". This is an OFFER LETTER, not a purchase contract — the seller's
// agent writes the contract. Nothing in here computes or invents a price:
// the number comes from the sticky stored opener (INVARIANTS §3) or an
// explicit operator-supplied override, and if neither exists we REFUSE
// (INVARIANTS §1 — never a guessed number).
//
// Hard doctrine baked in and covered by tests:
//   - the word "assignable" MUST NOT appear anywhere in the rendered letter
//   - the 10-day inspection / option period is NEVER waived
//   - no ARV, rehab, spread, fee, or any internal math ever reaches the page

export const OFFER_LETTER_BUYER = "AKB Solutions LLC and/or affiliated entities";
export const OFFER_LETTER_SIGNER = "Alex Balog";
export const OFFER_LETTER_COMPANY = "AKB Solutions LLC";
export const OFFER_LETTER_PHONE = "(815) 556-9965";
export const OFFER_LETTER_EMAIL = "alex@akb-properties.com";

/** Never waived — doctrine. */
export const INSPECTION_PERIOD_DAYS = 10;
export const DEFAULT_EMD = 1000;
export const DEFAULT_CLOSE_DAYS = 30;
export const OFFER_VALID_BUSINESS_DAYS = 5;

// ── number → words ───────────────────────────────────────────────────────

const ONES = [
  "Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight",
  "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen",
  "Sixteen", "Seventeen", "Eighteen", "Nineteen",
];
const TENS = [
  "", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty",
  "Ninety",
];
const SCALES: Array<[number, string]> = [
  [1_000_000_000, "Billion"],
  [1_000_000, "Million"],
  [1_000, "Thousand"],
];

function underThousandToWords(n: number): string {
  if (n < 20) return ONES[n];
  if (n < 100) {
    const t = TENS[Math.floor(n / 10)];
    const r = n % 10;
    return r === 0 ? t : `${t}-${ONES[r]}`;
  }
  const h = `${ONES[Math.floor(n / 100)]} Hundred`;
  const r = n % 100;
  return r === 0 ? h : `${h} ${underThousandToWords(r)}`;
}

/** Whole-number → English words, Title Case. Integers only (cents handled
 *  separately by priceInWords). */
export function integerToWords(n: number): string {
  if (!Number.isFinite(n)) throw new Error("integerToWords: non-finite input");
  const whole = Math.floor(Math.abs(n));
  if (whole === 0) return "Zero";
  let rest = whole;
  const parts: string[] = [];
  for (const [value, name] of SCALES) {
    if (rest >= value) {
      parts.push(`${integerToWords(Math.floor(rest / value))} ${name}`);
      rest %= value;
    }
  }
  if (rest > 0) parts.push(underThousandToWords(rest));
  const words = parts.join(" ");
  return n < 0 ? `Negative ${words}` : words;
}

/** "Eighty-Five Thousand and 00/100 Dollars" — the legal long form. */
export function priceInWords(amount: number): string {
  const cents = Math.round((Math.abs(amount) % 1) * 100);
  return `${integerToWords(amount)} and ${String(cents).padStart(2, "0")}/100 Dollars`;
}

/** "$85,000" (whole dollars) or "$85,000.50" when cents are present. */
export function formatMoney(amount: number): string {
  const hasCents = Math.round((Math.abs(amount) % 1) * 100) !== 0;
  return amount.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: hasCents ? 2 : 0,
    maximumFractionDigits: hasCents ? 2 : 0,
  });
}

// ── dates ────────────────────────────────────────────────────────────────

export function formatLetterDate(d: Date): string {
  return d.toLocaleDateString("en-US", {
    month: "long", day: "numeric", year: "numeric", timeZone: "UTC",
  });
}

/** Adds N business days (Mon–Fri) to a date. */
export function addBusinessDays(d: Date, days: number): Date {
  const out = new Date(d.getTime());
  let added = 0;
  while (added < days) {
    out.setUTCDate(out.getUTCDate() + 1);
    const dow = out.getUTCDay();
    if (dow !== 0 && dow !== 6) added++;
  }
  return out;
}

// ── price basis warning (screen-only banner) ─────────────────────────────

export const SIZE_EXTRAPOLATION_MARKER = "SIZE-EXTRAPOLATION REVIEW";

export interface PriceBasisFlagInput {
  renovatedLanguage?: boolean | null;
  notes?: string | null;
}

/** True when this record's price basis is flagged and the operator must
 *  re-price before sending. Screen-only — never printed. */
export function priceBasisFlagged(input: PriceBasisFlagInput): boolean {
  if (input.renovatedLanguage === true) return true;
  const notes = input.notes ?? "";
  return notes.toUpperCase().includes(SIZE_EXTRAPOLATION_MARKER);
}

export function priceBasisFlagReasons(input: PriceBasisFlagInput): string[] {
  const reasons: string[] = [];
  if (input.renovatedLanguage === true) {
    reasons.push("Listing carries RENOVATED language — the ARV basis may describe a renovated comp set, not this property's as-is condition.");
  }
  if ((input.notes ?? "").toUpperCase().includes(SIZE_EXTRAPOLATION_MARKER)) {
    reasons.push("Record is tagged SIZE-EXTRAPOLATION REVIEW — the subject's size sits outside the comp seed's size band.");
  }
  return reasons;
}

// ── assembly ─────────────────────────────────────────────────────────────

export interface OfferLetterAssemblyInput {
  address: string;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  /** Sticky stored opener. NEVER computed here. */
  roughOpenerAmount?: number | null;
  outreachOfferPrice?: number | null;
  /** Explicit operator override from ?price= (already parsed). */
  priceOverride?: number | null;
  emd?: number | null;
  closeDays?: number | null;
  agentName?: string | null;
  renovatedLanguage?: boolean | null;
  notes?: string | null;
  now?: Date;
}

export interface OfferLetterData {
  letterDate: string;
  validThrough: string;
  propertyAddress: string;
  agentName: string | null;
  buyer: string;
  offerPrice: number;
  offerPriceFigures: string;
  offerPriceWords: string;
  priceSource: "override" | "rough_opener" | "outreach_offer_price";
  emd: number;
  emdFigures: string;
  closeDays: number;
  inspectionDays: number;
  flagged: boolean;
  flagReasons: string[];
}

export type OfferLetterAssembly =
  | { ok: true; data: OfferLetterData }
  | { ok: false; status: 422; error: string; message: string };

function positiveOrNull(n: number | null | undefined): number | null {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null;
}

export function formatPropertyAddress(i: {
  address: string; city?: string | null; state?: string | null; zip?: string | null;
}): string {
  const tail = [i.city, [i.state, i.zip].filter(Boolean).join(" ")]
    .map((s) => (s ?? "").trim())
    .filter(Boolean)
    .join(", ");
  return tail ? `${i.address}, ${tail}` : i.address;
}

/** Assemble the letter payload. REFUSES (422) rather than inventing a price. */
export function assembleOfferLetter(input: OfferLetterAssemblyInput): OfferLetterAssembly {
  const override = positiveOrNull(input.priceOverride);
  const rough = positiveOrNull(input.roughOpenerAmount);
  const outreach = positiveOrNull(input.outreachOfferPrice);

  let offerPrice: number | null = null;
  let priceSource: OfferLetterData["priceSource"] = "override";
  if (override != null) {
    offerPrice = override;
    priceSource = "override";
  } else if (rough != null) {
    offerPrice = rough;
    priceSource = "rough_opener";
  } else if (outreach != null) {
    offerPrice = outreach;
    priceSource = "outreach_offer_price";
  }

  if (offerPrice == null) {
    return {
      ok: false,
      status: 422,
      error: "no_offer_price",
      message:
        "This record has no stored offer price (roughOpenerAmount / outreachOfferPrice) and no ?price= override was supplied. " +
        "The offer letter will not compute or invent a number — price the deal first, or pass ?price=<dollars> explicitly.",
    };
  }

  const now = input.now ?? new Date();
  const flagInput = { renovatedLanguage: input.renovatedLanguage, notes: input.notes };
  const emd = positiveOrNull(input.emd) ?? DEFAULT_EMD;
  const closeDays = positiveOrNull(input.closeDays) ?? DEFAULT_CLOSE_DAYS;

  return {
    ok: true,
    data: {
      letterDate: formatLetterDate(now),
      validThrough: formatLetterDate(addBusinessDays(now, OFFER_VALID_BUSINESS_DAYS)),
      propertyAddress: formatPropertyAddress(input),
      agentName: (input.agentName ?? "").trim() || null,
      buyer: OFFER_LETTER_BUYER,
      offerPrice,
      offerPriceFigures: formatMoney(offerPrice),
      offerPriceWords: priceInWords(offerPrice),
      priceSource,
      emd,
      emdFigures: formatMoney(emd),
      closeDays,
      inspectionDays: INSPECTION_PERIOD_DAYS,
      flagged: priceBasisFlagged(flagInput),
      flagReasons: priceBasisFlagReasons(flagInput),
    },
  };
}

// ── rendering ────────────────────────────────────────────────────────────

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Full printable HTML document. Screen-only warning banner is hidden in
 *  print media — the letter that comes out of the printer is clean. */
export function renderOfferLetterHtml(d: OfferLetterData): string {
  const banner = d.flagged
    ? `<div class="screen-only warn">
      <strong>DO NOT SEND AS-IS — PRICE BASIS FLAGGED</strong>
      <p>This record's price basis is flagged. Re-price before sending this letter.</p>
      <ul>${d.flagReasons.map((r) => `<li>${escapeHtml(r)}</li>`).join("")}</ul>
    </div>`
    : "";

  const salutation = d.agentName ? `Dear ${escapeHtml(d.agentName)}:` : "To the Listing Agent:";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Written Offer — ${escapeHtml(d.propertyAddress)}</title>
<style>
  @page { size: letter; margin: 0.9in; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #f4f4f2; color: #111;
         font-family: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, "Times New Roman", serif;
         font-size: 12pt; line-height: 1.55; }
  .sheet { max-width: 8.5in; margin: 24px auto; padding: 0.9in; background: #fff;
           box-shadow: 0 2px 14px rgba(0,0,0,0.12); }
  .letterhead { text-align: center; border-bottom: 2px solid #111; padding-bottom: 10px; margin-bottom: 26px; }
  .letterhead h1 { margin: 0; font-size: 20pt; letter-spacing: 0.06em; text-transform: uppercase; }
  .letterhead .contact { margin-top: 6px; font-size: 10pt; letter-spacing: 0.03em; }
  h2 { font-size: 13pt; margin: 26px 0 8px; text-transform: uppercase; letter-spacing: 0.05em; }
  p { margin: 0 0 12px; }
  .meta { margin-bottom: 22px; }
  .terms { margin: 0 0 12px; padding-left: 22px; }
  .terms li { margin-bottom: 8px; }
  .price { font-weight: bold; }
  .sig { margin-top: 46px; }
  .sig .line { width: 3.1in; border-bottom: 1px solid #111; height: 42px; }
  .sig .name { margin-top: 6px; font-weight: bold; }
  .footnote { margin-top: 30px; font-size: 9.5pt; color: #333; border-top: 1px solid #ccc; padding-top: 10px; }
  .warn { max-width: 8.5in; margin: 24px auto 0; padding: 16px 20px; border: 3px solid #b91c1c;
          background: #fee2e2; color: #7f1d1d; border-radius: 6px; font-family: system-ui, sans-serif; }
  .warn strong { display: block; font-size: 14pt; letter-spacing: 0.04em; }
  .warn p { margin: 8px 0; }
  .warn ul { margin: 8px 0 0; padding-left: 20px; }
  @media print {
    body { background: #fff; }
    .screen-only { display: none !important; }
    .sheet { max-width: none; margin: 0; padding: 0; box-shadow: none; }
  }
</style>
</head>
<body>
${banner}
<div class="sheet">
  <div class="letterhead">
    <h1>${escapeHtml(OFFER_LETTER_COMPANY)}</h1>
    <div class="contact">${escapeHtml(OFFER_LETTER_PHONE)} &nbsp;&bull;&nbsp; ${escapeHtml(OFFER_LETTER_EMAIL)}</div>
  </div>

  <div class="meta">
    <p>${escapeHtml(d.letterDate)}</p>
    <p><strong>RE: Written Offer to Purchase &mdash; ${escapeHtml(d.propertyAddress)}</strong></p>
  </div>

  <p>${salutation}</p>

  <p>Please accept this letter as our written offer to purchase the property located at
  <strong>${escapeHtml(d.propertyAddress)}</strong> on the terms set out below. This letter is an
  offer to purchase and is not itself a purchase contract; upon acceptance we will promptly
  execute the purchase agreement prepared by the seller&rsquo;s representative.</p>

  <h2>Offer Terms</h2>
  <ul class="terms">
    <li><strong>Buyer:</strong> ${escapeHtml(d.buyer)}</li>
    <li><strong>Property:</strong> ${escapeHtml(d.propertyAddress)}</li>
    <li><strong>Purchase Price:</strong> <span class="price">${escapeHtml(d.offerPriceWords)} (${escapeHtml(d.offerPriceFigures)})</span></li>
    <li><strong>Terms:</strong> All cash. No financing contingency and no appraisal contingency.</li>
    <li><strong>Condition:</strong> Property purchased strictly as-is, where-is. Seller is not asked to
      make any repairs, and is not asked to clean out or remove any personal property left behind.</li>
    <li><strong>Inspection / Option Period:</strong> ${d.inspectionDays} days from the date of acceptance
      for buyer&rsquo;s inspection and due diligence.</li>
    <li><strong>Earnest Money Deposit:</strong> ${escapeHtml(d.emdFigures)}, delivered to the closing agent
      or title company of the seller&rsquo;s choosing following execution of the purchase agreement.</li>
    <li><strong>Closing:</strong> On or before a date of the seller&rsquo;s choosing, up to ${d.closeDays} days
      from acceptance.</li>
    <li><strong>Closing Costs:</strong> Buyer pays customary buyer&rsquo;s closing costs; title and closing
      agent selected by the seller.</li>
  </ul>

  <p>This offer is valid for ${OFFER_VALID_BUSINESS_DAYS} business days from the date of this letter,
  through ${escapeHtml(d.validThrough)}. We are a direct cash buyer, we do not require an appraisal or
  lender approval, and we can accommodate the seller&rsquo;s preferred closing date and possession needs.</p>

  <p>Thank you for your time and consideration. Please contact me directly with any questions or with a
  counter-proposal.</p>

  <div class="sig">
    <p>Sincerely,</p>
    <div class="line"></div>
    <div class="name">${escapeHtml(OFFER_LETTER_SIGNER)}</div>
    <div>${escapeHtml(OFFER_LETTER_COMPANY)}</div>
    <div>${escapeHtml(OFFER_LETTER_PHONE)}</div>
    <div>${escapeHtml(OFFER_LETTER_EMAIL)}</div>
  </div>

  <div class="footnote">
    This letter is an offer to purchase real property and is not a binding purchase contract. A binding
    agreement arises only upon execution of a written purchase agreement by both parties.
  </div>
</div>
</body>
</html>`;
}
