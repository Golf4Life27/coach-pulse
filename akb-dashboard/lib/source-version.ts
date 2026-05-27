// Source_Version field (INV-LEGACY-BACKSTOP). Walls the ~3,499 pre-v2
// legacy records off from the v2 active working surface without deleting
// anything. Field + options were created in Airtable by the operator
// (2026-05-27); IDs are baked here per the spec so reads/queries are
// rename-proof.
//
// v2 records (crawler+enrichment, 2026-05-26 onward) are the active surface.
// v1 records stay queryable for dedupe and historical lookup but are hidden
// by default from working UI and excluded from H2 outreach eligibility.

export const SOURCE_VERSION_FIELD_ID = "fldTaEgWfHMDmfgaV";
export const SOURCE_VERSION_FIELD_NAME = "Source_Version";

// singleSelect option NAMES (written by name with typecast; the exact
// literals must match the Airtable options or typecast would mint a dup).
export const SOURCE_VERSION_V1_LEGACY = "v1_legacy";
export const SOURCE_VERSION_V2 = "v2_post_2026-05-26";

// singleSelect option IDs (for reference / precise queries).
export const SOURCE_VERSION_V1_OPTION_ID = "selOvlh9dIEBxwV2f";
export const SOURCE_VERSION_V2_OPTION_ID = "selxaXIEsijjcZTJV";
