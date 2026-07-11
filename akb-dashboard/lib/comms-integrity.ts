// Comms capture-gap detector (silver-platter cockpit, operator 2026-07-11).
//
// THE HARD REQUIREMENT: every inbound/outbound on both channels lands on its
// record, timestamped and deduped — and a capture gap surfaces as an ALERT,
// never silently. The named class (spine recAp5FctVOMzGOAL, "3731 Baltimore"):
// a cross-thread agent reply stamped Last_Inbound_At on BOTH sibling records
// while the notes append landed on only ONE — the record shows an inbound
// timestamp and an EMPTY inbound timeline. Same shape catches vanished
// appends and sibling-attribution misses (the merged timeline filters
// sub-0.6-confidence entries out of this record's thread, so the stamped
// message is absent here — exactly what the operator must SEE).
//
// Detection is stamp-vs-timeline: the record's own contact timestamps claim a
// message happened; if the record's merged timeline carries NO message of
// that direction at-or-after the stamp (less a generous tolerance for
// append-lag), the record is missing a message it says it received/sent.
//
// Tolerance is deliberately WIDE (default 24h): the sync crons append with
// lag and notes timestamps are parse-derived, and a false alert teaches the
// operator to ignore the feed (the exact failure the cockpit exists to kill).
// The named classes are TOTAL absences — a wide tolerance still catches them.
//
// PURE. No I/O.

export interface CaptureGap {
  direction: "inbound" | "outbound";
  /** The contact stamp the record carries. */
  stampedAt: string;
  /** How old the un-captured message is, hours (from nowIso). */
  ageHours: number;
  detail: string;
}

export interface CommsIntegrityVerdict {
  ok: boolean;
  gaps: CaptureGap[];
  checkedAt: string;
  toleranceHours: number;
}

export const DEFAULT_GAP_TOLERANCE_HOURS = 24;

const HOUR_MS = 3_600_000;

function parseMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

export function detectCaptureGaps(input: {
  lastInboundAt: string | null | undefined;
  lastOutboundAt: string | null | undefined;
  /** Email outbound stamp — outbound coverage spans both channels. */
  lastEmailOutreachDate?: string | null;
  messages: Array<{ direction: "inbound" | "outbound" | "system"; timestamp: string }>;
  nowIso: string;
  toleranceHours?: number;
}): CommsIntegrityVerdict {
  const tolerance = input.toleranceHours ?? DEFAULT_GAP_TOLERANCE_HOURS;
  const now = parseMs(input.nowIso) ?? Date.now();
  const gaps: CaptureGap[] = [];

  const newestByDirection = (dir: "inbound" | "outbound"): number | null => {
    let newest: number | null = null;
    for (const m of input.messages) {
      if (m.direction !== dir) continue;
      const t = parseMs(m.timestamp);
      if (t != null && (newest == null || t > newest)) newest = t;
    }
    return newest;
  };

  const check = (dir: "inbound" | "outbound", stampIso: string | null | undefined, label: string) => {
    const stamp = parseMs(stampIso);
    if (stamp == null) return; // no stamp → nothing claimed → nothing to verify
    // Grace: a stamp minted moments ago may precede the sync cron's append.
    if (now - stamp < tolerance * HOUR_MS) return;
    const newest = newestByDirection(dir);
    if (newest != null && newest >= stamp - tolerance * HOUR_MS) return; // captured
    gaps.push({
      direction: dir,
      stampedAt: new Date(stamp).toISOString(),
      ageHours: Math.round((now - stamp) / HOUR_MS),
      detail:
        newest == null
          ? `${label} stamped ${new Date(stamp).toISOString().slice(0, 16)}Z but the timeline carries NO ${dir} message at all — the 3731 Baltimore class (message on the wire, not on the record).`
          : `${label} stamped ${new Date(stamp).toISOString().slice(0, 16)}Z but the newest ${dir} on the timeline is ${new Date(newest).toISOString().slice(0, 16)}Z — a later message never landed on this record.`,
    });
  };

  check("inbound", input.lastInboundAt, "Last_Inbound_At");
  // Outbound stamp = the latest of SMS + email outbound claims.
  const outbound = [parseMs(input.lastOutboundAt), parseMs(input.lastEmailOutreachDate ?? null)]
    .filter((t): t is number => t != null)
    .sort((a, b) => b - a)[0];
  check("outbound", outbound != null ? new Date(outbound).toISOString() : null, "Last outbound stamp");

  return {
    ok: gaps.length === 0,
    gaps,
    checkedAt: new Date(now).toISOString(),
    toleranceHours: tolerance,
  };
}
