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

import { looksLikeBotAutoreply } from "@/lib/conversation-check";
import { IDENTITY_QUESTION_STANDING_ANSWER } from "@/lib/standing-answers";

export type ReplyClassification =
  | "rejection"
  | "soft_no"
  | "interest"
  | "counter"
  | "acceptance"
  // SILENT CLASSES (operator rule 2026-09-03 22:20Z, recYEtBpeMx3Mqq06; built
  // 2026-09-05 after 9 of 19 replies in one day landed UNCLASSIFIED and a
  // hostile message scored INTEREST): these threads get NO reply, no draft,
  // no alert — Outreach_Status Parked, out of the bump cadence. The operator
  // reads them in the notes; nobody texts them.
  | "hostile"           // sarcasm / hostility ("stay out of our market", "lol… put in the work")
  | "list_anchored"     // "closer to asking", "seller wants list", "current list is $X"
  | "flat_no"           // a plain decline the soft-no list had no keyword for ("won't consider", "her reply is no")
  // ROUTED CLASSES (tier 1, the operator answers once):
  | "identity_question" // "are you a wholesaler?" / "are you going to assign?" — the operator's standing line
  | "agent_redirect"    // "<name> (<phone>) handles that one" — fix the contact, re-deliver the opener
  // NOT A HUMAN: automated responder that slipped past the pre-triage filter
  // ("You've reached me outside business hours" scored INTEREST on 9/5).
  | "auto_reply"
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
 *   tier_0_silent     — hostile / list-anchored / flat-no / auto-reply. NO
 *                       send of any kind (not even the polite close), no
 *                       proposal, no alert. Status → Parked where applicable.
 *                       Operator rule 2026-09-03 22:20Z: "those threads get
 *                       silence"; a probe into hostility costs the agent.
 */
export type AlertTier = "tier_0_auto_close" | "tier_0_silent" | "tier_1_decision" | "tier_2_urgent";

/** Acceptance — the seller said yes / asked for the contract. Checked FIRST
 *  (before rejection) because the rejection patches match "accepted ... offer"
 *  shapes; a true "we accept your offer" must not be eaten by them. Patterns
 *  are deliberately narrow: a strong-buy signal, not generic positivity. */
const ACCEPTANCE_PATTERNS = [
  /\bsend\s+(?:me\s+)?(?:the\s+|a\s+)?contract\b/i,
  // "The owner is willing to accept that deal." (2849 Mcguffey, 2026-08-19) —
  // a real acceptance that fell to UNKNOWN/0.4 and sat unanswered for 11 days
  // because every pattern above/below wants the subject adjacent to "accept".
  // Deliberately NOT "(will|would) accept": "you think my client would accept
  // that?" (7714 E Canfield sarcasm, 2026-07-12) must never read as acceptance.
  /\bwilling\s+to\s+accept\b/i,
  // "I'm surprised, but she's willing to do it." (1005 2nd St, Pamela
  // Calamusa, 2026-09-08 21:38Z) — a seller SAYING YES with no "accept"
  // token anywhere. It carried a costs question in the same breath ("she
  // pays no fees of any kind"), so SELLER_COSTS_PATTERNS caught it first
  // and the thread routed tier_1 instead of ACT NOW. It sat six hours and
  // three sessions before a human found it. Acceptance outranks a costs
  // question for the same reason a counter does (see COUNTER_PRICE_RE
  // below): the yes is the message, the costs question is the follow-up.
  /\bwilling\s+to\s+(?:do\s+it|move\s+forward|proceed)\b/i,
  /\bseller\s+(?:will|would)\s+take\s+(?:it|that|your)\b/i,
  /\bwe(?:'ll|\s+will)?\s+take\s+(?:it|that|your\s+offer)\b/i,
  /\b(?:we|seller|they)\s+accepts?\s+(?:it|that|your\s+offer)\b/i,
  /\byour\s+offer\s+(?:is|was|has\s+been)\s+accepted\b/i,
  /\blet'?s\s+(?:do\s+it|move\s+forward|get\s+it\s+done)\b/i,
  /\bwrite\s+(?:it|the\s+offer|the\s+contract)\s+up\b/i,
];

/** DECLINE OVERRIDES ACCEPTANCE — "After careful consideration, I have
 *  decided to respectfully decline the offer. The proposed price is
 *  significantly below what I am willing to accept" (1162 N Olive, Marie
 *  Crabb, 2026-09-06 16:40Z). ACCEPTANCE_PATTERNS run first by design and
 *  "willing to accept" fired on a firm decline: status flipped to Offer
 *  Accepted, a draft queued, and the operator was paged ACT NOW twice (the
 *  second time on a never-texted sibling record). An explicit decline verb,
 *  a "not interested", or a "below/under what … accept" comparison in the
 *  same message means the accept-shaped phrase is the seller's FLOOR, not a
 *  yes. When one of these is present the acceptance list is skipped and the
 *  message falls through to the ordinary ordering (list-anchored / soft-no /
 *  flat-no), which is where a polite decline belongs. */
const DECLINE_OVERRIDES_ACCEPTANCE = [
  /\bdeclin(?:e|ed|es|ing)\b/i,
  /\bnot\s+interested\b/i,
  /\b(?:below|under|less\s+than|short\s+of|beneath)\s+what\b/i,
  // Broadened from "not willing to accept" (2026-09-09): the acceptance list
  // now matches "willing to do it" / "move forward" / "proceed", so the
  // negated form of EVERY one of them has to be caught here, not just accept.
  /\b(?:not|never)\s+(?:be\s+)?willing\s+to\b/i,
  /\b(?:would|will|could|can)\s+(?:not|n'?t)\s+accept\b/i,
  /\bwon'?t\s+accept\b/i,
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
  // 2026-09-05 misses (all landed UNCLASSIFIED and were closed by hand):
  // "We just buttoned up a contract on that property" (1313 Hartford);
  // "We have an offer right now. Over asking, please don't bother me anymore"
  // (1212 W Chambers — ALSO an opt-out, see lib/outreach/opt-out);
  // "multiple offers for their property all above 31,000" (19350 Glastonbury).
  /\b(?:buttoned\s+up|signed|executed|ratified|finalized)\s+(?:a\s+|the\s+)?contract\b/i,
  /\b(?:have|has|got)\s+(?:an?\s+)?(?:offer|contract)\s+(?:right\s+now|in\s+hand|already|on\s+it)\b/i,
  /\bmultiple\s+offers\b/i,
  /\b(?:don'?t|dont|do\s+not|please\s+don'?t)\s+bother\s+(?:me|us)\b/i,
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
  // NEGATION AWARENESS (2026-07-26, "Seller is not. He may not counter" +
  // "no he's not. That's an insane ask." both misread as agent INTEREST
  // because the bare \bcounter\b interest pattern fired on a negated
  // clause): elliptical "X is not [interested]." — the complement is
  // dropped but the negation stands alone as the whole clause. Requires
  // trailing punctuation (or end of string) so a mid-sentence hedge like
  // "is not at that price yet, but..." isn't eaten.
  /\b(?:is|are|was|were)\s+not\b(?=[.,;!]|\s*$)/i,
  // "he's not" / "she's not" / "they're not" — the contraction form of the
  // same ellipsis. ANCHORED like its sibling above (2026-08-30, 8883 Sussex
  // post-mortem): the unanchored form ate "He's not interested in financing.
  // He wants to sell outright... We can negotiate a price." — a live cash-
  // pivot invitation auto-closed Dead with no alert, the first false-positive
  // auto-kill with money attached. Only the elliptical clause ("no he's not.")
  // is a rejection; a mid-sentence "he's not X" carries its meaning in X and
  // must fall through to the stance/pivot patterns.
  /\b(?:he|she|they)'?(?:s|re)\s+not\b(?=[.,;!]|\s*$)/i,
];

/** CASH-PIVOT — the terms lane's most valuable reply shape: the seller
 *  declines FINANCING but invites a CASH conversation ("wants to sell
 *  outright", "would you make a cash offer?", "we can negotiate a price").
 *  Checked AFTER hard rejection (a gone-deal stays gone) but BEFORE soft-no,
 *  because these messages usually carry a "not interested [in financing]"
 *  clause that would otherwise eat them (8883 Sussex 2026-08-24, 125 E
 *  McKellar 2026-08-23 — 3 of the last 4 money-bearing replies were this
 *  shape). Routes as interest → Negotiating, tier_1 HIGH. */
const CASH_PIVOT_PATTERNS = [
  /\bsell\s+(?:it\s+)?outright\b/i,
  /\bnegotiate\s+(?:a|the|on)\s+price\b/i,
  /\b(?:make|making)\s+(?:a|an)?\s*cash\s+offer\b/i,
  /\bwants?\s+(?:a\s+)?cash\b/i,
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
  // "seller firm on price" (9251 Plainview, launch night 2026-08-30) — the
  // prepositional variant of "firm at" with no number attached.
  /\bfirm\s+on\s+(?:the\s+)?price\b/i,
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
  // NEGATION AWARENESS (2026-07-26, generic-negatives-as-UNCLASSIFIED miss):
  // "Won't work" — a bare stance rejection with no other keyword to key off.
  /\bwon'?t\s+work\b/i,
  // Price-blowup language with no "too low"/"firm at" keyword present.
  /\binsane\b/i,
  /\btoo\s+far\s+apart\b/i,
  // "not available" — the listing-side decline shape with no "interested"
  // token (238 Richter class, 2026-08-20 — paged as interest via a stray
  // pattern instead of routing to the 2A queue).
  /\bnot\s+available\b/i,
];

/** HOSTILE / SARCASTIC — operator rule 2026-09-03 22:20Z (recYEtBpeMx3Mqq06):
 *  "Is there a way to stop the replies to angry agents?" A hostile reply has
 *  already given its posture (no) and usually its number (list); probing it
 *  reads as tone-deaf automation and burns the agent for future deals.
 *  Silence, Parked, no bump. Checked BEFORE cash-pivot / soft-no / interest so
 *  a dollar mention inside the insult ("where would you get the idea a seller
 *  would take $100,000 less… stay out of our market", 4708 S Rosette 9/5)
 *  can never score as interest again. Patterns are deliberately specific —
 *  a polite decline must fall through to soft_no / flat_no, not here. */
const HOSTILE_PATTERNS = [
  /\bstay\s+(?:in\s+your|out\s+of\s+our)\s+(?:own\s+)?(?:market|lane|city|state|area|town)\b/i,
  /\bdo\s+your\s+(?:due\s+diligence|homework|research)\b/i,
  /\bput\s+in\s+the\s+work\b/i,
  /\byou\s+clearly\b/i,
  /\bwaste\s+of\s+(?:my|our|your|everyone'?s)\s+time\b/i,
  /^\s*(?:lol|lmao|lmfao|haha+|rofl|smh)\b/i,
  /\b(?:is\s+this|are\s+you)\s+(?:a\s+joke|joking|kidding|serious|for\s+real)\b/i,
  /\binsult(?:ing|ed)?\b/i,
  /\badd\s+another\s+\$?\s*\d/i,
  /\bnot\s+(?:nearly|even\s+remotely|remotely)\s+(?:enough|close)\b/i,
  /\bscam(?:mer)?s?\b/i,
  /\b(?:ridiculous|absurd|laughable|offensive)\b/i,
  /\bgo\s+(?:try|find|bother)\s+someone\s+else\b/i,
  /\bget\s+(?:real|lost|a\s+clue)\b/i,
  // "We arent even in the same State let alone ballpark" (925 Sims 9/5)
  /\b(?:not|aren'?t|isn'?t|ain'?t|arent|isnt)\s+(?:even\s+)?in\s+the\s+same\s+(?:state|ballpark|universe|zip\s?code|county|planet|galaxy|league)\b/i,
];

/** LIST-ANCHORED — same operator rule: "closer to list", "seller wants list",
 *  "firm at list", "current list is $X so this won't work". The seller's
 *  number IS the list price; there is no negotiation to probe. Silence,
 *  Parked, no bump. SUPERSEDES the 2026-08-24 "directional counter" reading
 *  (13123 Indiana / Schylbea: "closer to the asking price" → counter) — the
 *  operator ruled on 9/3 that this shape gets no reply, and the 9/5 triage
 *  reset every COUNTER-tagged "closer to asking" back to Parked by hand. */
const LIST_ANCHORED_PATTERNS = [
  /\bcloser\s+to\s+(?:the\s+)?(?:asking|list(?:ing)?|ask)(?:\s+price)?\b/i,
  // "not interested in further negotiations that aren't close to the asking
  // price" (1162 N Olive, 2026-09-06) — same shape without the comparative.
  /\bclose\s+to\s+(?:the\s+)?(?:asking|list(?:ing)?|ask)(?:\s+price)?\b/i,
  /\b(?:in\s*-?\s*)?line\s+with\s+(?:the\s+)?(?:current\s+)?(?:list(?:ing)?|asking)(?:\s+price)?\b/i,
  /\bfirm\s+(?:at|on)\s+(?:the\s+)?(?:list(?:ing)?|asking)(?:\s+price)?\b/i,
  /\b(?:wants?|needs?|expects?|looking\s+for|holding\s+(?:out\s+)?for|is\s+at|are\s+at)\s+(?:the\s+)?(?:full\s+)?(?:list(?:ing)?|asking)(?:\s+price)?\b/i,
  /\b(?:current\s+)?list(?:ing)?\s+(?:price\s+)?is\s+\$?\s*\d/i,
  /\b(?:has|have)\s+set\s+(?:that|the)\s+(?:number|price)\s+at\b/i,
  /\bfull\s+(?:list|asking)\s+price\b/i,
  /\bnear(?:er)?\s+(?:to\s+)?(?:the\s+)?(?:list(?:ing)?|asking)(?:\s+price)?\b/i,
];

/** FLAT NO — a plain decline in words the soft-no list never keyed on. Nine
 *  of these landed UNCLASSIFIED on 2026-09-05 alone ("He won't consider that
 *  price range", "No, they would not be open to that ballpark", "I'm sorry
 *  her reply is no", "Not even close.", "He paid more for it than that",
 *  "doesn't need work… good luck to you"). Under the 2026-09-03 rule a flat
 *  no gets no reply: silence, Parked, no bump. Checked AFTER soft_no so the
 *  P1 anchors ("no thanks", bare "no", "pass") keep their approval-gated 2A
 *  re-engagement path unchanged. */
const FLAT_NO_PATTERNS = [
  /\bwon'?t\s+(?:consider|entertain|accept|take|look\s+at|go\s+(?:that|this)\s+low)\b/i,
  /\b(?:would|will|is|are|am)\s+not\s+(?:be\s+)?open\s+to\b/i,
  /\bnot\s+open\s+to\b/i,
  /\b(?:reply|answer|response)\s+(?:is|was)\s+(?:a\s+)?no\b/i,
  /\bnot\s+in\s+(?:the|that|this|our|my|your)\s+(?:ballpark|range|price\s+range|neighborhood|wheelhouse)\b/i,
  /\bnowhere\s+(?:near|close)\b/i,
  /\bnot\s+even\s+close\b/i,
  /\b(?:would|will)\s+never\s+(?:accept|take|consider|entertain|go)\b/i,
  /\bdeclined?\b/i,
  /\bpaid\s+(?:more|way\s+more|a\s+lot\s+more|\$?\s*\d[\d,.]*\s*k?)\s+(?:for|than)\b/i,
  /\bdoesn'?t\s+need\s+(?:any\s+)?work\b/i,
  /\bgood\s+luck\b/i,
  /\bthanks?\s+anyways?\b/i,
  /\bnot\s+what\s+(?:they|we|he|she|the\s+seller)(?:'re|'s|\s+are|\s+is)?\s+looking\s+for\b/i,
  /\bnot\s+(?:going\s+to|gonna)\s+(?:work|happen|fly)\b/i,
  /\btoo\s+far\s+(?:off|below|under)\b/i,
  /\bnot\s+(?:a\s+)?(?:good\s+)?(?:fit|match)\b/i,
  /\bno\s+(?:way|chance)\b/i,
  /\bworth\s+(?:far|way|a\s+lot|much|considerably)\s+more\b/i,
  /\b(?:hold|keep)\s+(?:it|the\s+(?:property|house))\s+and\s+(?:rent|lease)\b/i,
];

/** IDENTITY / REPRESENTATION QUESTION — "Alex are you a whole saler?" (6561
 *  Firwood 9/5), "Are you going to try to assign the contract" (101 Willow
 *  9/5). Not a price signal, not a decline: the agent is asking who we are.
 *  Routes tier 1 with NO auto-draft (the doctrine prompt would have to talk
 *  about assignment, which it must never do) — the operator answers from a
 *  standing line once he sets one. The 2026-09-03 rule allows one graceful
 *  answer to a direct question. */
const IDENTITY_QUESTION_PATTERNS = [
  /\bare\s+you\s+(?:a\s+|an\s+)?(?:whole\s?saler|investor|licensed|realtor|(?:real\s+estate\s+)?agent|broker|bot|ai|robot|real\s+person|local|the\s+(?:actual\s+|end\s+)?buyer)\b/i,
  /\bwhole\s?sal(?:e|er|ers|ing)\b/i,
  /\b(?:going\s+to|gonna|plan(?:ning)?\s+(?:to|on)|intend(?:ing)?\s+to|try\s+to)\s+assign\b/i,
  /\bassign(?:ing|ment)?\s+(?:the\s+|this\s+|your\s+)?contract\b/i,
  /\bwho\s+are\s+you\b/i,
  /\bis\s+this\s+(?:a\s+)?(?:bot|an?\s+ai|automated|a\s+real\s+person)\b/i,
];

/** AGENT REDIRECT — the number we texted is not the decision-maker and names
 *  who is ("Jim Conard (937-974-7758) handles that property", 66 Victor Ave
 *  9/4). Nothing to price; the contact fields need updating and the opener
 *  re-delivered. Routes tier 1 review, no status change, no draft. */
const AGENT_REDIRECT_PATTERNS = [
  /\b(?:is|are)\s+the\s+(?:listing\s+|selling\s+)?agent\b/i,
  /\bhandles?\s+(?:that|this|the)\s+(?:property|listing|one|house|sale)\b/i,
  /\bnot\s+(?:my|our)\s+listing\b/i,
  /\b(?:i|we)(?:'m|\s+am|\s+are|'re)\s+not\s+the\s+(?:listing\s+)?agent\b/i,
  /\b(?:contact|reach\s+out\s+to|call|text|email)\s+(?:him|her|them)\s+(?:at|on|directly)\b/i,
  /\bwrong\s+agent\b/i,
  /\b(?:listing|selling)\s+agent\s+is\b/i,
];

/** NEGATION AWARENESS (2026-07-26): a positive-interest phrase preceded or
 *  followed by a negation ("not", "isn't", "won't", "no longer", "n't", …)
 *  within ~4 words must NOT read as interest — this is the second line of
 *  defense behind the explicit REJECTION/SOFT_NO ellipsis patterns above
 *  (e.g. a negated "counter" or "call me" shape neither of those lists
 *  anticipated verbatim). Word-window, not full-clause, by design: cheap,
 *  pure, and matches every corpus case without a sentence tokenizer. */
const NEGATION_RE = /\b(?:not|isn'?t|aren'?t|wasn'?t|weren'?t|won'?t|wont|don'?t|doesn'?t|didn'?t|can'?t|no longer|n't)\b/i;

function isNegatedNearby(text: string, matchIndex: number, matchLength: number): boolean {
  const start = Math.max(0, matchIndex - 20);
  const end = Math.min(text.length, matchIndex + matchLength + 20);
  return NEGATION_RE.test(text.slice(start, end));
}

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
  /\b(?:gar|trec|far\s?bar|aar|nwmls|car)\b[^.?!]{0,30}\b(?:form|contract)\b/i,
  /\bon\s+(?:a\s+|an\s+)?(?:gar|trec|far\s?bar|aar|state|standard)\s+(?:form|contract)\b/i,
  // "I only present offers to my seller on an AAR contract" (10238 E Watson 9/5)
  /\bpresent\s+offers?\b[^.?!]{0,40}\bcontract\b/i,
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
  // TEMPLATE ECHO (2026-08-30, 2805 N Main day-1 miss): the soft opener asks
  // "if that's in the ballpark" — an affirmative reply echoes our own phrase
  // ("Definitely in the ballpark"). Negation guard applies via the loop, so
  // "not in the ballpark" falls through.
  /\bin\s+the\s+ballpark\b/i,
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
// WIDENED 2026-09-05 (820 W Keefe: "we'd have to be over 100k. It's rented
// for 2100" landed UNCLASSIFIED because the token had no "$"): a price is a
// "$" figure, a comma-grouped figure, or a 1-3 digit "k" figure. A bare
// 4-digit run ("rented for 2100", "3/2 1958") is deliberately NOT a price.
const COUNTER_PRICE_RE = /\$\s*\d{1,3}(?:[\s,.]?\d{3})*\b|\b\d{1,3}(?:,\d{3})+\b|\b\d{1,3}\s?k\b/i;
const COUNTER_LANGUAGE_PATTERNS = [
  // "we'd have to be over 100k" / "needs to be at least $120k" — a stated floor.
  /\b(?:have|has|need|needs|got)\s+to\s+be\s+(?:over|above|at\s+least|north\s+of|around|at)\s+\$?\s*\d/i,
  /\b(?:over|above|at\s+least|north\s+of|minimum\s+of|no\s+less\s+than)\s+\$?\s*\d{1,3}(?:[,.]\d{3}|\s?k)\b/i,
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

  // Automated responder — not a human answer. Callers are supposed to strip
  // these before triage (lib/inbound/capture), but the quo-sync reconciler
  // stamps a class straight from here, and "You've reached me outside
  // business hours" flipped 6100 Gertrude to Negotiating on 9/5. Belt and
  // braces: the classifier itself knows a bot when it sees one.
  if (looksLikeBotAutoreply(trimmed)) {
    return { classification: "auto_reply", matchedPattern: "bot_autoreply" };
  }

  // Acceptance FIRST — a true "we accept your offer" must not be eaten by
  // the rejection patches (which match "accepted ... offer" shapes when the
  // seller is comparing us to another deal in hand).
  // …unless the same message carries an explicit decline (1162 N Olive,
  // 2026-09-06: "respectfully decline … below what I am willing to accept").
  if (!DECLINE_OVERRIDES_ACCEPTANCE.some((pat) => pat.test(trimmed))) {
    for (const pat of ACCEPTANCE_PATTERNS) {
      if (pat.test(trimmed)) return { classification: "acceptance", matchedPattern: pat.source };
    }
  }

  for (const pat of REJECTION_PATTERNS) {
    if (pat.test(trimmed)) return { classification: "rejection", matchedPattern: pat.source };
  }

  // Agent redirect right after hard rejection: "I'm not the agent, contact
  // Jim at …" carries a "not" that the stance lists must not read as a no.
  for (const pat of AGENT_REDIRECT_PATTERNS) {
    if (pat.test(trimmed)) return { classification: "agent_redirect", matchedPattern: pat.source };
  }

  // Hostile / sarcastic BEFORE cash-pivot, soft-no, counter and interest —
  // an insult with a dollar figure in it is still an insult.
  for (const pat of HOSTILE_PATTERNS) {
    if (pat.test(trimmed)) return { classification: "hostile", matchedPattern: pat.source };
  }

  // Cash-pivot BEFORE soft-no: "He's not interested in financing. He wants to
  // sell outright... We can negotiate a price." carries a "not interested"
  // clause that soft_no would eat — but the live invitation is the message.
  for (const pat of CASH_PIVOT_PATTERNS) {
    const m = pat.exec(trimmed);
    if (m && !isNegatedNearby(trimmed, m.index, m[0].length)) {
      return { classification: "interest", matchedPattern: pat.source };
    }
  }

  // List-anchored BEFORE soft-no: "firm at asking" used to read as a pricing
  // soft-no with a re-engagement draft; under the 2026-09-03 rule it is the
  // list price restated, and the thread goes silent.
  for (const pat of LIST_ANCHORED_PATTERNS) {
    if (pat.test(trimmed)) return { classification: "list_anchored", matchedPattern: pat.source };
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

  // (The 2026-08-24 "closer to the asking price → counter" block that lived
  // here is superseded by LIST_ANCHORED_PATTERNS above, per the operator's
  // 2026-09-03 22:20Z rule.)

  // A counter (price token + counter language) outranks seller_costs — "I
  // need $120k to cover the liens" is a NUMBER conversation first.
  if (COUNTER_PRICE_RE.test(trimmed)) {
    for (const pat of COUNTER_LANGUAGE_PATTERNS) {
      if (pat.test(trimmed)) return { classification: "counter", matchedPattern: pat.source };
    }
  }

  // Flat no AFTER soft-no (the P1 anchors keep their 2A path) and BEFORE
  // everything price- or interest-flavored: "not in the ballpark for my
  // seller" carries our own template phrase and must not echo as interest.
  for (const pat of FLAT_NO_PATTERNS) {
    if (pat.test(trimmed)) return { classification: "flat_no", matchedPattern: pat.source };
  }

  // Who-are-you questions before the price/interest lists: "are you going to
  // assign the contract" contains "contract" and must not read as acceptance
  // language further down.
  for (const pat of IDENTITY_QUESTION_PATTERNS) {
    if (pat.test(trimmed)) return { classification: "identity_question", matchedPattern: pat.source };
  }

  // Seller-costs BEFORE interest — "are you covering closing costs?" must
  // not degrade to generic interest via a stray pattern.
  for (const pat of SELLER_COSTS_PATTERNS) {
    if (pat.test(trimmed)) return { classification: "seller_costs", matchedPattern: pat.source };
  }

  for (const pat of OFFER_FORMAT_PATTERNS) {
    if (pat.test(trimmed)) return { classification: "offer_format", matchedPattern: pat.source };
  }

  // Showing-PROTOCOL guard (Leeds St, 2026-08-22): "no offers via email, text,
  // nor phone prior to in-person showing" is an instruction ABOUT showings,
  // not a scheduling ask — the bare "showing" noun must not read as an
  // appointment. Protocol markers send it to review instead.
  const showingProtocol = /\bno\s+offers?\b|\bprior\s+to\b/i.test(trimmed);
  if (!showingProtocol) {
    for (const pat of APPOINTMENT_PATTERNS) {
      if (pat.test(trimmed)) return { classification: "appointment", matchedPattern: pat.source };
    }
  }

  for (const pat of INTEREST_PATTERNS) {
    const m = pat.exec(trimmed);
    if (m && !isNegatedNearby(trimmed, m.index, m[0].length)) {
      return { classification: "interest", matchedPattern: pat.source };
    }
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
  // A bot spoke, not a person: the record is exactly where it was.
  if (classification === "auto_reply") return null;
  // SILENT classes (operator rule 2026-09-03 22:20Z): Parked, out of the bump
  // cadence, no reply. Never yank a record that already has paper moving —
  // a flat no after a counter or an acceptance is the operator's read, so
  // those stay put and surface in the notes instead.
  if (classification === "hostile" || classification === "list_anchored" || classification === "flat_no") {
    if (currentStatus === "Parked" || currentStatus === "Offer Accepted" || currentStatus === "Counter Received") {
      return null;
    }
    return "Parked";
  }
  // "Are you a wholesaler?" is a live thread waiting on one answer — promote
  // a first-touch record so it is visible, never downgrade one further along.
  if (classification === "identity_question") {
    if (currentStatus === "Texted" || currentStatus === "Parked" || currentStatus == null || currentStatus === "") {
      return "Response Received";
    }
    return null;
  }
  // A redirect changes WHO we talk to, not where the deal stands.
  if (classification === "agent_redirect") return null;
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
    case "hostile":
      return {
        classification,
        tier: "tier_0_silent",
        needsDecision: false,
        decisionKind: "none",
        priority: "NORMAL",
        queueStatus,
        reasoning: `Hostile / sarcastic reply (matched /${matchedPattern}/) — operator rule 2026-09-03: NO reply of any kind, Parked, no bump. Reply: "${snippet}"`,
        matchedPattern,
        suggestedReply: null,
      };
    case "list_anchored":
      return {
        classification,
        tier: "tier_0_silent",
        needsDecision: false,
        decisionKind: "none",
        priority: "NORMAL",
        queueStatus,
        reasoning: `List-anchored reply (matched /${matchedPattern}/) — the seller's number is the list price; operator rule 2026-09-03: no probe, no reply, Parked, no bump. Reply: "${snippet}"`,
        matchedPattern,
        suggestedReply: null,
      };
    case "flat_no":
      return {
        classification,
        tier: "tier_0_silent",
        needsDecision: false,
        decisionKind: "none",
        priority: "NORMAL",
        queueStatus,
        reasoning: `Flat decline (matched /${matchedPattern}/) — no number, no question, no room; operator rule 2026-09-03: no reply, Parked, no bump. Reply: "${snippet}"`,
        matchedPattern,
        suggestedReply: null,
      };
    case "auto_reply":
      return {
        classification,
        tier: "tier_0_silent",
        needsDecision: false,
        decisionKind: "none",
        priority: "NORMAL",
        queueStatus,
        reasoning: `Automated responder (out-of-office / outside business hours), not a human answer — nothing to do; the opener stands as unanswered. Reply: "${snippet}"`,
        matchedPattern,
        suggestedReply: null,
      };
    case "identity_question":
      return {
        classification,
        tier: "tier_1_decision",
        needsDecision: true,
        decisionKind: "engagement",
        priority: "NORMAL",
        queueStatus,
        reasoning: `Agent asked WHO WE ARE (wholesaler / assign / licensed) — operator-approved standing answer attached (ruling 2026-09-09, lib/standing-answers.ts): discloses assignment, proves performance, no number. Reply: "${snippet}"`,
        matchedPattern,
        suggestedReply: IDENTITY_QUESTION_STANDING_ANSWER,
      };
    case "agent_redirect":
      return {
        classification,
        tier: "tier_1_decision",
        needsDecision: true,
        decisionKind: "review",
        priority: "NORMAL",
        queueStatus,
        reasoning: `Wrong contact — the reply names who actually handles the listing. Update Agent_Name / Agent_Phone and re-deliver the same opener to them; nothing to price. Reply: "${snippet}"`,
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
