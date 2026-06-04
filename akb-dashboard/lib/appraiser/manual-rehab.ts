// INV-005 — Manual rehab affordance pure helpers.
// @agent: appraiser
//
// Backs POST /api/agents/appraiser/rehab/[recordId]/manual. The route
// is the fallback unlocked AFTER the vision GET path returns one of:
//   - no_photos_available  (422, collectPhotos returned [])
//   - photo_collection_failed (502, collectPhotos threw)
//   - vision_call_failed   (502, callRehabVision threw)
//
// Constitution Rule 3: manual input is fallback-only. The UI gates
// rendering of the manual form on the GET path having returned one of
// those failures. This module owns the pure validation + Airtable
// payload assembly so the route is thin and the predicate logic is
// unit-testable.
//
// Manual entries write Rehab_Confidence_Score = 50 (fixed), lower than
// the vision pipeline's typical 70-85, so downstream consumers can see
// the entry is less-confident-than-vision without leaning on the
// Rehab_Source flag alone.

export const MANUAL_REHAB_CONFIDENCE_SCORE = 50;

export const MANUAL_REHAB_SOURCES = ["manual_operator", "manual_partner"] as const;
export type ManualRehabSource = (typeof MANUAL_REHAB_SOURCES)[number];

export interface ManualRehabInput {
  rehab_mid: unknown;
  rehab_low?: unknown;
  rehab_high?: unknown;
  source: unknown;
}

export interface ValidatedManualRehab {
  rehabMid: number;
  rehabLow: number;
  rehabHigh: number;
  source: ManualRehabSource;
}

export type ManualRehabValidationError =
  | { error: "missing_rehab_mid"; reason: string }
  | { error: "invalid_rehab_mid"; reason: string }
  | { error: "invalid_rehab_band"; reason: string }
  | { error: "missing_source"; reason: string }
  | { error: "invalid_source"; reason: string };

export type ValidateResult =
  | { ok: true; value: ValidatedManualRehab }
  | { ok: false; error: ManualRehabValidationError };

/** Pure: validate + normalize the POST body. Coerces low/high to mid
 *  ±20% when omitted so downstream math has a band to work with. */
export function validateManualRehabPayload(body: ManualRehabInput): ValidateResult {
  if (body.rehab_mid === undefined || body.rehab_mid === null || body.rehab_mid === "") {
    return {
      ok: false,
      error: { error: "missing_rehab_mid", reason: "rehab_mid is required" },
    };
  }
  const mid = Number(body.rehab_mid);
  if (!Number.isFinite(mid) || mid <= 0) {
    return {
      ok: false,
      error: {
        error: "invalid_rehab_mid",
        reason: "rehab_mid must be a positive number",
      },
    };
  }

  let low: number;
  if (body.rehab_low === undefined || body.rehab_low === null || body.rehab_low === "") {
    low = Math.round(mid * 0.8);
  } else {
    low = Number(body.rehab_low);
    if (!Number.isFinite(low) || low < 0) {
      return {
        ok: false,
        error: {
          error: "invalid_rehab_band",
          reason: "rehab_low must be a non-negative number when provided",
        },
      };
    }
  }

  let high: number;
  if (body.rehab_high === undefined || body.rehab_high === null || body.rehab_high === "") {
    high = Math.round(mid * 1.2);
  } else {
    high = Number(body.rehab_high);
    if (!Number.isFinite(high) || high < 0) {
      return {
        ok: false,
        error: {
          error: "invalid_rehab_band",
          reason: "rehab_high must be a non-negative number when provided",
        },
      };
    }
  }

  if (low > mid || high < mid) {
    return {
      ok: false,
      error: {
        error: "invalid_rehab_band",
        reason: `rehab_low (${low}) must be ≤ rehab_mid (${mid}) ≤ rehab_high (${high})`,
      },
    };
  }

  if (body.source === undefined || body.source === null || body.source === "") {
    return {
      ok: false,
      error: { error: "missing_source", reason: "source is required" },
    };
  }
  if (typeof body.source !== "string" || !isManualRehabSource(body.source)) {
    return {
      ok: false,
      error: {
        error: "invalid_source",
        reason: `source must be one of ${MANUAL_REHAB_SOURCES.join(" | ")}`,
      },
    };
  }

  return {
    ok: true,
    value: { rehabMid: mid, rehabLow: low, rehabHigh: high, source: body.source },
  };
}

export function isManualRehabSource(value: string): value is ManualRehabSource {
  return (MANUAL_REHAB_SOURCES as readonly string[]).includes(value);
}

/** Pure: build the Airtable PATCH payload for a manual rehab write.
 *  Uses field names (not IDs) to match the existing GET route's
 *  convention. Line_Items_JSON is a minimal manual-shape envelope so
 *  AppraiserRehabPanel's parseRehabJson doesn't crash on read. */
export function buildManualRehabAirtableFields(
  v: ValidatedManualRehab,
  nowIso: string,
): Record<string, unknown> {
  return {
    Est_Rehab: v.rehabMid,
    Rehab_Est_Low: v.rehabLow,
    Est_Rehab_Mid: v.rehabMid,
    Rehab_Est_High: v.rehabHigh,
    Rehab_Confidence_Score: MANUAL_REHAB_CONFIDENCE_SCORE,
    Rehab_Line_Items_JSON: JSON.stringify({
      source: "manual",
      entered_by: v.source,
      rehab_mid: v.rehabMid,
      rehab_low: v.rehabLow,
      rehab_high: v.rehabHigh,
      entered_at: nowIso,
    }),
    Rehab_Red_Flags: "",
    Rehab_Estimated_At: nowIso,
    Rehab_Source: v.source,
  };
}

/** Pure: Notes audit line appended to the listing's Notes field on
 *  manual rehab entry. Mirrors INV-006 reconciler's Notes pattern. */
export function buildManualRehabNoteLine(
  now: Date,
  v: ValidatedManualRehab,
): string {
  const stamp = now.toLocaleDateString("en-US", {
    month: "numeric",
    day: "numeric",
    year: "2-digit",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  return `${stamp} — System: manual rehab entry. source=${v.source}, mid=$${v.rehabMid.toLocaleString("en-US")} (low=$${v.rehabLow.toLocaleString("en-US")}, high=$${v.rehabHigh.toLocaleString("en-US")}). INV-005 Option D.`;
}
