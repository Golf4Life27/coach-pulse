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
// TWO PLATFORMS, NOT ONE (2026-09-12). Watching DocuSign alone was still
// blind: the Birmingham contract (1005 2nd St, agent Pamela Calamusa) rides
// AUTHENTISIGN, so it never appeared. Both platforms are read now:
//   DocuSign     <dse@docusign.net>       awaiting "Complete with Docusign: X"
//                                         done     "Completed: X"
//   Authentisign <secure@authentisign.com> awaiting "Your signature is requested: X"
//                                         done     "Signing complete: X"
// Both collapse onto the SAME normalized label key, so a completion notice
// closes its pending entry whichever platform sent it. Reminders and resends
// repeat the identical subject (Birmingham sent three: 09-09 09:37Z, 09-10
// 13:39Z, 09-10 15:35Z), so the FIRST occurrence is the true age — a resend
// must never reset the clock, or a nagging agent silently hides how long we
// have been sitting.
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

/** Which e-sign platform sent the notice. The operator has to open a
 *  different app depending on the answer, so the SMS says which. */
export type SignPlatform = "docusign" | "authentisign";

export interface PendingEnvelope {
  /** The envelope name as the platform renders it, e.g. "Contract for 513 Lamar". */
  label: string;
  /** Which platform holds the envelope — where the operator has to go to sign. */
  platform: SignPlatform;
  /** ISO date of the EARLIEST "awaiting signature" mail for this label. */
  firstSeenIso: string;
  /** Whole hours since firstSeenIso. */
  ageHours: number;
  /** How many notices referenced this label — resends and reminders.
   *  A high count with a high age is an agent actively waiting on us. */
  noticeCount: number;
}

const DOCUSIGN_SENDER = /(^|[@.])docusign\.net$/i;
const AUTHENTISIGN_SENDER = /(^|[@.])authentisign\.com$/i;

// "Complete with Docusign: Contract for 513 Lamar" — action still owed.
const DOCUSIGN_AWAITING_RE = /^\s*complete\s+with\s+docusign:\s*(.+?)\s*$/i;
// "Completed: Contract for 513 Lamar" — fully executed, stop watching.
const DOCUSIGN_COMPLETED_RE = /^\s*completed:\s*(.+?)\s*$/i;
// "Your signature is requested: General/Financed Residential Contract - 12/24"
const AUTHENTISIGN_AWAITING_RE = /^\s*your\s+signature\s+is\s+requested:\s*(.+?)\s*$/i;
// "Signing complete: 1665 Ford St- Updated Offer Package"
const AUTHENTISIGN_COMPLETED_RE = /^\s*signing\s+complete:\s*(.+?)\s*$/i;

// "Voided: Complete with Docusign: Contract for 513 Lamar" — the sender
// killed the envelope (Bryan Ryder voided the original Lamar envelope on
// 2026-09-11 04:08Z and issued a revised one ten minutes later). A voided
// envelope will never complete, so without this it nags forever: the old
// Lamar envelope paged "waiting on YOUR signature 4d" a day after it was dead.
const DOCUSIGN_VOIDED_RE = /^\s*voided:\s*(?:complete\s+with\s+docusign:\s*)?(.+?)\s*$/i;

const AWAITING_RES = [DOCUSIGN_AWAITING_RE, AUTHENTISIGN_AWAITING_RE];
// Voided closes an envelope exactly like completed does — either way there is
// nothing left for the operator to sign.
const COMPLETED_RES = [DOCUSIGN_COMPLETED_RE, DOCUSIGN_VOIDED_RE, AUTHENTISIGN_COMPLETED_RE];

/** Which platform a sender address belongs to, or null for anything else.
 *  Domain is matched on the part after the LAST "@" so
 *  "noreply@docusign.net.evil.com" is not a DocuSign address. */
function senderPlatform(from: string): SignPlatform | null {
  const m = /<([^>]+)>/.exec(from ?? "");
  const addr = (m ? m[1] : (from ?? "")).trim().toLowerCase();
  const at = addr.lastIndexOf("@");
  if (at < 0) return null;
  const domain = addr.slice(at + 1);
  if (DOCUSIGN_SENDER.test(domain)) return "docusign";
  if (AUTHENTISIGN_SENDER.test(domain)) return "authentisign";
  return null;
}

function firstMatch(res: RegExp[], subject: string): string | null {
  for (const re of res) {
    const m = re.exec(subject);
    if (m) return m[1];
  }
  return null;
}

/** Normalize an envelope label so a resend, a reminder and the completion
 *  notice all collapse to the same key — across platforms too. */
function key(label: string): string {
  return label.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Pure: envelopes DocuSign or Authentisign says still owe a signature,
 *  oldest first. An envelope is dropped the moment a completion notice for
 *  the same label appears, regardless of ordering — mail can arrive out of
 *  order. */
export function findPendingSignatures(
  messages: ContractWatchMessage[],
  now: Date,
): PendingEnvelope[] {
  const awaiting = new Map<
    string,
    { label: string; platform: SignPlatform; firstMs: number; firstIso: string; count: number }
  >();
  const completed = new Set<string>();

  for (const m of messages ?? []) {
    const platform = senderPlatform(m?.from ?? "");
    if (platform == null) continue;
    const subject = m?.subject ?? "";

    const done = firstMatch(COMPLETED_RES, subject);
    if (done) {
      completed.add(key(done));
      continue;
    }

    const open = firstMatch(AWAITING_RES, subject);
    if (!open) continue;

    const ms = Date.parse(m?.date ?? "");
    if (!Number.isFinite(ms)) continue;

    const k = key(open);
    const prior = awaiting.get(k);
    if (!prior) {
      awaiting.set(k, {
        label: open.trim(),
        platform,
        firstMs: ms,
        firstIso: new Date(ms).toISOString(),
        count: 1,
      });
    } else {
      prior.count += 1;
      // EARLIEST wins — a resend is the agent chasing us, not a fresh clock.
      if (ms < prior.firstMs) {
        prior.firstMs = ms;
        prior.firstIso = new Date(ms).toISOString();
        prior.platform = platform;
      }
    }
  }

  const nowMs = now.getTime();
  return [...awaiting.entries()]
    .filter(([k]) => !completed.has(k))
    .map(([, v]) => ({
      label: v.label,
      platform: v.platform,
      firstSeenIso: v.firstIso,
      ageHours: Math.max(0, Math.floor((nowMs - v.firstMs) / 3_600_000)),
      noticeCount: v.count,
    }))
    .sort((a, b) => b.ageHours - a.ageHours);
}

const SMS_MAX_LEN = 300;

const PLATFORM_LABEL: Record<SignPlatform, string> = {
  docusign: "DocuSign",
  authentisign: "Authentisign",
};

/** Pure: the operator SMS. Plain ASCII only — this goes out over the Quo
 *  Maverick alert line and a smart character would bill it as UCS-2 (see
 *  lib/sms/gsm7). Names the platform: with two of them in play, "go sign it"
 *  is useless if the operator has to guess which app. */
export function composeContractWatchSms(env: PendingEnvelope): string {
  const days = Math.floor(env.ageHours / 24);
  const age = days >= 1 ? `${days}d` : `${env.ageHours}h`;
  const chased = env.noticeCount > 1 ? ` (${env.noticeCount} notices)` : "";
  const platform = PLATFORM_LABEL[env.platform] ?? "e-sign";
  const build = (label: string) =>
    `SIGN (${platform}): "${label}" has been waiting on YOUR signature ${age}${chased}. Nothing closes until you sign it.`;

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
