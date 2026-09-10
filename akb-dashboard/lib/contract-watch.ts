// Contract watchdog — an envelope sitting on OUR signature is money standing still.
// @agent: scribe
//
// THE MISS THIS EXISTS FOR (513 Lamar, San Antonio, 2026-09-06 → 09-09):
// the listing agent's seller signed on 9/8 01:46Z. Alex was routing order 2,
// so his signature was the executing act. It sat THREE DAYS. Bryan Ryder sent
// four follow-ups and resent the envelope twice. Nothing in the system was
// watching, because nothing in the system watches EMAIL for contract state —
// `gmail-sync` is the only email reader and it is gated dark behind
// INBOUND_CAPTURE_LIVE (off). Airtable's Envelope_ID only ever holds envelopes
// WE send via Scribe, so an inbound envelope from a listing agent is invisible
// to every existing lane.
//
// WHY NOT THE DOCUSIGN API: the JWT path is unprovisioned (SYSTEM_FACTS §5,
// Phase 12.7 operator-external STOP). Waiting on it is what let Lamar rot.
// DocuSign's own notification emails carry everything needed, so this reads
// those instead and stays independent of both the JWT and INBOUND_CAPTURE_LIVE.
//
// THE SIGNAL: DocuSign emails "Complete with Docusign: <name>" when a
// recipient still owes a signature, and "Completed: <name>" once the envelope
// is fully executed. An envelope with the former and no matching latter is
// pending on us. Reminders and resends repeat the same subject, so the FIRST
// occurrence is the true age — a resend must never reset the clock, or a
// nagging agent silently hides how long we have been sitting.
//
// PURE. No I/O, no clock of its own — the route passes `now`.

/** The subset of a Gmail message this module reads. Structurally compatible
 *  with lib/gmail.GmailMessage so the route can pass those straight in. */
export interface ContractWatchMessage {
  id: string;
  from: string;
  subject: string;
  date: string;
}

export interface PendingEnvelope {
  /** The envelope name as DocuSign renders it, e.g. "Contract for 513 Lamar". */
  label: string;
  /** ISO date of the EARLIEST "Complete with Docusign" mail for this label. */
  firstSeenIso: string;
  /** Whole hours since firstSeenIso. */
  ageHours: number;
  /** How many DocuSign mails referenced this label — resends and reminders.
   *  A high count with a high age is an agent actively waiting on us. */
  noticeCount: number;
}

const DOCUSIGN_SENDER = /(^|[@.])docusign\.net$/i;
// "Complete with Docusign: Contract for 513 Lamar" — action still owed.
const AWAITING_RE = /^\s*complete\s+with\s+docusign:\s*(.+?)\s*$/i;
// "Completed: Contract for 513 Lamar" — fully executed, stop watching.
const COMPLETED_RE = /^\s*completed:\s*(.+?)\s*$/i;

function senderIsDocusign(from: string): boolean {
  const m = /<([^>]+)>/.exec(from ?? "");
  const addr = (m ? m[1] : (from ?? "")).trim().toLowerCase();
  const at = addr.lastIndexOf("@");
  return at >= 0 && DOCUSIGN_SENDER.test(addr.slice(at + 1));
}

/** Normalize an envelope label so a resend, a reminder and the completion
 *  notice all collapse to the same key. */
function key(label: string): string {
  return label.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Pure: envelopes DocuSign says still owe a signature, oldest first.
 *  An envelope is dropped the moment a "Completed:" notice for the same label
 *  appears, regardless of ordering — mail can arrive out of order. */
export function findPendingSignatures(
  messages: ContractWatchMessage[],
  now: Date,
): PendingEnvelope[] {
  const awaiting = new Map<string, { label: string; firstMs: number; firstIso: string; count: number }>();
  const completed = new Set<string>();

  for (const m of messages ?? []) {
    if (!senderIsDocusign(m?.from ?? "")) continue;
    const subject = m?.subject ?? "";

    const done = COMPLETED_RE.exec(subject);
    if (done) {
      completed.add(key(done[1]));
      continue;
    }

    const open = AWAITING_RE.exec(subject);
    if (!open) continue;

    const ms = Date.parse(m?.date ?? "");
    if (!Number.isFinite(ms)) continue;

    const k = key(open[1]);
    const prior = awaiting.get(k);
    if (!prior) {
      awaiting.set(k, { label: open[1].trim(), firstMs: ms, firstIso: new Date(ms).toISOString(), count: 1 });
    } else {
      prior.count += 1;
      // EARLIEST wins — a resend is the agent chasing us, not a fresh clock.
      if (ms < prior.firstMs) {
        prior.firstMs = ms;
        prior.firstIso = new Date(ms).toISOString();
      }
    }
  }

  const nowMs = now.getTime();
  return [...awaiting.entries()]
    .filter(([k]) => !completed.has(k))
    .map(([, v]) => ({
      label: v.label,
      firstSeenIso: v.firstIso,
      ageHours: Math.max(0, Math.floor((nowMs - v.firstMs) / 3_600_000)),
      noticeCount: v.count,
    }))
    .sort((a, b) => b.ageHours - a.ageHours);
}

const SMS_MAX_LEN = 300;

/** Pure: the operator SMS. Plain ASCII only — this goes out over the Quo
 *  alert line and a smart character would bill it as UCS-2 (see lib/sms/gsm7). */
export function composeContractWatchSms(env: PendingEnvelope): string {
  const days = Math.floor(env.ageHours / 24);
  const age = days >= 1 ? `${days}d` : `${env.ageHours}h`;
  const chased = env.noticeCount > 1 ? ` (${env.noticeCount} notices)` : "";
  const build = (label: string) =>
    `SIGN: "${label}" has been waiting on YOUR signature ${age}${chased}. Nothing closes until you sign it.`;

  let sms = build(env.label);
  if (sms.length > SMS_MAX_LEN) {
    const overBy = sms.length - SMS_MAX_LEN;
    const short =
      env.label.length > overBy + 4
        ? `${env.label.slice(0, Math.max(0, env.label.length - overBy - 4))}...`
        : env.label.slice(0, 1);
    sms = build(short).slice(0, SMS_MAX_LEN);
  }
  return sms;
}
