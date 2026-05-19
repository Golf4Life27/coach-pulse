#!/usr/bin/env python3
"""
Sprint R / Phase B.5 — PropStream pre-Make dedupe.

Reads a raw PropStream CSV export, fetches active Airtable
Listings_V1 records updated in the last N days (default 90), filters
out rows whose canonical address key already exists, writes a cleaned
CSV to outputs/.

Soft-fails on Airtable I/O: if the API is unreachable, ALL input
rows pass through with a warning. Better to ingest duplicates than
block the export.

Address normalization MIRRORS the TypeScript implementation in
akb-dashboard/lib/dedupe/normalize.ts. If you change one, change
both. Tests in lib/dedupe/normalize.test.ts lock the contract.

Usage:
    python scripts/dedupe_export.py \\
        --input ~/Downloads/propstream.csv \\
        --output ./outputs/clean.csv

Env:
    AIRTABLE_PAT             — required (Airtable PAT with Listings_V1 read)
    AIRTABLE_BASE_ID         — defaults to appp8inLAGTg4qpEZ
    DEDUPE_WINDOW_DAYS       — defaults to 90

Stdlib only — no external deps. Run anywhere with Python 3.8+.
"""
import argparse
import csv
import json
import os
import re
import sys
import time
from datetime import datetime, timedelta, timezone
from typing import Optional
from urllib import error as urlerror
from urllib import parse, request

# ── Constants ──────────────────────────────────────────────────────────────

DEFAULT_BASE_ID = "appp8inLAGTg4qpEZ"
LISTINGS_TABLE = "tbldMjKBgPiq45Jjs"

# Directional canonicalization — long form → short form.
# Mirror of DIRECTIONALS in lib/dedupe/normalize.ts.
DIRECTIONALS = {
    "NORTH": "n",
    "SOUTH": "s",
    "EAST": "e",
    "WEST": "w",
    "NORTHEAST": "ne",
    "NORTHWEST": "nw",
    "SOUTHEAST": "se",
    "SOUTHWEST": "sw",
}

# Punctuation classes — mirror of TS regexes.
APOSTROPHE_RE = re.compile(r"['\"]")
PUNCT_RE = re.compile(r"[.,#&/\\]")
WHITESPACE_RE = re.compile(r"\s+")


# ── Normalization helpers (mirror lib/dedupe/normalize.ts) ────────────────

def normalize_address(raw: Optional[str]) -> str:
    """Lowercase + strip punctuation + collapse whitespace + normalize
    directionals. Mirrors normalizeAddress in lib/dedupe/normalize.ts."""
    if not raw:
        return ""
    s = raw.lower()
    s = APOSTROPHE_RE.sub("", s)
    s = PUNCT_RE.sub(" ", s)
    s = WHITESPACE_RE.sub(" ", s).strip()
    if not s:
        return ""
    tokens = []
    for tok in s.split(" "):
        upper = tok.upper()
        tokens.append(DIRECTIONALS.get(upper, tok))
    return " ".join(tokens)


def build_address_key(street: Optional[str], zip_code: Optional[str]) -> str:
    """Canonical key = `<normalized street>|<zip>`. Empty when either
    input is missing. Mirrors buildAddressKey in lib/dedupe/normalize.ts."""
    norm_street = normalize_address(street)
    norm_zip = str(zip_code or "").strip()
    if not norm_street or not norm_zip:
        return ""
    return f"{norm_street}|{norm_zip}"


def read_window_days() -> int:
    """Mirror of readDedupeWindowDays in lib/dedupe/normalize.ts."""
    raw = os.environ.get("DEDUPE_WINDOW_DAYS")
    if not raw:
        return 90
    try:
        n = int(raw)
        return n if n > 0 else 90
    except ValueError:
        return 90


# ── Airtable I/O ──────────────────────────────────────────────────────────

def fetch_existing_keys(
    pat: str,
    base_id: str,
    window_days: int,
) -> set:
    """Fetch all Listings_V1 records updated in the last `window_days`
    and return their canonical address keys. Raises on I/O error;
    caller soft-fails."""
    cutoff = (datetime.now(timezone.utc) - timedelta(days=window_days)).isoformat()
    # filterByFormula keeps fetch bounded — only records modified
    # in window. LAST_MODIFIED_TIME() applies to the whole record.
    formula = f"IS_AFTER(LAST_MODIFIED_TIME(), DATETIME_PARSE('{cutoff}'))"

    keys: set = set()
    offset: Optional[str] = None
    page_count = 0
    record_count = 0

    while True:
        page_count += 1
        params = {
            "pageSize": "100",
            "filterByFormula": formula,
            # Trim fields to just what we need — keeps response light.
            "fields[]": ["Address", "Zip"],
        }
        if offset:
            params["offset"] = offset
        url = (
            f"https://api.airtable.com/v0/{base_id}/{LISTINGS_TABLE}"
            f"?{parse.urlencode(params, doseq=True)}"
        )
        req = request.Request(
            url,
            headers={"Authorization": f"Bearer {pat}"},
        )
        with request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode("utf-8"))

        for record in data.get("records", []):
            fields = record.get("fields", {})
            address = fields.get("Address")
            zip_code = fields.get("Zip")
            key = build_address_key(address, zip_code)
            if key:
                keys.add(key)
            record_count += 1

        offset = data.get("offset")
        if not offset:
            break
        # Be gentle with Airtable's 5 req/sec rate limit.
        time.sleep(0.21)

    print(
        f"[dedupe] Fetched {record_count} Airtable records across {page_count} page(s); "
        f"{len(keys)} unique address keys (window={window_days}d).",
        file=sys.stdout,
    )
    return keys


# ── CSV processing ────────────────────────────────────────────────────────

# PropStream CSV column names. Defensive: support a few variants so a
# rename in PropStream's export doesn't silently break dedupe.
STREET_COLUMNS = ["Address", "Property Address", "Street", "address", "street"]
ZIP_COLUMNS = ["Zip", "ZIP", "Zip Code", "Postal Code", "zip"]


def pick_column(row: dict, candidates: list) -> str:
    """Return the first non-empty value among candidate column names."""
    for col in candidates:
        v = row.get(col)
        if v is not None and str(v).strip():
            return str(v).strip()
    return ""


def dedupe_csv(
    input_path: str,
    output_path: str,
    existing_keys: set,
    soft_failed: bool,
    warning: Optional[str],
) -> None:
    """Read input CSV, filter rows whose address key is in
    existing_keys, write the cleaned CSV to output_path."""
    rows_in = 0
    rows_dup = 0
    rows_out = 0
    rows_unusable = 0

    with open(input_path, "r", encoding="utf-8-sig") as f_in:
        reader = csv.DictReader(f_in)
        fieldnames = reader.fieldnames or []
        if not fieldnames:
            print("[dedupe] Input CSV has no header row; nothing to do.", file=sys.stderr)
            sys.exit(2)

        os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
        with open(output_path, "w", encoding="utf-8", newline="") as f_out:
            writer = csv.DictWriter(f_out, fieldnames=fieldnames)
            writer.writeheader()

            for row in reader:
                rows_in += 1
                street = pick_column(row, STREET_COLUMNS)
                zip_code = pick_column(row, ZIP_COLUMNS)
                key = build_address_key(street, zip_code)

                if soft_failed:
                    # Soft-fail path: pass everything through unfiltered.
                    writer.writerow(row)
                    rows_out += 1
                    continue

                if not key:
                    # Unusable row (missing street or zip). Write it
                    # through — operator audits.
                    writer.writerow(row)
                    rows_unusable += 1
                    rows_out += 1
                    continue

                if key in existing_keys:
                    rows_dup += 1
                    continue

                writer.writerow(row)
                rows_out += 1
                # Add to the existing set so duplicates WITHIN the input
                # CSV also collapse.
                existing_keys.add(key)

    print(
        f"[dedupe] Rows in: {rows_in} | duplicated: {rows_dup} | "
        f"unusable (missing street/zip): {rows_unusable} | rows out: {rows_out}",
        file=sys.stdout,
    )
    if warning:
        print(f"[dedupe] WARNING: {warning}", file=sys.stdout)


# ── CLI ───────────────────────────────────────────────────────────────────

def main() -> int:
    parser = argparse.ArgumentParser(
        description="Dedupe a PropStream CSV export against active Airtable Listings_V1.",
    )
    parser.add_argument("--input", required=True, help="Path to raw PropStream CSV.")
    parser.add_argument("--output", required=True, help="Path to write cleaned CSV.")
    args = parser.parse_args()

    pat = os.environ.get("AIRTABLE_PAT")
    base_id = os.environ.get("AIRTABLE_BASE_ID") or DEFAULT_BASE_ID
    window_days = read_window_days()
    t0 = time.time()

    # Auto-stamp the output filename with a timestamp so reruns don't
    # clobber. Operator can pass --output ./outputs/clean.csv and the
    # script will write ./outputs/clean.20260519T185300Z.csv.
    out_path = args.output
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    base, ext = os.path.splitext(out_path)
    out_path = f"{base}.{stamp}{ext or '.csv'}"

    existing_keys: set = set()
    soft_failed = False
    warning: Optional[str] = None

    if not pat:
        soft_failed = True
        warning = "AIRTABLE_PAT env not set — no dedupe possible. All rows pass through unfiltered."
        print(f"[dedupe] WARNING: {warning}", file=sys.stdout)
    else:
        try:
            existing_keys = fetch_existing_keys(pat, base_id, window_days)
        except (urlerror.URLError, urlerror.HTTPError, TimeoutError) as e:
            soft_failed = True
            warning = (
                f"Airtable fetch failed ({type(e).__name__}: {e}); "
                "all rows pass through unfiltered."
            )
            print(f"[dedupe] WARNING: {warning}", file=sys.stdout)

    dedupe_csv(args.input, out_path, existing_keys, soft_failed, warning)
    elapsed = time.time() - t0
    print(f"[dedupe] Done in {elapsed:.2f}s. Output: {out_path}", file=sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
