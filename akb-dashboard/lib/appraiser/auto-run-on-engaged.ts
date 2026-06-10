// 2026-06-10 ruling — Auto-run Appraiser on Texted → Response Received.
//
// The manual "Run ARV" / "Run rehab" buttons in the AppraiserArvPanel /
// AppraiserRehabPanel were a credit gate from when every scraped record
// was a candidate. The reply is the gate now: by the time the seller
// responds, the credit spend is justified, and the negotiation window is
// measured in minutes — Alex should not need to click two buttons before
// he can think about the offer.
//
// This helper fires the per-record Appraiser routes the instant
// scan-replies records the transition. Auth flows through the standard
// waterfall (CRON_SECRET on the scan-replies invocation forwards to the
// sub-routes — same trick admin/appraiser-backfill uses, see route.ts
// header for the 2026-06-04 reconciliation history).
//
// Two-track posture:
//   ARV  — awaited inline (10-20s). Operator needs the number fresh
//          when the reply alert lands. ARV is also cheap enough that
//          it fits the scan-replies 60s budget even with the existing
//          per-phone Quo work.
//   Rehab — fire-and-forget (15-30s via Anthropic vision). The
//          AppraiserRehabPanel already surfaces a "Run rehab" one-click
//          if the auto-kick doesn't land (no photos, vision down, lambda
//          cut). Per the ruling: "Rehab auto-runs on the same transition
//          if it can run unattended; otherwise surface as a prepared
//          one-click."
//
// Idempotent: the appraiser routes are safe to re-call; their write paths
// only stamp ARV_Validated_At / Rehab_Estimated_At on a fresh successful
// compute. A re-run on an already-priced record just refreshes those
// timestamps (same surface a Refresh click produces).

const CRON_SECRET = process.env.CRON_SECRET;

export interface EngagedAutoRunResult {
  recordId: string;
  arvAttempted: boolean;
  arvOk: boolean;
  arvHttpStatus: number | null;
  arvElapsedMs: number;
  rehabKicked: boolean;
  error: string | null;
}

export interface EngagedAutoRunInput {
  recordId: string;
  origin: string;
  /** Forward an explicit cookie (operator-driven path); otherwise the
   *  CRON_SECRET bearer carries the auth. */
  cookie?: string | null;
  /** Skip the rehab kick (callers that already know there are no
   *  photos, or backfill loops trying to stay within budget). */
  skipRehab?: boolean;
}

export async function autoRunOnEngaged(
  input: EngagedAutoRunInput,
): Promise<EngagedAutoRunResult> {
  const { recordId, origin, cookie, skipRehab } = input;

  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  if (CRON_SECRET) headers.authorization = `Bearer ${CRON_SECRET}`;

  const arvT0 = Date.now();
  let arvOk = false;
  let arvHttpStatus: number | null = null;
  let error: string | null = null;
  try {
    const res = await fetch(`${origin}/api/agents/appraiser/arv/${recordId}`, {
      headers,
      cache: "no-store",
    });
    arvHttpStatus = res.status;
    arvOk = res.ok;
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      error = body ? body.slice(0, 240) : `arv_http_${res.status}`;
    }
  } catch (err) {
    error = err instanceof Error ? err.message.slice(0, 240) : String(err).slice(0, 240);
  }
  const arvElapsedMs = Date.now() - arvT0;

  // Fire-and-forget rehab. Failures (no photos, vision call failed, 60s
  // timeout) are intentionally swallowed — the AppraiserRehabPanel's
  // manual "Run rehab" CTA is the prepared one-click fallback. Errors
  // still land in the rehab route's own audit log.
  let rehabKicked = false;
  if (!skipRehab) {
    rehabKicked = true;
    void fetch(`${origin}/api/agents/appraiser/rehab/${recordId}`, {
      headers,
      cache: "no-store",
    }).catch(() => {});
  }

  return {
    recordId,
    arvAttempted: true,
    arvOk,
    arvHttpStatus,
    arvElapsedMs,
    rehabKicked,
    error,
  };
}

/** Pure helper for callers that only have a Request — extracts the
 *  scheme + host so the internal fetch hits the same deployment, not
 *  the production alias from a preview lambda. */
export function originFromRequest(req: Request): string {
  const url = new URL(req.url);
  return `${url.protocol}//${url.host}`;
}
