import { describe, it, expect } from "vitest";
import {
  SCOPE_PSF,
  DEFAULT_UNKNOWN_SCOPE,
  rehabForScope,
  scopeForRehab,
  scopedOpeners,
  openerAtScope,
  pessimisticOpener,
  lighterTierFor,
  scopeQuestion,
} from "./rehab-scope";

describe("the tiers", () => {
  it("holds the operator's numbers", () => {
    expect(SCOPE_PSF.light).toBe(15);
    expect(SCOPE_PSF.medium).toBe(30);
    expect(SCOPE_PSF.heavy).toBe(45);
  });

  it("assumes HEAVY when nobody has been inside", () => {
    // INVARIANTS §2 — an unknown interior prices pessimistically. Better
    // information may only raise the number, never lower it after the fact.
    expect(DEFAULT_UNKNOWN_SCOPE).toBe("heavy");
  });

  it("calibrates against a real vision read", () => {
    // 8235 Prest St: $23,970 vision rehab on 940 sqft = $25.50/sqft, which the
    // operator independently called "light/medium". Nearest tier is medium.
    expect(scopeForRehab(23_970, 940)).toBe("medium");
    expect(rehabForScope(940, "light")).toBe(14_100);
    expect(rehabForScope(940, "medium")).toBe(28_200);
    expect(rehabForScope(940, "heavy")).toBe(42_300);
  });

  it("refuses to estimate a scope without sqft", () => {
    // Inventing a rehab for a house of unknown size is the exact failure this
    // replaces.
    expect(rehabForScope(null, "heavy")).toBeNull();
    expect(rehabForScope(0, "heavy")).toBeNull();
    expect(scopeForRehab(20_000, null)).toBeNull();
  });
});

// 8235 Prest St, the record the operator asked about: 940 sqft, ARV $86,480
// from a STRONG 24-comp seed, Detroit buy-box 0.6461, $5,000 fee.
const prest = { sqft: 940, arv: 86_480, arvPctMax: 0.6461, fee: 5_000, anchor: 0.9 };

describe("scopedOpeners — the offer follows the scope", () => {
  it("prices all three tiers off the property, never off list", () => {
    const o = scopedOpeners(prest);
    expect(o.map((x) => x.scope)).toEqual(["light", "medium", "heavy"]);
    // 0.6461 × 86,480 = 55,874.73. − rehab − 5,000 fee.
    expect(openerAtScope(o, "light")!.rehab).toBe(14_100);
    expect(openerAtScope(o, "light")!.mao).toBe(36_775);
    expect(openerAtScope(o, "medium")!.mao).toBe(22_675);
    expect(openerAtScope(o, "heavy")!.mao).toBe(8_575);
  });

  it("a heavier scope always produces a LOWER offer", () => {
    const o = scopedOpeners(prest);
    const light = openerAtScope(o, "light")!.opener!;
    const medium = openerAtScope(o, "medium")!.opener!;
    const heavy = openerAtScope(o, "heavy")!.opener!;
    expect(light).toBeGreaterThan(medium);
    expect(medium).toBeGreaterThan(heavy);
  });

  it("returns a null opener for a scope the house cannot carry", () => {
    // A small ARV against a heavy gut: the MAO goes non-positive and there is
    // no offer to make at that scope. That is an answer, not an error.
    const o = scopedOpeners({ sqft: 1_500, arv: 60_000, arvPctMax: 0.6461, fee: 5_000, anchor: 0.9 });
    expect(openerAtScope(o, "heavy")!.opener).toBeNull();
    expect(openerAtScope(o, "heavy")!.mao).toBeLessThan(0);
  });

  it("returns nothing rather than guessing when an input is missing", () => {
    expect(scopedOpeners({ ...prest, sqft: null })).toEqual([]);
    expect(scopedOpeners({ ...prest, arv: null })).toEqual([]);
    expect(scopedOpeners({ ...prest, arvPctMax: null })).toEqual([]);
    expect(scopedOpeners({ ...prest, anchor: null })).toEqual([]);
  });
});

describe("pessimisticOpener — we say the conservative number", () => {
  it("leads with heavy when heavy pencils", () => {
    expect(pessimisticOpener(scopedOpeners(prest))!.scope).toBe("heavy");
  });

  it("falls back only when a heavier scope does not pencil at all", () => {
    // "No offer" is not a conversation. If a full gut leaves nothing, the
    // next-heaviest scope that DOES pencil is what we open with.
    const o = scopedOpeners({ sqft: 1_500, arv: 60_000, arvPctMax: 0.6461, fee: 5_000, anchor: 0.9 });
    const p = pessimisticOpener(o);
    expect(p).not.toBeNull();
    expect(p!.scope).not.toBe("heavy");
  });

  it("returns null when nothing pencils at any scope", () => {
    expect(pessimisticOpener(scopedOpeners({ sqft: 2_000, arv: 30_000, arvPctMax: 0.6461, fee: 5_000, anchor: 0.9 }))).toBeNull();
  });
});

describe("scopeQuestion — turn the unknown into a question the agent can answer", () => {
  const o = scopedOpeners(prest);
  const p = pessimisticOpener(o)!;

  it("names the assumption and what a lighter scope would support", () => {
    const q = scopeQuestion({ pessimistic: p, lighter: lighterTierFor(o, p) });
    expect(q).toContain("heavy scope");
    expect(q).toContain("full gut");
    expect(q).toMatch(/I can go to \$\d/);
    expect(q).toContain("Which is it?");
  });

  it("describes the scope in words someone standing in the house can answer", () => {
    // The whole point: the agent has BEEN INSIDE. If the label isn't
    // answerable from memory of the walkthrough, the question is useless.
    const q = scopeQuestion({ pessimistic: p, lighter: lighterTierFor(o, p) });
    expect(q).toMatch(/roof|mechanicals|kitchen|paint|carpet/i);
  });

  it("still invites a correction when there is no better tier to name", () => {
    const q = scopeQuestion({ pessimistic: p, lighter: null });
    expect(q).toContain("tell me what it needs");
    expect(q).not.toMatch(/I can go to/);
  });

  it("never promises a number above the pessimistic one without the condition", () => {
    // The higher figure is contingent on their answer. It must always arrive
    // attached to the scope that would justify it.
    const q = scopeQuestion({ pessimistic: p, lighter: lighterTierFor(o, p) });
    const idx = q.indexOf("I can go to");
    expect(idx).toBeGreaterThan(-1);
    expect(q.slice(0, idx)).toMatch(/If it's really (light|medium)/);
  });
});

describe("lighterTierFor", () => {
  it("offers exactly one step up", () => {
    const o = scopedOpeners(prest);
    expect(lighterTierFor(o, openerAtScope(o, "heavy")!)!.scope).toBe("medium");
    expect(lighterTierFor(o, openerAtScope(o, "medium")!)!.scope).toBe("light");
  });

  it("has nothing above light", () => {
    const o = scopedOpeners(prest);
    expect(lighterTierFor(o, openerAtScope(o, "light")!)).toBeNull();
  });
});
