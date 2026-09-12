// BUYER INTAKE validation tests (2026-09-12). This guards the only
// unauthenticated WRITE path in the app, so the assertions are about what a
// hostile body can get into Airtable, not about happy-path shape.

import { describe, it, expect } from "vitest";
import {
  INTAKE_CAPS,
  INTAKE_MAX_BODY_BYTES,
  isHoneypotFilled,
  validateIntakeBody,
} from "./intake-validate";

const good = {
  name: "Jordan Cash Buyer",
  email: "Jordan@Example.com",
  entity: "Jordan Holdings LLC",
  phone: "(210) 555-0134",
  markets: ["San Antonio", "Birmingham"],
  targetZips: "78210, 35204",
  minPrice: 50_000,
  maxPrice: 200_000,
  minBeds: 3,
  propertyTypePreference: ["Single Family"],
  buyerType: "flipper",
  volumePerYear: 6,
  notes: "Cash, closes in 10 days.",
};

function expectOk(body: unknown) {
  const r = validateIntakeBody(body);
  if (!r.ok) throw new Error(`expected ok, got error: ${r.error}`);
  return r.value;
}

function expectError(body: unknown): string {
  const r = validateIntakeBody(body);
  expect(r.ok).toBe(false);
  return r.ok ? "" : r.error;
}

describe("validateIntakeBody — happy path", () => {
  it("normalizes the email, trims strings, and keeps the numbers", () => {
    const v = expectOk(good);
    expect(v.email).toBe("jordan@example.com");
    expect(v.name).toBe("Jordan Cash Buyer");
    expect(v.markets).toEqual(["San Antonio", "Birmingham"]);
    expect(v.maxPrice).toBe(200_000);
  });

  it("accepts a minimal body and nulls every absent optional field", () => {
    const v = expectOk({ name: "A", email: "a@b.co" });
    expect(v.entity).toBeNull();
    expect(v.phone).toBeNull();
    expect(v.markets).toBeNull();
    expect(v.minPrice).toBeNull();
    expect(v.notes).toBeNull();
  });

  it("treats empty strings and empty arrays as absent, not as values", () => {
    const v = expectOk({ name: "A", email: "a@b.co", entity: "", phone: "   ", markets: [] });
    expect(v.entity).toBeNull();
    expect(v.phone).toBeNull();
    expect(v.markets).toBeNull();
  });
});

describe("validateIntakeBody — required fields", () => {
  it("rejects a missing or blank name and a non-email email", () => {
    expect(expectError({ email: "a@b.co" })).toContain("name");
    expect(expectError({ name: "   ", email: "a@b.co" })).toContain("name");
    expect(expectError({ name: "A" })).toContain("email");
    expect(expectError({ name: "A", email: "not-an-email" })).toContain("email");
    expect(expectError({ name: "A", email: 12 })).toContain("email");
  });

  it("rejects a non-object body", () => {
    expect(expectError(null)).toContain("object");
    expect(expectError("name=A")).toContain("object");
    expect(expectError([{ name: "A", email: "a@b.co" }])).toContain("object");
  });
});

describe("validateIntakeBody — field caps", () => {
  it("rejects an over-long name, entity, phone, targetZips, notes, or email", () => {
    expect(expectError({ ...good, name: "x".repeat(INTAKE_CAPS.name + 1) })).toContain("name");
    expect(expectError({ ...good, entity: "x".repeat(INTAKE_CAPS.entity + 1) })).toContain("entity");
    expect(expectError({ ...good, phone: "9".repeat(INTAKE_CAPS.phone + 1) })).toContain("phone");
    expect(expectError({ ...good, targetZips: "7".repeat(INTAKE_CAPS.targetZips + 1) })).toContain("targetZips");
    expect(expectError({ ...good, notes: "x".repeat(INTAKE_CAPS.notes + 1) })).toContain("notes");
    expect(expectError({ ...good, email: `${"x".repeat(INTAKE_CAPS.email)}@b.co` })).toContain("email");
  });

  it("accepts values exactly at the cap", () => {
    const v = expectOk({ ...good, name: "x".repeat(INTAKE_CAPS.name), notes: "y".repeat(INTAKE_CAPS.notes) });
    expect(v.name.length).toBe(INTAKE_CAPS.name);
    expect(v.notes?.length).toBe(INTAKE_CAPS.notes);
  });

  it("rejects arrays that are too long, hold non-strings, or hold over-long entries", () => {
    expect(expectError({ ...good, markets: Array(INTAKE_CAPS.arrayItems + 1).fill("x") })).toContain("markets");
    expect(expectError({ ...good, markets: ["ok", 7] })).toContain("markets");
    expect(expectError({ ...good, markets: ["x".repeat(INTAKE_CAPS.arrayItemChars + 1)] })).toContain("markets");
    expect(expectError({ ...good, markets: "San Antonio" })).toContain("markets");
    expect(
      expectError({ ...good, propertyTypePreference: Array(INTAKE_CAPS.arrayItems + 1).fill("x") }),
    ).toContain("propertyTypePreference");
  });

  it("rejects numbers that are negative, non-finite, or not numbers at all", () => {
    for (const field of ["minPrice", "maxPrice", "minBeds", "volumePerYear"]) {
      expect(expectError({ ...good, [field]: -1 })).toContain(field);
      expect(expectError({ ...good, [field]: Number.NaN })).toContain(field);
      expect(expectError({ ...good, [field]: Number.POSITIVE_INFINITY })).toContain(field);
      expect(expectError({ ...good, [field]: "150000" })).toContain(field);
    }
  });
});

describe("isHoneypotFilled", () => {
  it("is true only for a non-empty string website field", () => {
    expect(isHoneypotFilled({ ...good, website: "http://spam.example" })).toBe(true);
    expect(isHoneypotFilled({ ...good, website: "   " })).toBe(false);
    expect(isHoneypotFilled({ ...good, website: "" })).toBe(false);
    expect(isHoneypotFilled(good)).toBe(false);
    expect(isHoneypotFilled({ ...good, website: 1 })).toBe(false);
    expect(isHoneypotFilled(null)).toBe(false);
  });

  it("does not let the honeypot field itself become a validation error", () => {
    // The route drops honeypot bodies before validation, but an unknown extra
    // field must never fail a legitimate submission.
    expect(validateIntakeBody({ ...good, website: "" }).ok).toBe(true);
  });
});

describe("INTAKE_MAX_BODY_BYTES", () => {
  it("is 8 KB — the route checks the raw text length before JSON.parse", () => {
    expect(INTAKE_MAX_BODY_BYTES).toBe(8192);
  });
});
