// RECOMMENDED REPLIES — guardrailed 2A draft generation (operator
// 2026-07-12: "the system proposes, operator disposes"). @agent: crier/forge
//
// Every classified inbound (Quo SMS + Gmail) on an active deal produces a
// drafted operator reply, queued Type 2A. The operator approves/edits/sends;
// nothing here auto-sends. Anchor case: 9360 Cheyenne — "Are you covering
// costs? There is a water bill, and a tax bill... And I need to be paid."
// landed UNCLASSIFIED with no next step; that inbound must yield a queued
// draft (or an explicit HOLD with reason) within minutes.
//
// HARD GUARDRAILS (validated POST-generation, deterministically — the model
// is instructed AND checked; instructions alone are not a guardrail):
//   G1  Numbers: a draft may carry the DELIVERY-STAMPED sticky offer
//       verbatim or NO dollar figure at all (pricing-doctrine method 6).
//       Any other number → HOLD. Any number above the record's ceiling →
//       HOLD (belt + braces; the sticky number itself is checked too).
//   G2  Costs: liens/bills/commission/closing costs are paid FROM PROCEEDS
//       AT CLOSING — never "on top of" / "in addition to" the offer. A
//       seller_costs draft must carry proceeds framing.
//   G3  Legal/title facts: never assert lien validity, estate authority,
//       or title status — that is the title company's verification. Deals
//       flagged estate/lien/probate must defer to the title company.
//   G4  Disclosures: the machine NEVER acknowledges a legal disclosure
//       (IABS etc.) on the operator's behalf. disclosure_step never drafts.
//   Anything the guardrails can't satisfy → NO draft, HOLD + surfaced
//   reason (refuse-and-surface, Constitution Rule 3).
//
// PURE except generateRecommendedReply (injectable synthesize dep — tests
// never hit the API). Voice: crier (SMS register) / forge (email register).

import type { ReplyClassification } from "@/lib/reply-triage";
import { extractStickyOffer } from "@/lib/h2-outreach/bump-lane";
import { audit } from "@/lib/audit-log";
import { synthesize as synthesizeDefault, type SynthesizeArgs, type SynthesizeResult } from "@/lib/maverick/synthesizer";

export type ReplyChannel = "sms" | "email";

export type DraftState = "queued" | "hold" | "sent" | "dismissed";

export interface DealFlags {
  estate: boolean;
  lien: boolean;
  probate: boolean;
  multiOffer: boolean;
}

export interface ReplyDraftContext {
  recordId: string;
  street: string;
  channel: ReplyChannel;
  classification: ReplyClassification;
  /** The inbound being answered, verbatim. */
  inbound: string;
  /** Tail of the record's notes ledger — the conversation history. */
  conversationTail: string;
  /** DELIVERY-STAMPED sent offer (extractStickyOffer) — the ONLY number a
   *  draft may carry. Null = no number allowed in the draft at all. */
  stickyOfferUsd: number | null;
  /** Doctrine ceiling (Underwritten_MAO preferred). Null = unknown → no
   *  new numbers permitted (sticky-only rule already enforces this). */
  ceilingUsd: number | null;
  listPriceUsd: number | null;
  /** Pricer capped-to-list marker seen in notes/fields. */
  cappedToList: boolean;
  flags: DealFlags;
  agentFirstName: string | null;
}

export interface DraftMeta {
  state: DraftState;
  generated_at: string;
  classification: ReplyClassification;
  confidence: number;
  channel: ReplyChannel;
  hold_reason?: string;
  proposal_id?: string;
  inbound_msg_id?: string;
  inbound_excerpt?: string;
  sent_at?: string;
}

// ── Context-pack helpers (pure) ─────────────────────────────────────────────

const NOTES_TAIL_CHARS = 2400;

export function conversationTail(notes: string | null | undefined, chars = NOTES_TAIL_CHARS): string {
  const s = (notes ?? "").trim();
  return s.length <= chars ? s : s.slice(s.length - chars);
}

/** Deal flags from the notes ledger — estate/lien/probate/multi-offer are
 *  written into notes by the deal timeline; fields don't carry them. */
export function flagsFromNotes(notes: string | null | undefined): DealFlags {
  const s = (notes ?? "").toLowerCase();
  return {
    estate: /\bestate\b|\bexecut(?:or|rix)\b|\bheir(?:s)?\b/.test(s),
    lien: /\blien(?:s|holder)?\b/.test(s),
    probate: /\bprobate\b|\bletters\s+testamentary\b/.test(s),
    multiOffer: /\bmultiple\s+offers?\b|\bamongst\s+the\s+best\s+offers?\b|\bother\s+offers?\s+(?:in\s+hand|on\s+the\s+table)\b/.test(s),
  };
}

/** Sticky offer straight from delivery stamps — never from fields
 *  (pricing-doctrine method 6: fields are history, not authority). */
export function stickyOfferFromNotes(notes: string | null | undefined): number | null {
  const sticky = extractStickyOffer(notes ?? null);
  return sticky?.offer ?? null;
}

// ── Draft policy (pure) ─────────────────────────────────────────────────────

/** What the pipeline does with a classification. disclosure_step NEVER
 *  drafts (G4); rejection rides the existing tier-0 auto-close, not this
 *  lane. Everything else drafts — including unknown (conservative register,
 *  zero numbers), because UNCLASSIFIED must never silently drop. */
export function draftPolicy(classification: ReplyClassification): "draft" | "hold" | "none" {
  if (classification === "disclosure_step") return "hold";
  if (classification === "rejection") return "none";
  return "draft";
}

// ── Conversation-closer policy (2026-07-13, 685 Bolton leak) ────────────────
// "Ok, you're welcome. I understand. … Have a great day!" needs NO reply —
// but the pipeline drafted one, and the model's REASONING ("No reply needed —
// this is a conversation closer…") leaked through as a sendable bubble.
// Deterministic detection, applied ONLY to `unknown`-classified inbounds
// (a classified intent — acceptance, counter, costs — always outranks
// closer-looking phrasing). A closer produces an explicit DISMISSED state:
// no Send button, no HOLD noise, and the msg-id idempotency still records
// that the inbound was seen.
const CLOSER_RE =
  /\b(?:you'?re welcome|no problem|take care|have a (?:good|great|nice|wonderful) (?:day|night|evening|weekend|one)|sounds good|will do|talk (?:soon|later)|good\s?bye|bye now|thanks?,? (?:again|so much)|got it|understood)\b/i;

/** Pure: a short, question-free, number-free pleasantry that closes the
 *  exchange. Callers gate this on classification === "unknown". */
export function isConversationCloser(inbound: string | null | undefined): boolean {
  const t = (inbound ?? "").trim();
  if (!t || t.length > 200) return false;
  if (t.includes("?")) return false;
  if (/\$\s*\d|\d{4,}/.test(t)) return false; // money or long numbers → substance
  return CLOSER_RE.test(t);
}

export function classificationConfidence(classification: ReplyClassification, matchedPattern: string | null): number {
  if (classification === "unknown") return 0.4;
  return matchedPattern ? 0.9 : 0.6;
}

// ── Prompt (pure) ───────────────────────────────────────────────────────────

export function buildDraftSystemPrompt(ctx: ReplyDraftContext): string {
  const register =
    ctx.channel === "sms"
      ? `REGISTER: SMS. One short message, max 3 sentences, under 320 characters. Sounds like a person mid-conversation, not a script. No greeting fluff beyond "Hey ${ctx.agentFirstName ?? "[name]"}," when natural. Sign "– Alex" only if the thread's prior outbounds do.`
      : `REGISTER: EMAIL. Short professional email — 2 brief paragraphs max, then "Alex Balog · AKB Solutions LLC · (815) 556-9965". No subject line in the body. Plain text.`;

  const sticky =
    ctx.stickyOfferUsd != null
      ? `THE ONLY NUMBER YOU MAY WRITE: $${Math.round(ctx.stickyOfferUsd).toLocaleString("en-US")} (our delivery-stamped offer, verbatim). Do not compute, adjust, split, or imply any other dollar figure.`
      : `YOU MAY NOT WRITE ANY DOLLAR FIGURE. No offer number is on stamped record for this thread — a draft with a number would be fabricated. Speak in terms, not numbers.`;

  return `You draft a reply for Alex Balog (AKB Solutions LLC, cash homebuyer/wholesaler) to send to a seller or listing agent. Alex reviews and sends — you are proposing, not sending.

${register}

${sticky}

MONEY-STRUCTURE DOCTRINE (non-negotiable):
- Liens, back taxes, water/utility bills, commissions, closing costs: these are paid FROM THE SALE PROCEEDS AT CLOSING through the title company. Never offer to pay them "on top of" or "in addition to" the offer. The seller's net = price minus what the title company pays off at closing.
- Never assert that a lien is valid/invalid, that an estate or executor has authority, or any title fact — the title company verifies all of that during the option/escrow period. Defer to "the title company will confirm exact figures/payoffs."
- Never acknowledge, agree to, or accept legal disclosures (IABS, consumer-protection notices) on Alex's behalf.
- Never disclose wholesale fee, spread, assignment, or contract mechanics. Say "affiliated entity" if entity flexibility comes up, never "assignable".
- Cash, as-is, no repairs or cleanout, buyer pays standard closing costs, close on the seller's timeline — these are the standing terms you may restate.
- If the seller countered with a price, do NOT accept or counter-with-a-number — keep the conversation alive and route the decision to Alex ("let me run that number and get right back to you" energy).
- Answer the seller's actual question first, in their language. One clear next step at the end.${ctx.flags.estate || ctx.flags.probate ? "\n- This deal involves an ESTATE: reference the title company handling estate paperwork; never state who has authority to sign." : ""}${ctx.flags.multiOffer ? "\n- Multiple-offer situation: never bid against ourselves; certainty-of-close is the sell." : ""}${ctx.cappedToList ? "\n- The stamped offer was capped to list; do not imply room above it." : ""}

Output ONLY the message text. No preamble, no quotes, no markdown.`;
}

export function buildDraftUserPrompt(ctx: ReplyDraftContext): string {
  return `Deal: ${ctx.street}
List price: ${ctx.listPriceUsd != null ? `$${Math.round(ctx.listPriceUsd).toLocaleString("en-US")}` : "unknown"}
Our stamped offer: ${ctx.stickyOfferUsd != null ? `$${Math.round(ctx.stickyOfferUsd).toLocaleString("en-US")}` : "none on record"}
Inbound classification: ${ctx.classification}
Deal flags: ${Object.entries(ctx.flags).filter(([, v]) => v).map(([k]) => k).join(", ") || "none"}

Conversation history (notes ledger tail):
${ctx.conversationTail || "(none)"}

NEW INBOUND (${ctx.channel}) to answer:
"${ctx.inbound}"

Draft Alex's reply.`;
}

// ── Guardrail validation (pure, deterministic) ──────────────────────────────

export interface DraftValidation {
  ok: boolean;
  holdReason: string | null;
}

const DOLLAR_RE = /\$\s*([\d][\d,.]*)\s*([kK])?/g;

/** Every dollar figure in the text, normalized to whole dollars. */
export function extractDollarAmounts(text: string): number[] {
  const out: number[] = [];
  let m: RegExpExecArray | null;
  const re = new RegExp(DOLLAR_RE.source, DOLLAR_RE.flags);
  while ((m = re.exec(text)) != null) {
    const raw = m[1].replace(/,/g, "");
    let n = Number(raw);
    if (!Number.isFinite(n)) continue;
    if (m[2]) n *= 1000;
    out.push(Math.round(n));
  }
  return out;
}

const ON_TOP_RE = /\b(?:on\s+top\s+of|in\s+addition\s+to|over\s+and\s+above|plus)\b[^.?!]{0,40}\b(?:offer|price|purchase)\b|\b(?:offer|price)\b[^.?!]{0,40}\b(?:on\s+top|in\s+addition|extra|additionally)\b/i;
const PROCEEDS_RE = /\bproceeds\b|\bat\s+closing\b|\bout\s+of\s+the\s+sale\b|\bthrough\s+(?:the\s+)?title\b/i;
const LEGAL_ASSERTION_RE = /\b(?:lien|liens|estate|probate|title|executor|executrix)\b[^.?!]{0,50}\b(?:is|are|was|were)\s+(?:valid|invalid|clear|cleared|fine|legitimate|bogus|not?\s+(?:a\s+)?(?:problem|issue|valid))\b/i;
const TITLE_DEFER_RE = /\btitle\s+(?:company|co\b|agent|office)\b|\bescrow\b/i;
const DISCLOSURE_ACK_RE = /\b(?:i|we)\s+(?:acknowledge|accept|agree\s+to|have\s+read)\b[^.?!]{0,60}\b(?:iabs|disclosure|brokerage\s+services|protection\s+notice)\b/i;

/** Numbers a sticky offer may legitimately appear as in prose. */
function matchesSticky(amount: number, stickyUsd: number): boolean {
  if (amount === Math.round(stickyUsd)) return true;
  // "$113.75k" / "$114k" style roundings of the same number:
  if (Math.abs(amount - stickyUsd) <= 500 && amount % 500 === 0) return true;
  return false;
}

// The model's editorial voice leaking into a sendable draft (the Bolton
// bubble: "No reply needed — this is a conversation closer. Sending another
// message would be over-communication."). A draft is the MESSAGE, never
// commentary about whether to send one — deterministic catch, belt+braces
// under the isConversationCloser policy.
const META_COMMENTARY_RE =
  /\bno reply (?:is )?(?:needed|required)\b|\bif a draft is required\b|\bconversation[- ]closer\b|\bover-?communicat|\bwould be redundant\b|\bdoes not (?:need|require|warrant) a (?:reply|response)\b|\bas an ai\b|\bi (?:would|will) not (?:draft|recommend)\b/i;

export function validateReplyDraft(draft: string, ctx: ReplyDraftContext): DraftValidation {
  const text = (draft ?? "").trim();
  if (!text) return { ok: false, holdReason: "generation_failed_empty" };
  if (text.startsWith("[") && /failed|no api key/i.test(text)) {
    return { ok: false, holdReason: "generation_failed" };
  }
  if (META_COMMENTARY_RE.test(text)) {
    return { ok: false, holdReason: "generation_meta_commentary" };
  }

  // G4 — disclosure acknowledgment is never the machine's to draft.
  if (ctx.classification === "disclosure_step") {
    return { ok: false, holdReason: "operator_must_acknowledge_disclosure" };
  }
  if (DISCLOSURE_ACK_RE.test(text)) {
    return { ok: false, holdReason: "disclosure_ack_forbidden" };
  }

  // G1 — sticky-number-or-silence, and nothing above the ceiling. Ever.
  const amounts = extractDollarAmounts(text);
  for (const a of amounts) {
    if (ctx.ceilingUsd != null && a > ctx.ceilingUsd) {
      return { ok: false, holdReason: `draft_exceeds_ceiling ($${a.toLocaleString("en-US")} > $${Math.round(ctx.ceilingUsd).toLocaleString("en-US")})` };
    }
    if (ctx.stickyOfferUsd == null) {
      return { ok: false, holdReason: `draft_invented_number ($${a.toLocaleString("en-US")} with no stamped offer on record)` };
    }
    if (!matchesSticky(a, ctx.stickyOfferUsd)) {
      return { ok: false, holdReason: `draft_number_not_sticky ($${a.toLocaleString("en-US")} ≠ stamped $${Math.round(ctx.stickyOfferUsd).toLocaleString("en-US")})` };
    }
  }

  // G2 — cost questions must be proceeds-framed and never on-top.
  if (ON_TOP_RE.test(text)) {
    return { ok: false, holdReason: "cost_coverage_on_top_forbidden" };
  }
  if (ctx.classification === "seller_costs" && !PROCEEDS_RE.test(text)) {
    return { ok: false, holdReason: "seller_costs_missing_proceeds_framing" };
  }

  // G3 — no legal/title assertions; flagged deals must defer to title.
  if (LEGAL_ASSERTION_RE.test(text)) {
    return { ok: false, holdReason: "legal_title_assertion_forbidden" };
  }
  if ((ctx.flags.lien || ctx.flags.estate || ctx.flags.probate) && ctx.classification === "seller_costs" && !TITLE_DEFER_RE.test(text)) {
    return { ok: false, holdReason: "missing_title_company_deferral" };
  }

  // Register bound: an SMS draft that rambles is not sendable from a phone.
  if (ctx.channel === "sms" && text.length > 640) {
    return { ok: false, holdReason: "sms_draft_too_long" };
  }

  return { ok: true, holdReason: null };
}

// ── Generator (I/O via injected synthesize) ─────────────────────────────────

export interface GeneratedReply {
  draft: string | null;
  holdReason: string | null;
  meta: DraftMeta;
}

export interface GenerateDeps {
  synthesize?: (args: SynthesizeArgs) => Promise<SynthesizeResult>;
  writeAudit?: typeof audit;
  nowIso?: string;
}

/** Generate + validate a recommended reply. NEVER throws on model failure —
 *  a failed generation is a HOLD with reason (refuse-and-surface), because
 *  an inbound must never silently drop. Emits the reply_draft_created audit
 *  event either way. */
export async function generateRecommendedReply(
  ctx: ReplyDraftContext,
  opts: { matchedPattern?: string | null; inboundMsgId?: string | null } = {},
  deps: GenerateDeps = {},
): Promise<GeneratedReply> {
  const synth = deps.synthesize ?? synthesizeDefault;
  const writeAudit = deps.writeAudit ?? audit;
  const nowIso = deps.nowIso ?? new Date().toISOString();
  const confidence = classificationConfidence(ctx.classification, opts.matchedPattern ?? null);

  const baseMeta: DraftMeta = {
    state: "hold",
    generated_at: nowIso,
    classification: ctx.classification,
    confidence,
    channel: ctx.channel,
    inbound_msg_id: opts.inboundMsgId ?? undefined,
    inbound_excerpt: ctx.inbound.slice(0, 160),
  };

  const policy = draftPolicy(ctx.classification);
  let draft: string | null = null;
  let holdReason: string | null = null;
  let dismissed = false;

  // Closer policy — decided BEFORE any model call (deterministic, free).
  // Only `unknown` inbounds qualify; a classified intent always drafts.
  if (policy === "draft" && ctx.classification === "unknown" && isConversationCloser(ctx.inbound)) {
    dismissed = true;
    holdReason = "no_reply_needed_conversation_closer";
  } else if (policy === "hold") {
    holdReason = "operator_must_acknowledge_disclosure";
  } else if (policy === "none") {
    holdReason = "tier0_auto_close_lane";
  } else {
    try {
      const result = await synth({
        agent: ctx.channel === "sms" ? "crier" : "forge",
        system: buildDraftSystemPrompt(ctx),
        user: buildDraftUserPrompt(ctx),
        max_tokens: ctx.channel === "sms" ? 300 : 600,
        recordId: ctx.recordId,
        event_label: ctx.channel === "sms" ? "crier_reply_drafted" : "forge_reply_drafted",
        timeoutMs: 25_000,
      });
      const candidate = (result.text ?? "").trim();
      const v = validateReplyDraft(candidate, ctx);
      if (v.ok) draft = candidate;
      else holdReason = v.holdReason;
    } catch (err) {
      holdReason = `generation_error: ${String(err).slice(0, 120)}`;
    }
  }

  const meta: DraftMeta = {
    ...baseMeta,
    state: draft ? "queued" : dismissed ? "dismissed" : "hold",
    hold_reason: holdReason ?? undefined,
  };
  await writeAudit({
    agent: ctx.channel === "sms" ? "crier" : "forge",
    event: "reply_draft_created",
    status: draft || dismissed ? "confirmed_success" : "confirmed_failure",
    recordId: ctx.recordId,
    inputSummary: {
      channel: ctx.channel,
      classification: ctx.classification,
      confidence,
      sticky_offer: ctx.stickyOfferUsd,
      ceiling: ctx.ceilingUsd,
      flags: ctx.flags,
    },
    outputSummary: draft
      ? { state: "queued", draft_length: draft.length }
      : { state: "hold", hold_reason: holdReason },
    decision: draft ? "draft_queued" : dismissed ? "no_reply_needed" : "hold_surfaced",
  });

  return { draft, holdReason, meta };
}

/** Parse the Draft_Reply_Meta JSON field (fail-soft). */
export function parseDraftMeta(raw: string | null | undefined): DraftMeta | null {
  if (!raw || !raw.trim()) return null;
  try {
    const o = JSON.parse(raw) as DraftMeta;
    if (!o || typeof o !== "object" || !o.state) return null;
    return o;
  } catch {
    return null;
  }
}
