// BUYER INTAKE — pure validation for the ONE unauthenticated write path in
// this app (2026-09-12).
//
// /api/buyers/intake takes a body from anyone on the internet and turns it
// into an Airtable record plus two outbound emails. Before this file it
// checked a name and an email-shaped string and passed everything else
// straight through: a 5 MB notes field, a 20k-entry markets array, or a
// scripted stuffer hitting it 400 times an hour all landed in the buyer table
// and in Alex's inbox. Airtable is the system of record for who gets a deal
// blast, so junk in here is not cosmetic — it poisons the shortlist.
//
// Everything here is pure so it can be tested without a network: the route
// does size -> parse -> honeypot -> validate -> rate limit, and this file owns
// the honeypot predicate and the validation.

export const INTAKE_MAX_BODY_BYTES = 8 * 1024;

export const INTAKE_CAPS = {
  name: 120,
  email: 200,
  entity: 120,
  phone: 40,
  targetZips: 300,
  notes: 2000,
  buyerType: 60,
  arrayItems: 20,
  arrayItemChars: 60,
} as const;

export interface IntakeValue {
  name: string;
  email: string;
  entity: string | null;
  phone: string | null;
  markets: string[] | null;
  targetZips: string | null;
  minPrice: number | null;
  maxPrice: number | null;
  minBeds: number | null;
  propertyTypePreference: string[] | null;
  buyerType: string | null;
  volumePerYear: number | null;
  notes: string | null;
}

export type IntakeValidation = { ok: true; value: IntakeValue } | { ok: false; error: string };

/**
 * The honeypot: a hidden `website` input both intake forms render. A human
 * never sees it; a form-stuffer fills every field it finds. A non-empty value
 * means the caller is a bot — the route answers 200 and writes NOTHING, so the
 * bot has no signal to adapt to.
 */
export function isHoneypotFilled(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const website = (body as Record<string, unknown>).website;
  return typeof website === "string" && website.trim().length > 0;
}

function optionalString(
  raw: unknown,
  field: string,
  max: number,
): { ok: true; value: string | null } | { ok: false; error: string } {
  if (raw === undefined || raw === null || raw === "") return { ok: true, value: null };
  if (typeof raw !== "string") return { ok: false, error: `${field} must be a string` };
  if (raw.length > max) return { ok: false, error: `${field} exceeds ${max} characters` };
  const trimmed = raw.trim();
  return { ok: true, value: trimmed.length > 0 ? trimmed : null };
}

function optionalNumber(
  raw: unknown,
  field: string,
): { ok: true; value: number | null } | { ok: false; error: string } {
  if (raw === undefined || raw === null || raw === "") return { ok: true, value: null };
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
    return { ok: false, error: `${field} must be a finite number >= 0` };
  }
  return { ok: true, value: raw };
}

function optionalStringArray(
  raw: unknown,
  field: string,
): { ok: true; value: string[] | null } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (!Array.isArray(raw)) return { ok: false, error: `${field} must be an array of strings` };
  if (raw.length > INTAKE_CAPS.arrayItems) {
    return { ok: false, error: `${field} exceeds ${INTAKE_CAPS.arrayItems} items` };
  }
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") return { ok: false, error: `${field} must contain only strings` };
    if (item.length > INTAKE_CAPS.arrayItemChars) {
      return { ok: false, error: `${field} entries exceed ${INTAKE_CAPS.arrayItemChars} characters` };
    }
    const trimmed = item.trim();
    if (trimmed.length > 0) out.push(trimmed);
  }
  return { ok: true, value: out.length > 0 ? out : null };
}

/**
 * Pure. Fails closed: anything that is not a recognized, in-range field value
 * is a 400 with a reason, never a silent coercion — a buyer record built from
 * coerced junk is indistinguishable from a real one later.
 */
export function validateIntakeBody(body: unknown): IntakeValidation {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "body must be a JSON object" };
  }
  const b = body as Record<string, unknown>;

  if (typeof b.name !== "string" || b.name.trim().length === 0) {
    return { ok: false, error: "name is required" };
  }
  if (b.name.length > INTAKE_CAPS.name) {
    return { ok: false, error: `name exceeds ${INTAKE_CAPS.name} characters` };
  }
  if (typeof b.email !== "string" || !/\S+@\S+\.\S+/.test(b.email)) {
    return { ok: false, error: "email is required" };
  }
  if (b.email.length > INTAKE_CAPS.email) {
    return { ok: false, error: `email exceeds ${INTAKE_CAPS.email} characters` };
  }

  const entity = optionalString(b.entity, "entity", INTAKE_CAPS.entity);
  if (!entity.ok) return entity;
  const phone = optionalString(b.phone, "phone", INTAKE_CAPS.phone);
  if (!phone.ok) return phone;
  const targetZips = optionalString(b.targetZips, "targetZips", INTAKE_CAPS.targetZips);
  if (!targetZips.ok) return targetZips;
  const notes = optionalString(b.notes, "notes", INTAKE_CAPS.notes);
  if (!notes.ok) return notes;
  const buyerType = optionalString(b.buyerType, "buyerType", INTAKE_CAPS.buyerType);
  if (!buyerType.ok) return buyerType;

  const markets = optionalStringArray(b.markets, "markets");
  if (!markets.ok) return markets;
  const propertyTypePreference = optionalStringArray(b.propertyTypePreference, "propertyTypePreference");
  if (!propertyTypePreference.ok) return propertyTypePreference;

  const minPrice = optionalNumber(b.minPrice, "minPrice");
  if (!minPrice.ok) return minPrice;
  const maxPrice = optionalNumber(b.maxPrice, "maxPrice");
  if (!maxPrice.ok) return maxPrice;
  const minBeds = optionalNumber(b.minBeds, "minBeds");
  if (!minBeds.ok) return minBeds;
  const volumePerYear = optionalNumber(b.volumePerYear, "volumePerYear");
  if (!volumePerYear.ok) return volumePerYear;

  return {
    ok: true,
    value: {
      name: b.name.trim(),
      email: b.email.trim().toLowerCase(),
      entity: entity.value,
      phone: phone.value,
      markets: markets.value,
      targetZips: targetZips.value,
      minPrice: minPrice.value,
      maxPrice: maxPrice.value,
      minBeds: minBeds.value,
      propertyTypePreference: propertyTypePreference.value,
      buyerType: buyerType.value,
      volumePerYear: volumePerYear.value,
      notes: notes.value,
    },
  };
}
