// Seller-reply triage — the single source of truth for classifying an
// inbound SMS reply and routing it to the right needs-decision queue.
//
// Two consumers share this module (no parallel copies):
//   - /api/scan-replies   sets the record's Outreach_Status from the
//                         classification (the queue STATE on the record).
//   - /api/cron/scan-comms attaches the triage to the jarvis_reply proposal
//                         (the queue ITEM the operator acts on), so a genuine
//                         seller reply arrives with WHAT decision it needs,
//                         not a bare echo of the text.
//
// Self-echo / bot-autoreply stripping lives in lib/conversation-check.ts
// (isSelfEchoOrAutoreply); callers filter those out BEFORE triage — this
// module assumes the body is a genuine human inbound.
//
// Pure. No I/O. Tested in lib/reply-triage.test.ts.

export type ReplyClassification =
  | "rejection"
  | "soft_no"
  | "interest"
  | "counter"
  | "acceptance"
  // RECOMMENDED-REPLIES extension (operator 2026-07-12, the 9360 Cheyenne
  // miss: "Are you covering costs? There is a water bill, and a tax bill...
  // And I need to be paid." fell through to UNCLASSIFIED with no next step):
  | "seller_costs"     // who-pays questions: liens, back taxes, bills, commission
  | "offer_format"     // "email me your offer" / GAR-TREC form / in-writing requests
  | "appointment"      // showing / walkthrough / scheduled-call steps
  | "disclosure_step"  // IABS / consumer-protection / read-and-agree compliance
  | "unknown";

/** Alert routing tier (operator 2026-06-10). Maverick's SMS channel is
 *  reserved for decisions and urgency; it MUST NOT announce that a text
 *  arrived (Quo already does that). Three tiers, mutually exclusive:
 *
 *   tier_0_auto_close — high-confidence rejection. System sends a polite
 *                       close (no prices, no numbers, max one per thread,
 *                       standard send rails). NO ALERT, no proposal.
 *   tier_1_decision   — interest, counter, unknown. Needs-decision proposal
 *                       + SMS that LEADS with the decision (never the body).
 *   tier_2_urgent     — acceptance / strong-buy signals. "ACT NOW:" prefix.
 */
export type AlertTier = "tier_0_auto_close" | "tier_1_decision" | "tier_2_urgent";

/** Acceptance — the seller said yes / asked for the contract. Checked FIRST
 *  (before rejection) because the rejection patches match "accepted ... offer"
 *  shapes; a true "we accept your offer" must not be eaten by them. Patterns
 *  are deliberately narrow: a strong-buy signal, not generic positivity. */
const ACCEPTANCE_PATTERNS = [
  /\bsend\s+(?:me\s+)?(?:the\s+|a\s+)?contract\b/i,
  /\bseller\s+(?:will|would)\s+take\s+(?:it|that|your)\b/i,
  /\bwe(?:'ll|\s+will)?\s+take\s+(?:it|that|your\s+offer)\b/i,
  /\b(?:we|seller|they)\s+accepts?\s+(?:it|that|your\s+offer)\b/i,
  /\byour\s+offer\s+(?:is|was|has\s+been)\s+accepted\b/i,
  /\blet'?s\s+(?:do\s+it|move\s+forward|get\s+it\s+done)\b/i,
  /\bwrite\s+(?:it|the\s+offer|the\s+contract)\s+up\b/i,
];

/** HARD rejection — the thread must die and STAY dead. Two shapes only:
 *  (a) compliance opt-outs (STOP/unsubscribe/do-not-contact) — non-negotiable,
 *  never re-engaged, feeds the opt-out rails; (b) gone-deals (sold, under
 *  contract, escrow, withdrawn, comparing-offers-in-hand) — there is nothing
 *  left to re-engage. Route: tier_0 auto-close → Dead.
 *
 *  P1 split (2026-07-08, ruling context recmy2Vwp1wMA1Vs8 era): STANCE
 *  rejections ("not interested", "no go", "too low") moved OUT of this list
 *  to SOFT_NO_PATTERNS — a seller saying no-at-this-price-today is a
 *  re-engagement candidate, not a corpse. 2718 Ave I's "No go" died
 *  UNCLASSIFIED under the old list; that class now routes to the 2A queue
 *  with an operator-approved re-engagement draft. */
const REJECTION_PATTERNS = [
  /\bstop\b/i,
  /\bunder contract\b/i,
  /\boff the market\b/i,
  /\bsold\b/i,
  /\bexpired\b/i,
  /\bremove\b.*\bnumber\b/i,
  /\bdo not\b.*\b(text|contact|call)\b/i,
  /\bunsubscribe\b/i,
  /\bno longer\b.*\b(available|listed)\b/i,
  /\bwithdrawn\b/i,
  /\bpending\b/i,
  // Patches 2026-06-10 — shrink the UNCLASSIFIED bucket toward "rejection"
  // ONLY when paired with an acceptance / possession / commitment verb (the
  // seller is comparing OUR offer to another deal in hand, not asking us to
  // come up). A bare "higher offer" is intentionally NOT enough — "send me
  // a higher offer" is interest, not rejection. UNCLASSIFIED → manual review
  // fallback is preserved (lib/reply-triage.determineNewStatus's "unknown"
  // path). Today's first live reply (13235 Freeland: "in the process of
  // accepting a much higher offer") is the anchor case; pattern 1 catches
  // it via "accepting" + up to 5 words + "offer".
  /\b(?:accepted|accepting)\b\s+(?:[a-z]+\s+){0,5}\boffer\b/i,
  /\b(?:got|have|received)\s+(?:a\s+|an\s+)?(?:another|higher|better|stronger|cash)\s+offer\b/i,
  /\bgoing\s+(?:with|to\s+go\s+with)\s+(?:another|a\s+different|a\s+higher|the)\s+(?:offer|buyer)\b/i,
  /\bin\s+escrow\b/i,
];

/** SOFT NO — the seller (or agent) declined our number or isn't selling
 *  TODAY, in plain language. The thread is alive: these route tier_1 with an
 *  operator-approved re-engagement draft queued as a Type 2A proposal (never
 *  auto-sent). The two pricing-flavored shapes (too low / firm at / not at
 *  that price) surface as decisionKind "pricing". Bare "no" and "no go" were
 *  the P1 anchor cases (2718 Ave I). */
const SOFT_NO_PATTERNS = [
  /\bnot interested\b/i,
  /\bno,?\s+thanks?\b/i,
  /\bno thank you\b/i,
  /\bno[\s-]+go\b/i,
  /\bnope\b/i,
  /^\s*no[.!]*\s*$/i, // a bare "no" — the shortest rejection there is
  /\bseller said no\b/i,
  /\bpass\b/i,
  /\bnot for sale\b/i,
  /\bnot selling\b/i,
  /\bnot\s+(?:looking|planning|trying)\s+to\s+sell\b/i,
  /\bwe'?re good\b/i,
  /\ball set\b/i,
  /\bnot right now\b/i,
  /\bmaybe\s+(?:later|down the road|in the future)\b/i,
  // pricing-flavored soft-nos (decisionKind "pricing"):
  /\btoo low\b/i,
  /\bfirm at\b/i,
  /\bnot at (?:that|this) price\b/i,
  // Negated interest + "no"-shapes (2026-07-17, the 3226 Cloverhurst miss):
  // "It's a fast no at $156K. The sellers aren't interested in low ball
  // offers." sailed past "not interested" (contraction) and landed on
  // INTEREST via the bare \binterested\b pattern below — the auto-ack then
  // thanked the agent for their interest. Negation outranks the noun it
  // negates, always; these run BEFORE the interest list by construction.
  /\b(?:isn'?t|aren'?t|ain'?t|wasn'?t|weren'?t|no longer)\s+(?:\w+\s+)?interested\b/i,
  /\bno\s+interest\b/i,
  /\b(?:fast|hard|quick|firm|definite)\s+no\b/i,
  /\bno\s+at\s+\$?\d/i,
  /\b(?:it|that)'?s\s+a\s+(?:no|pass)\b/i,
  /\blow[\s-]?ball/i,
];

/** The soft-no subset whose real message is "your NUMBER is wrong", not
 *  "go away" — routed as a pricing decision. */
const PRICE_OBJECTION_RE = /\btoo low\b|\bfirm at\b|\bnot at (?:that|this) price\b|\blow[\s-]?ball|\bno\s+at\s+\$?\d/i;

/** Seller-cost / lien / commission questions — the money-STRUCTURE class.
 *  The seller isn't objecting to the price; they're asking who pays what.
 *  Doctrine for the draft: everything is paid FROM PROCEEDS AT CLOSING —
 *  never "on top of" the offer; lien/estate validity is the title company's
 *  fact to verify. Anchor case: 9360 Cheyenne (water bill + tax bill +
 *  "I need to be paid" + "let me call the lien holder"). */
const SELLER_COSTS_PATTERNS = [
  /\b(?:are\s+you|you\s+guys?|will\s+you|would\s+you|who(?:'s|\s+is)?)\s+(?:covering|paying|pays?|cover)\b/i,
  /\b(?:cover|covering|pay|paying|pays)\b[^.?!]{0,60}\b(?:costs?|fees?|bills?|commission|tax(?:es)?)\b/i,
  /\b(?:water|tax|utility|sewer|gas|electric)\s+bill\b/i,
  /\bback\s+tax(?:es)?\b/i,
  /\blien\s*(?:s|holder|holders)?\b/i,
  /\bcommission\b/i,
  /\bclosing\s+costs?\b/i,
  /\bi\s+need\s+to\s+(?:be|get)\s+paid\b/i,
  /\bwhat(?:'s| is| will)\s+(?:my|the\s+seller'?s?)\s+net\b/i,
];

/** Offer-format / delivery-mechanics requests — the seller/agent wants the
 *  offer in a specific shape or channel. High-intent (they're processing the
 *  offer), zero pricing content. */
const OFFER_FORMAT_PATTERNS = [
  /\bemail\s+(?:me\s+)?(?:the\s+|your\s+|an?\s+)?offer\b/i,
  /\b(?:gar|trec|far\s?bar)\b[^.?!]{0,30}\b(?:form|contract)\b/i,
  /\bon\s+(?:a\s+)?(?:gar|trec|far\s?bar|state)\s+(?:form|contract)\b/i,
  /\b(?:official|formal|written)\s+offer\b/i,
  /\bin\s+writing\b/i,
  /\bsubmit\s+(?:it|the\s+offer|your\s+offer)?\s*(?:through|via|to|on)\b/i,
  /\bput\s+(?:it|that|the\s+offer)\s+(?:in\s+writing|on\s+paper|in\s+an?\s+email)\b/i,
];

/** Appointment / next-step scheduling — showings, walkthroughs, timed calls.
 *  (A bare "call me" stays interest; a TIMED or place-bound ask lands here.) */
const APPOINTMENT_PATTERNS = [
  /\b(?:schedule|scheduling)\b/i,
  /\bappointment\b/i,
  /\b(?:showing|walk[\s-]?through|walkthrough)\b/i,
  /\bcome\s+(?:see|by|out|take\s+a\s+look)\b/i,
  /\bmeet\s+(?:you\s+)?(?:at|there|at\s+the\s+property|on\s+site)\b/i,
  /\bcall\s+me\s+(?:at|around|after|before|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
  /\bcalendly\b/i,
  /\b(?:available|free)\s+(?:at|on|tomorrow|this\s+week)\b/i,
];

/** Compliance-disclosure steps (IABS etc.) — the machine NEVER acknowledges
 *  a legal disclosure on the operator's behalf; this class always HOLDs with
 *  the reason surfaced (draft policy lives in lib/recommended-reply). */
const DISCLOSURE_PATTERNS = [
  /\biabs\b/i,
  /\binformation\s+about\s+brokerage\s+services\b/i,
  /\bconsumer\s+protection\s+notice\b/i,
  /\bread\s+and\s+agree\b/i,
  /\b(?:sign|review|acknowledge)\b[^.?!]{0,40}\bdisclosures?\b/i,
  /\bdisclosures?\b[^.?!]{0,40}\b(?:sign|review|acknowledge)\b/i,
];

const INTEREST_PATTERNS = [
  /\byes\b/i,
  /\binterested\b/i,
  /\bsend\s*(me|it|the|a|your)\b/i,
  /\bsend\s*offer\b/i,
  /\bcounter\b/i,
  /\bcome up\b/i,
  /\bbest offer\b/i,
  /\bproof of funds\b/i,
  /\bemail\s*me\b/i,
  /\bcall\s*me\b/i,
  /\bsubmit\b/i,
  /\bhow\s*(much|soon|quick)\b/i,
  /\bwhat.*offer\b/i,
  /\bcan you\s*(do|go|come)\b/i,
  /\bwould\s*you\s*consider\b/i,
  /\blet'?s\s*talk\b/i,
  /\$\s*\d/i, // dollar amount mentioned
];

// A counter is detected when the seller quotes a specific number range or
// floor — distinct from a generic interest signal. We require a price
// reference plus counter-flavored language.
const COUNTER_PRICE_RE = /\$\s*\d{1,3}[\s,.]?(?:\d{3}|k)\b/i;
const COUNTER_LANGUAGE_PATTERNS = [
  /\bcounter\b/i,
  /\bcome\s+(?:up|down)\b/i,
  /\bin\s+the\s+\$?\d/i,
  /\b(?:looking|hoping)\s+(?:for|at)\s+\$?\d/i,
  /\bbest\s+(?:and\s+)?final\b/i,
  /\bnet\s+(?:to|of)\b/i,
  /\bhighest\s+(?:we'?ll|i'?ll|they'?ll)\s+(?:go|do)\b/i,
  /\b(?:lowest|min(?:imum)?)\s+(?:they|seller|we)\b/i,
  /\bmeet\s+(?:in\s+the\s+)?middle\b/i,
  /\bif\s+you\s+can\s+(?:do|come|go)\s+\$?\d/i,
  // "I need $120k…" / "my lowest is…" — a quoted floor is a counter even
  // when it arrives wrapped in cost language (the number conversation wins).
  /\b(?:i|we|they|seller)\s+need\s+\$?\d/i,
  /\b(?:my|our|their)\s+(?:lowest|bottom|floor|number)\b/i,
];

/** Pure: classify a genuine inbound reply. Rejection wins over everything
 *  (a "not interested at $X" is still a rejection). A counter needs BOTH a
 *  price token AND counter language; otherwise a price/interest signal is
 *  plain interest. */
export function classifyReply(body: string): {
  classification: ReplyClassification;
  matchedPattern: string | null;
} {
  const trimmed = (body ?? "").trim();
  if (!trimmed) return { classification: "unknown", matchedPattern: null };

  // Acceptance FIRST — a true "we accept your offer" must not be eaten by
  // the rejection patches (which match "accepted ... offer" shapes when the
  // seller is comparing us to another deal in hand).
  for (const pat of ACCEPTANCE_PATTERNS) {
    if (pat.test(trimmed)) return { classification: "acceptance", matchedPattern: pat.source };
  }

  for (const pat of REJECTION_PATTERNS) {
    if (pat.test(trimmed)) return { classification: "rejection", matchedPattern: pat.source };
  }

  // Soft-no AFTER hard rejection (a "sold, no thanks" is still gone-deal) and
  // BEFORE counter/interest ("not at that price" must not read as interest
  // via its price token).
  for (const pat of SOFT_NO_PATTERNS) {
    if (pat.test(trimmed)) return { classification: "soft_no", matchedPattern: pat.source };
  }

  // Disclosure steps BEFORE everything price-flavored — an IABS blast often
  // contains zero deal content and must never draft an acknowledgment.
  for (const pat of DISCLOSURE_PATTERNS) {
    if (pat.test(trimmed)) return { classification: "disclosure_step", matchedPattern: pat.source };
  }

  // A multiplier counter carries its number implicitly — "you'll need to
  // double it" IS a price (2× the sticky offer) with no $ token. The 7714
  // E Canfield anchor (2026-07-17): "Youll need to double it" fell to
  // UNKNOWN and the thread kept getting robo-bumped at the old number.
  const mult = /\b(?:double|triple)\s+(?:it|that|the\s+(?:offer|price|number)|your\s+(?:offer|number))\b/i;
  if (mult.test(trimmed)) {
    return { classification: "counter", matchedPattern: mult.source };
  }

  // A counter (price token + counter language) outranks seller_costs — "I
  // need $120k to cover the liens" is a NUMBER conversation first.
  if (COUNTER_PRICE_RE.test(trimmed)) {
    for (const pat of COUNTER_LANGUAGE_PATTERNS) {
      if (pat.test(trimmed)) return { classification: "counter", matchedPattern: pat.source };
    }
  }

  // Seller-costs BEFORE interest — "are you covering closing costs?" must
  // not degrade to generic interest via a stray pattern.
  for (const pat of SELLER_COSTS_PATTERNS) {
    if (pat.test(trimmed)) return { classification: "seller_costs", matchedPattern: pat.source };
  }

  for (const pat of OFFER_FORMAT_PATTERNS) {
    if (pat.test(trimmed)) return { classification: "offer_format", matchedPattern: pat.source };
  }

  for (const pat of APPOINTMENT_PATTERNS) {
    if (pat.test(trimmed)) return { classification: "appointment", matchedPattern: pat.source };
  }

  for (const pat of INTEREST_PATTERNS) {
    if (pat.test(trimmed)) return { classification: "interest", matchedPattern: pat.source };
  }

  return { classification: "unknown", matchedPattern: null };
}

/** Pure: the Outreach_Status a reply should move the record to, given its
 *  current status. null = no change. Rejection → Dead; counter → Counter
 *  Received (resurrects a Dead record); interest → Negotiating; an unknown
 *  but genuine reply only promotes a still-"Texted" record to Response
 *  Received (never downgrades an already-advanced record). */
export function determineNewStatus(
  classification: ReplyClassification,
  currentStatus: string | null,
): string | null {
  if (classification === "rejection") return "Dead";
  // Soft-no: the thread stays ALIVE in the needs-decision lane. Promote a
  // first-touch/parked record to Response Received; never downgrade a record
  // that has already advanced (Negotiating / Counter Received / etc.).
  if (classification === "soft_no") {
    if (
      currentStatus === "Texted" ||
      currentStatus === "Parked" ||
      currentStatus === "Response Received" ||
      currentStatus == null ||
      currentStatus === ""
    ) {
      return currentStatus === "Response Received" ? null : "Response Received";
    }
    return null;
  }
  if (classification === "acceptance") {
    if (currentStatus === "Offer Accepted") return null;
    return "Offer Accepted";
  }
  if (classification === "counter") {
    if (currentStatus === "Counter Received") return null;
    return "Counter Received";
  }
  if (classification === "interest") return "Negotiating";
  // The engaged-conversation classes: a seller asking who-pays-what, how to
  // receive the offer, or when to meet is IN the negotiation.
  if (
    classification === "seller_costs" ||
    classification === "offer_format" ||
    classification === "appointment"
  ) {
    return currentStatus === "Negotiating" ? null : "Negotiating";
  }
  // A disclosure step is process, not intent — promote first-touch to
  // Response Received (same as an unknown genuine reply), never downgrade.
  if (classification === "disclosure_step") {
    if (currentStatus === "Texted" || currentStatus === "Parked") return "Response Received";
    return null;
  }
  // Texted OR Parked → Response Received. Parked added 2026-06-14
  // (rebuild-stale-deal-handling): a Parked record is one that aged out
  // of active outreach into the cold follow-up loop; a reply on it is
  // STILL the same Response-Received transition, and must fire the
  // autoRunOnEngaged re-price the same way.
  if (currentStatus === "Texted" || currentStatus === "Parked") return "Response Received";
  return null;
}

/** What kind of operator decision a genuine reply demands. */
export type DecisionKind = "pricing" | "engagement" | "review" | "none";

/** Pure: the doctrine-compliant soft-no re-engagement draft (Type 2A — the
 *  operator approves before anything sends). STICKY-NUMBER RULE
 *  (pricing-doctrine method 6, the $71.5k lesson): the draft carries the
 *  delivery-stamped SENT offer verbatim or it carries NO number at all —
 *  never a recomputed or field-derived figure. Callers pass sentOfferUsd
 *  only when it provably backed a delivered outbound. */
export function buildSoftNoReengagement(opts: {
  sentOfferUsd?: number | null;
  street?: string | null;
}): string {
  const street = (opts.street ?? "").trim();
  const at = street ? ` for ${street}` : "";
  if (typeof opts.sentOfferUsd === "number" && opts.sentOfferUsd > 0) {
    return (
      `Totally understand — no pressure at all. If anything changes, my cash ` +
      `offer of $${Math.round(opts.sentOfferUsd).toLocaleString("en-US")}${at} stays good: ` +
      `as-is, no repairs or cleanout, and we close on your timeline. Keep my number just in case. – Alex`
    );
  }
  return (
    `Totally understand — no pressure at all. If anything changes down the road${at ? `${at.replace(" for", " on")}` : ""}, ` +
    `I buy as-is with cash — no repairs, no cleanout, close on your timeline. Keep my number just in case. – Alex`
  );
}

export interface SellerReplyTriage {
  classification: ReplyClassification;
  /** Alert routing tier (operator 2026-06-10): rejection → tier_0_auto_close
   *  (system close, no alert); counter/interest/unknown → tier_1_decision;
   *  acceptance → tier_2_urgent (ACT NOW). */
  tier: AlertTier;
  /** True when this genuine reply needs an operator decision (i.e. it is not
   *  a clean rejection, which is a downgrade rather than a decision). */
  needsDecision: boolean;
  decisionKind: DecisionKind;
  /** Proposal priority — pricing/engagement decisions are time-sensitive. */
  priority: "HIGH" | "NORMAL";
  /** The needs-decision queue status this reply routes the record to (same
   *  mapping as determineNewStatus). */
  queueStatus: string | null;
  /** Operator-facing: what the seller said + what decision is needed. */
  reasoning: string;
  matchedPattern: string | null;
  /** Soft-no only: the pre-built 2A re-engagement draft (sticky-number rule
   *  applied). Null for every other classification — those keep their
   *  existing draft paths. */
  suggestedReply: string | null;
}

/** Pure: turn a genuine inbound reply into a routed, reasoned needs-decision
 *  item. The caller has already stripped self-echo / bot autoreplies.
 *  opts.sentOfferUsd must be the DELIVERY-STAMPED sent offer (or omitted) —
 *  never a recomputed/field-guessed number. */
export function triageSellerReply(
  body: string,
  currentStatus: string | null = null,
  opts: { sentOfferUsd?: number | null; street?: string | null } = {},
): SellerReplyTriage {
  const { classification, matchedPattern } = classifyReply(body);
  const queueStatus = determineNewStatus(classification, currentStatus);
  const snippet = (body ?? "").trim().slice(0, 160);

  switch (classification) {
    case "acceptance":
      return {
        classification,
        tier: "tier_2_urgent",
        needsDecision: true,
        decisionKind: "engagement",
        priority: "HIGH",
        queueStatus,
        reasoning: `Seller ACCEPTED / asked for the contract — ACT NOW: draft contract, operator confirms terms. Reply: "${snippet}"`,
        matchedPattern,
        suggestedReply: null,
      };
    case "soft_no": {
      const isPriceObjection = PRICE_OBJECTION_RE.test((body ?? "").trim());
      return {
        classification,
        tier: "tier_1_decision",
        needsDecision: true,
        decisionKind: isPriceObjection ? "pricing" : "engagement",
        priority: "NORMAL",
        queueStatus,
        reasoning: isPriceObjection
          ? `Seller objected to the PRICE (soft no) — pricing decision: hold the sticky number or walk; re-engagement draft queued for approval. Reply: "${snippet}"`
          : `Seller declined softly — thread stays alive; approve/edit the no-pressure re-engagement draft (2A) or skip. Reply: "${snippet}"`,
        matchedPattern,
        suggestedReply: buildSoftNoReengagement(opts),
      };
    }
    case "counter":
      return {
        classification,
        tier: "tier_1_decision",
        needsDecision: true,
        decisionKind: "pricing",
        priority: "HIGH",
        queueStatus,
        reasoning: `Seller countered with a price — operator PRICING decision needed (hold the sticky floor; never auto-revise down). Reply: "${snippet}"`,
        matchedPattern,
        suggestedReply: null,
      };
    case "interest":
      return {
        classification,
        tier: "tier_1_decision",
        needsDecision: true,
        decisionKind: "engagement",
        priority: "HIGH",
        queueStatus,
        reasoning: `Seller engaged / asked to proceed — operator decision: advance to offer or DD. Reply: "${snippet}"`,
        matchedPattern,
        suggestedReply: null,
      };
    case "seller_costs":
      return {
        classification,
        tier: "tier_1_decision",
        needsDecision: true,
        decisionKind: "pricing",
        priority: "HIGH",
        queueStatus,
        reasoning: `Seller asked WHO PAYS WHAT (liens/bills/commission/costs) — money-structure decision. Doctrine: everything is paid from proceeds at closing, never on top of the offer; lien/estate validity is the title company's to verify. Reply: "${snippet}"`,
        matchedPattern,
        suggestedReply: null,
      };
    case "offer_format":
      return {
        classification,
        tier: "tier_1_decision",
        needsDecision: true,
        decisionKind: "engagement",
        priority: "HIGH",
        queueStatus,
        reasoning: `Seller/agent asked for the offer in a specific FORM or CHANNEL (email/state form/in writing) — they are processing the offer; deliver it their way, numbers unchanged. Reply: "${snippet}"`,
        matchedPattern,
        suggestedReply: null,
      };
    case "appointment":
      return {
        classification,
        tier: "tier_1_decision",
        needsDecision: true,
        decisionKind: "engagement",
        priority: "NORMAL",
        queueStatus,
        reasoning: `Seller proposed a SHOWING / call time / next-step meeting — confirm scheduling; operator owns the calendar commitment. Reply: "${snippet}"`,
        matchedPattern,
        suggestedReply: null,
      };
    case "disclosure_step":
      return {
        classification,
        tier: "tier_1_decision",
        needsDecision: true,
        decisionKind: "review",
        priority: "NORMAL",
        queueStatus,
        reasoning: `Compliance disclosure step (IABS / consumer-protection / read-and-agree) — the machine NEVER acknowledges legal disclosures for the operator; personal acknowledgment required. Reply: "${snippet}"`,
        matchedPattern,
        suggestedReply: null,
      };
    case "rejection":
      return {
        classification,
        tier: "tier_0_auto_close",
        needsDecision: false,
        decisionKind: "none",
        priority: "NORMAL",
        queueStatus,
        reasoning: `Seller declined (matched /${matchedPattern}/) — route to Dead; system sends the one-time polite close (no alert). Reply: "${snippet}"`,
        matchedPattern,
        suggestedReply: null,
      };
    default:
      return {
        classification,
        tier: "tier_1_decision",
        needsDecision: true,
        decisionKind: "review",
        priority: "NORMAL",
        queueStatus,
        reasoning: `Genuine reply, intent unclear — operator review. Reply: "${snippet}"`,
        matchedPattern,
        suggestedReply: null,
      };
  }
}
