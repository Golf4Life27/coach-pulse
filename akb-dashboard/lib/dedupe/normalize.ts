// Sprint R / Phase B.5 — PropStream pre-Make dedupe.
//
// Canonical TypeScript implementation of the address-normalization +
// dedupe-pipeline logic. The Python operator script
// (scripts/dedupe_export.py) mirrors this implementation — same
// algorithm, separate runtime so the operator can fire it from a
// local shell without Node setup.
//
// Why two implementations:
//   - Python script runs locally against a CSV the operator drops
//     into ~/Downloads, hits Airtable, writes the cleaned CSV.
//     Single-purpose, no Node dependency, no Vercel runtime.
//   - TypeScript helpers are the contract the rest of the app
//     consumes (future Sentinel intake-pipeline calls dedupeRows
//     when promoting Crawler candidates).
//
// Sprint R principles applied:
//   - Single-purpose. No clever generalization beyond what tests cover.
//   - Soft-fail on the I/O boundary (fetchExistingKeys throws →
//     pipeline returns raw rows with a warning, NEVER blocks export).
//   - Pure helpers exported for testability.

// Directional canonicalization: long form → short form.
// "NORTH" → "N", "EAST" → "E", etc. Bidirectional via the same map
// (we always emit the short form).
const DIRECTIONALS: Record<string, string> = {
  NORTH: "n",
  SOUTH: "s",
  EAST: "e",
  WEST: "w",
  NORTHEAST: "ne",
  NORTHWEST: "nw",
  SOUTHEAST: "se",
  SOUTHWEST: "sw",
};

/** Pure: lowercase + strip punctuation + collapse whitespace +
 *  normalize directionals (long-form → canonical short form).
 *  Empty / null input returns empty string (callers gate against
 *  this when building dedupe keys). */
export function normalizeAddress(raw: string | null | undefined): string {
  if (!raw) return "";
  // 1. lowercase
  let s = raw.toLowerCase();
  // 2. strip punctuation. Apostrophes + quotes collapse to nothing
  //    ("O'Brien" → "obrien") because operators routinely drop them.
  //    Other punctuation (periods, commas, hash, ampersand, slashes)
  //    becomes a space so "St." and "St" canonicalize the same.
  //    Hyphens preserved — they appear in unit numbers (1219-A) and
  //    collapsing them would merge separate addresses.
  s = s.replace(/['"]/g, "");
  s = s.replace(/[.,#&/\\]/g, " ");
  // 3. collapse whitespace
  s = s.replace(/\s+/g, " ").trim();
  if (!s) return "";
  // 4. normalize directionals — split tokens, replace each, rejoin.
  //    Match against the UPPERCASE token so "NORTH" / "north" /
  //    "North" all collapse to "n".
  const tokens = s.split(" ").map((token) => {
    const upper = token.toUpperCase();
    if (upper in DIRECTIONALS) return DIRECTIONALS[upper];
    return token;
  });
  return tokens.join(" ");
}

/** Pure: build the canonical address-key for dedupe lookup. Combines
 *  normalized street + zip into a single string key. Empty inputs
 *  return empty string — callers should skip empty keys when building
 *  the existing-keys set. */
export function buildAddressKey(
  street: string | null | undefined,
  zip: string | null | undefined,
): string {
  const normStreet = normalizeAddress(street);
  const normZip = (zip ?? "").toString().trim();
  if (!normStreet || !normZip) return "";
  return `${normStreet}|${normZip}`;
}

export interface PropStreamRow {
  /** Raw CSV row preserved verbatim so the operator can audit the
   *  dedupe decision against the original data. */
  raw: Record<string, string>;
  /** Street address column extracted by the script. */
  street: string;
  /** Zip code column extracted by the script. */
  zip: string;
}

export type DedupeStatus = "ok" | "soft_failed_airtable";

export interface DedupeResult {
  /** Rows that passed dedupe (no existing key match). Order
   *  preserved from input. */
  passed: PropStreamRow[];
  /** Rows that matched an existing record + were filtered out. */
  duplicates: PropStreamRow[];
  /** Rows skipped because they have no usable address key (empty
   *  street or zip) — preserved separately so the operator can
   *  audit / fix the source CSV. */
  unusable: PropStreamRow[];
  /** Pipeline-level status. "soft_failed_airtable" means
   *  fetchExistingKeys threw; pipeline degraded gracefully and
   *  returned all input rows in passed[]. */
  status: DedupeStatus;
  /** Warning message when status !== "ok". */
  warning?: string;
}

/** Pure: filter input rows against an existing-keys set. */
export function dedupeRows(
  rows: PropStreamRow[],
  existingKeys: Set<string>,
): { passed: PropStreamRow[]; duplicates: PropStreamRow[]; unusable: PropStreamRow[] } {
  const passed: PropStreamRow[] = [];
  const duplicates: PropStreamRow[] = [];
  const unusable: PropStreamRow[] = [];
  for (const row of rows) {
    const key = buildAddressKey(row.street, row.zip);
    if (!key) {
      unusable.push(row);
      continue;
    }
    if (existingKeys.has(key)) {
      duplicates.push(row);
    } else {
      passed.push(row);
    }
  }
  return { passed, duplicates, unusable };
}

export interface DedupePipelineDeps {
  /** Fetches the set of existing address keys from Airtable
   *  (filtered to the rolling window). Throws on I/O failure — the
   *  pipeline catches and soft-fails. */
  fetchExistingKeys: () => Promise<Set<string>>;
}

/** Compose: run dedupe with the injected fetcher. Soft-fail on
 *  Airtable error → return all input rows in passed[] with status
 *  "soft_failed_airtable" + a warning. Operator's CSV ingestion
 *  must never be blocked by Airtable hiccups. */
export async function runDedupePipeline(
  rows: PropStreamRow[],
  deps: DedupePipelineDeps,
): Promise<DedupeResult> {
  let existingKeys: Set<string>;
  try {
    existingKeys = await deps.fetchExistingKeys();
  } catch (err) {
    const warning = `Airtable fetch failed; passing all ${rows.length} rows through unfiltered. ${String(err).slice(0, 200)}`;
    return {
      passed: rows,
      duplicates: [],
      unusable: [],
      status: "soft_failed_airtable",
      warning,
    };
  }
  const split = dedupeRows(rows, existingKeys);
  return { ...split, status: "ok" };
}

/** Pure: read the rolling-window day count from env, with default
 *  + defensive parsing. Mirror in the Python script. */
export function readDedupeWindowDays(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): number {
  const raw = env.DEDUPE_WINDOW_DAYS;
  if (!raw) return 90;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 90;
  return Math.floor(n);
}
