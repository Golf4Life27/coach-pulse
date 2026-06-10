// PLAIN ENGLISH ON SURFACES (design law, operator review 6/10):
// raw system/audit/Notes jargon never renders verbatim on a primary surface.
// Known machine-voice patterns get a one-line human translation; unknown
// machine-voice text collapses behind a generic summary. The raw entry stays
// available under an expandable "system log" for provenance.

export interface Translation {
  /** One-line human sentence for the primary surface. */
  summary: string;
  /** true = a known pattern was translated; false = generic fallback. */
  known: boolean;
  /** true = the raw text reads as machine voice and should stay collapsed. */
  machineVoice: boolean;
}

// Machine-voice heuristic: jargon tokens that mean "this was written for the
// system, not for Alex". Tuned to the actual annotation vocabulary in Notes
// and audit entries; widen as new patterns appear.
const MACHINE_TOKENS =
  /\b(forward-only|idempoten|sandbox path|stage engine|kill-edge|semantics|backfill|cadence engine|INV-\d|sentinel|dedup|e\.?164|formula field|snake_case|dry[-_ ]run)\b/i;
const SNAKE_CASE = /\b[a-z]+_[a-z_]+\b/;

export function looksMachineVoice(raw: string): boolean {
  return MACHINE_TOKENS.test(raw) || SNAKE_CASE.test(raw) || raw.includes("()");
}

export function translateSystemText(raw: string): Translation {
  const text = raw.trim();

  // Bulk-dead policy annotation (lib/bulk-dead-annotation.ts fixed copy).
  if (text.includes("BULK DEAD per stale records policy")) {
    const days = text.match(/(\d+)\s+days since/)?.[1];
    return {
      summary: `Marked dead under the stale-records policy${days ? ` — texted ${days} days earlier, no reply` : " — no reply after first touch"}.`,
      known: true,
      machineVoice: true,
    };
  }

  // Operator-directed kill annotations (written by ops sessions).
  if (/operator-directed kill/i.test(text)) {
    const date = text.match(/^(\d{1,2}\/\d{1,2})/)?.[1];
    return {
      summary: `You killed this lead${date ? ` ${date}` : ""} — one-time operator decision, this record only.`,
      known: true,
      machineVoice: true,
    };
  }

  // Automated send confirmations.
  if (/automated text sent via quo/i.test(text)) {
    return { summary: "Offer text sent automatically via Quo.", known: true, machineVoice: false };
  }
  if (/status[- _]check/i.test(text) && looksMachineVoice(text)) {
    return { summary: "Automatic status-check text sent (cadence follow-up).", known: true, machineVoice: true };
  }

  if (looksMachineVoice(text)) {
    return {
      summary: "System annotation — open the log for the raw entry.",
      known: false,
      machineVoice: true,
    };
  }

  // Reads as human text already — pass through untouched.
  return { summary: text, known: true, machineVoice: false };
}

// Audit / funnel reason codes → operator language.
const REASON_MAP: Array<[RegExp, string | ((m: RegExpMatchArray) => string)]> = [
  [/^mao_not_underwritten/, "no underwritten ceiling on record yet — can't price the opener"],
  [/^opener_exceeds_mao/, "65%-of-list opener would exceed our max offer — capped or held"],
  [/^not_outreach_ready:?\s*(.*)/, (m) => `not ready to text${m[1] ? ` (${m[1].replace(/_/g, " ")})` : ""}`],
  [/^out_of_zip_scope\s*\((\d{5})\)/, (m) => `outside this run's market (${m[1]})`],
  [/^not_found/, "record no longer exists"],
  [/same agent already contacted at (.+)/, (m) => `this agent is already in an open thread at ${m[1]} — held to avoid double-texting`],
  [/agent phone could not normalize/, "agent phone number is unusable"],
  [/^dropped by limit=(\d+)/, (m) => `batch was capped at ${m[1]} — queued for the next run`],
  [/first_touch missing/, "plan was incomplete (missing phone or message) — defect, not a decision"],
];

export function translateReason(reason: string | null): string | null {
  if (!reason) return null;
  for (const [re, out] of REASON_MAP) {
    const m = reason.match(re);
    if (m) return typeof out === "string" ? out : out(m);
  }
  return looksMachineVoice(reason) ? reason.replace(/_/g, " ") : reason;
}

// Audit event names → operator language (digest + health strip).
const EVENT_MAP: Record<string, string> = {
  outreach_batch_send: "offer text",
  outreach_batch_dry_run: "batch plan (dry run)",
  quo_reconcile: "Quo delivery sync",
  reply_alert_sent: "reply alert to your phone",
  reply_alert_failed: "reply alert failed",
  reply_alert_skipped: "reply alert skipped",
  listings_intake_live: "intake scan",
};

export function humanizeEvent(event: string): string {
  return EVENT_MAP[event] ?? event.replace(/_/g, " ");
}
