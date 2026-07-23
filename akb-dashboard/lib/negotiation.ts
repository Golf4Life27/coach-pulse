import { extractFirstName } from "./utils";

const AIRTABLE_PAT = process.env.AIRTABLE_PAT!;
const BASE_ID = process.env.AIRTABLE_BASE_ID || "appp8inLAGTg4qpEZ";
const LISTINGS_TABLE = "tbldMjKBgPiq45Jjs";

// Field IDs for the negotiation context — single source of truth
const NEGOTIATION_FIELD_IDS = {
  address: "fldwvp72hKTfiHHjj",
  listPrice: "fld9J3Vi9fTq3zzMU",
  agentName: "fld69oB0no6tfguom",
  agentPhone: "fldee9MOstjNDKjnm",
  outreachStatus: "fldGIgqwyCJg4uFyv",
  notes: "fldwKGxZly6O8qyPu",
  lastContacted: "fldbRrOW3IEoLtnFE",
  // Stored value-anchored door-opener (INVARIANTS §2). roughOpenerAmount is
  // the modern value-anchored number (anchor × (ARV×buybox − rehab − fee));
  // outreachOfferPrice is the legacy slot for older deals. The 65%-of-list
  // rule was RETIRED 2026-06-28 — we read the STORED opener, never recompute
  // a fraction of list.
  roughOpenerAmount: "fldiOvLQZaLpK7lTD",
  outreachOfferPrice: "fldBFnL0HQJWahRov",
};

export interface NegotiationContext {
  recordId: string;
  address: string;
  list_price: number;
  /** Stored value-anchored door-opener, or null when the record HOLDs (no
   *  trusted opener on file). NEVER a freshly-computed fraction of list. */
  our_offer: number | null;
  agent_first_name: string;
  agent_phone: string;
  days_since_contact: number;
  last_reply_excerpt: string;
}

const ALLOWED_STATUSES = ["Negotiating", "Offer Accepted"];

export async function getNegotiationContext(
  recordId: string
): Promise<NegotiationContext> {
  const fieldIds = Object.values(NEGOTIATION_FIELD_IDS);
  const params = new URLSearchParams();
  fieldIds.forEach((f) => params.append("fields[]", f));
  params.set("returnFieldsByFieldId", "true");

  const url = `https://api.airtable.com/v0/${BASE_ID}/${LISTINGS_TABLE}/${recordId}?${params.toString()}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${AIRTABLE_PAT}` },
    cache: "no-store",
  });

  if (res.status === 404) {
    throw new RecordNotFoundError(recordId);
  }
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Airtable error ${res.status}: ${errText}`);
  }

  const record = await res.json();
  const fields = record.fields as Record<string, unknown>;

  const outreachStatus = fields[NEGOTIATION_FIELD_IDS.outreachStatus] as
    | string
    | undefined;
  if (!outreachStatus || !ALLOWED_STATUSES.includes(outreachStatus)) {
    throw new NotNegotiatingError(outreachStatus ?? "empty");
  }

  const listPrice = (fields[NEGOTIATION_FIELD_IDS.listPrice] as number) ?? 0;
  // Read the STORED value-anchored opener; never recompute from list price.
  // Modern deals carry Rough_Opener_Amount; older ones the legacy
  // Outreach_Offer_Price slot. Neither present ⇒ null (HOLD for operator).
  const ourOffer =
    (fields[NEGOTIATION_FIELD_IDS.roughOpenerAmount] as number | undefined) ??
    (fields[NEGOTIATION_FIELD_IDS.outreachOfferPrice] as number | undefined) ??
    null;

  const notes = (fields[NEGOTIATION_FIELD_IDS.notes] as string) ?? "";
  const paragraphs = notes.split("\n").filter((p) => p.trim());
  const lastReply = paragraphs[paragraphs.length - 1] ?? "";

  const lastContactedRaw = fields[NEGOTIATION_FIELD_IDS.lastContacted] as
    | string
    | undefined;
  let daysSince = 0;
  if (lastContactedRaw) {
    const lastDate = new Date(lastContactedRaw);
    daysSince = Math.floor(
      (Date.now() - lastDate.getTime()) / (1000 * 60 * 60 * 24)
    );
  }

  return {
    recordId,
    address: (fields[NEGOTIATION_FIELD_IDS.address] as string) ?? "",
    list_price: listPrice,
    our_offer: ourOffer,
    agent_first_name: extractFirstName(
      fields[NEGOTIATION_FIELD_IDS.agentName] as string | undefined
    ),
    agent_phone: (fields[NEGOTIATION_FIELD_IDS.agentPhone] as string) ?? "",
    days_since_contact: daysSince,
    last_reply_excerpt: lastReply.slice(0, 500),
  };
}

export class RecordNotFoundError extends Error {
  constructor(id: string) {
    super(`Record ${id} not found`);
    this.name = "RecordNotFoundError";
  }
}

export class NotNegotiatingError extends Error {
  constructor(status: string) {
    super(
      `Record Outreach_Status is "${status}", not "Negotiating"`
    );
    this.name = "NotNegotiatingError";
  }
}
