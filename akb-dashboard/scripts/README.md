# `scripts/` — operator-fire utilities

Standalone scripts the operator runs locally (not Vercel-deployed).

---

## `dedupe_export.py` — PropStream pre-Make dedupe

### What

Filters a raw PropStream CSV export against active Airtable
Listings_V1 records so duplicates from prior weekly exports never
reach Scenario A. Saves ~140-350 Make ops per export (at 200-500
rows with ~70% week-over-week overlap), and prevents downstream
Phase 4 Appraiser cost on records that'd be discarded anyway.

### When

Weekly, before dropping the PropStream CSV into Drive for Scenario A
pickup. Workflow:

1. Export from PropStream (current playbook).
2. Run `dedupe_export.py` against the raw CSV.
3. Drop the cleaned CSV into Drive (where Scenario A picks it up).

Sprint R ships the script. Sprint C (Phase C, Claude in Chrome
routine) will schedule the weekly invocation. Until then, manual.

### Usage

```bash
# From repo root:
python3 akb-dashboard/scripts/dedupe_export.py \
    --input ~/Downloads/propstream-export.csv \
    --output ./outputs/clean.csv
```

The output filename gets a UTC timestamp suffix automatically so
reruns don't clobber. The example above writes:

```
./outputs/clean.20260519T185300Z.csv
```

### Required env

| Var | Purpose | Default |
|---|---|---|
| `AIRTABLE_PAT` | Personal access token with Listings_V1 read scope | — (required) |
| `AIRTABLE_BASE_ID` | Airtable base | `appp8inLAGTg4qpEZ` |
| `DEDUPE_WINDOW_DAYS` | Rolling window for "active" record check | `90` |

### Output

Logs to stdout (no log file — Sprint C routine will capture):

```
[dedupe] Fetched 1230 Airtable records across 13 page(s); 1227 unique address keys (window=90d).
[dedupe] Rows in: 432 | duplicated: 301 | unusable (missing street/zip): 0 | rows out: 131
[dedupe] Done in 4.18s. Output: ./outputs/clean.20260519T185300Z.csv
```

### Soft-fail behavior

If `AIRTABLE_PAT` is unset OR the Airtable API errors, the script
passes ALL input rows through unfiltered with a `WARNING:` line
to stdout. Sprint R principle: never block the export, even
imperfectly.

### Algorithm — address normalization

Mirrors `lib/dedupe/normalize.ts` (canonical TypeScript implementation
tested via vitest in `lib/dedupe/normalize.test.ts`). Both produce
identical output. If you change one, change both — the test suite
locks the contract.

Normalization steps:

1. Lowercase the address.
2. Apostrophes + quotes collapse to nothing (`"O'Brien"` → `"obrien"`).
3. Other punctuation (periods, commas, hash, ampersand, slashes) becomes
   a space (`"St."` → `"St"`).
4. Whitespace collapses (`"100\tMain  Street"` → `"100 main street"`).
5. Directionals normalize to canonical short form
   (`NORTH` / `North` / `N` → `n`; same for S/E/W/NE/NW/SE/SW).
6. Canonical key = `<normalized street>|<zip>`.

Hyphens are preserved — they appear in unit numbers (`1219-A`) and
collapsing them would merge separate addresses.

### Performance

Tested at 500-row CSV against ~1200 Airtable records (90-day
window). Cold-cache run completes in <10 seconds — most of which is
Airtable pagination at 5 req/sec (Airtable's rate limit).

### NOT in scope for Sprint R

- Scheduled execution (Phase C / Sprint C — Claude-in-Chrome routine).
- Drive upload after dedupe (Sprint C).
- Crawler 2.0 candidate deduping (Phase 13.6 — when off-market
  adapters credentialed).
- Cross-base archive lookups (Map 2 — Memory Stores substrate).

---

## `gen-test-count.mjs` — prebuild test counter

Vercel-build-time artifact generator. Counts test files + test
cases, writes `lib/maverick/data/test-counts.json` so the briefing
aggregator can surface a "tests passing" count without re-running
vitest at runtime. Wired into `package.json` prebuild script. No
operator action.
