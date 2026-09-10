// M8 / Gate 3 — opt-out detection + number-level suppression tests.

import { describe, it, expect, vi } from "vitest";
import { detectOptOut, applyOptOut, inboundStampAdvances, type OptOutRecord, type ApplyOptOutDeps, suppressionTargetsForPhone } from "./opt-out";

describe("detectOptOut", () => {
  it("catches the operator's explicit set + carrier keywords", () => {
    for (const body of [
      "STOP", "stop", "Stop.", "STOP ALL", "unsubscribe", "Please unsubscribe me",
      "do not text", "do not text me again", "don't text me", "DO NOT CONTACT",
      "remove my number", "please remove this number", "remove me from your list",
      "take me off your list", "opt out", "opted out", "quit", "cancel",
      "stop texting me", "no more texts", "lose my number",
      "not interested, stop", // trailing bare stop → opt-out (TCPA-safe)
    ]) {
      expect(detectOptOut(body).optOut, `expected opt-out: "${body}"`).toBe(true);
    }
  });

  it("does NOT false-positive on benign 'stop' uses or normal replies", () => {
    for (const body of [
      "stop by the house anytime", "there's a bus stop nearby", "non-stop showings",
      "it's a one-stop deal", "the price won't stop me", "yes interested send the offer",
      "seller is looking for $185k", "can you come up?", "what's your offer", "ok",
    ]) {
      expect(detectOptOut(body).optOut, `expected NOT opt-out: "${body}"`).toBe(false);
    }
  });

  it("returns the matched provenance + handles empty", () => {
    expect(detectOptOut("STOP").matched).toBe("exact:STOP");
    expect(detectOptOut("please unsubscribe").matched).toBe("\\bunsubscribe\\b");
    expect(detectOptOut("").optOut).toBe(false);
    expect(detectOptOut(null).optOut).toBe(false);
  });
});

function rec(id: string, doNotText = false): OptOutRecord {
  return { id, doNotText, notes: null, address: `${id} Main St` };
}

describe("applyOptOut — number-level", () => {
  it("flips Do_Not_Text=true on EVERY supplied record (the whole phone group)", async () => {
    const updateListing = vi.fn(async (_id: string, _fields: Record<string, unknown>) => ({}));
    const deps: ApplyOptOutDeps = { updateListing, now: () => new Date("2026-06-18T00:00:00Z") };
    const res = await applyOptOut([rec("recA"), rec("recB"), rec("recC")], "exact:STOP", deps);
    expect(res.flipped).toEqual(["recA", "recB", "recC"]);
    expect(updateListing).toHaveBeenCalledTimes(3);
    // Every call sets Do_Not_Text=true.
    for (const call of updateListing.mock.calls) {
      expect((call[1] as Record<string, unknown>).Do_Not_Text).toBe(true);
    }
  });

  it("is idempotent — already-DNT records are skipped, not re-written", async () => {
    const updateListing = vi.fn(async () => ({}));
    const res = await applyOptOut([rec("recA", true), rec("recB", false)], "bare_stop", { updateListing });
    expect(res.alreadySuppressed).toEqual(["recA"]);
    expect(res.flipped).toEqual(["recB"]);
    expect(updateListing).toHaveBeenCalledTimes(1);
  });

  it("FAIL-CLOSED visibility: a failed write is surfaced, never silently swallowed", async () => {
    const updateListing = vi.fn(async (id: string) => {
      if (id === "recB") throw new Error("airtable 500");
      return {};
    });
    const res = await applyOptOut([rec("recA"), rec("recB"), rec("recC")], "exact:STOP", { updateListing });
    expect(res.flipped).toEqual(["recA", "recC"]);
    expect(res.failed).toEqual([{ id: "recB", error: "airtable 500" }]);
  });
});

// FIX 4b regression (2026-07-27): scan-comms' opt-out branch `continue`d
// before the ordinary Last_Inbound_At stamp, so a genuine STOP reply never
// updated the timeline (recxr0LJiqwYQe8lE, recfnfqn1dw7NeAdR).
// inboundStampAdvances is the forward-only guard the route now applies
// before writing the field from inside that branch.
describe("inboundStampAdvances — Last_Inbound_At forward-only guard", () => {
  it("advances when there is no stored value yet", () => {
    expect(inboundStampAdvances("2026-06-18T00:00:00.000Z", null)).toBe(true);
    expect(inboundStampAdvances("2026-06-18T00:00:00.000Z", undefined)).toBe(true);
  });

  it("advances when the candidate (the STOP reply) is newer than stored", () => {
    expect(inboundStampAdvances("2026-06-18T12:00:00.000Z", "2026-06-18T00:00:00.000Z")).toBe(true);
  });

  it("NEVER-BACKWARD: does not advance when the candidate is older than stored", () => {
    expect(inboundStampAdvances("2026-06-17T00:00:00.000Z", "2026-06-18T00:00:00.000Z")).toBe(false);
  });

  it("does not advance on an exact tie", () => {
    expect(inboundStampAdvances("2026-06-18T00:00:00.000Z", "2026-06-18T00:00:00.000Z")).toBe(false);
  });

  it("fails closed (no write) on an unparseable candidate", () => {
    expect(inboundStampAdvances("not-a-date", "2026-06-18T00:00:00.000Z")).toBe(false);
  });
});

describe("natural-language revocations (2026-09-05, 1212 W Chambers)", () => {
  it("'please don't bother me anymore' is an opt-out", () => {
    expect(detectOptOut("We have an offer right now.Over asking, please don't bother me anymore").optOut).toBe(true);
    expect(detectOptOut("leave me alone").optOut).toBe(true);
    expect(detectOptOut("never text me again").optOut).toBe(true);
  });
  it("a benign 'bother' does not trip it", () => {
    expect(detectOptOut("sorry to bother you, is the offer still good?").optOut).toBe(false);
  });
});

describe("suppressionTargetsForPhone — the Danielle Dale miss (2026-09-09)", () => {
  const toE164 = (p: string) => {
    const d = p.replace(/\D/g, "");
    return d.length === 11 && d.startsWith("1") ? `+${d}` : `+1${d}`;
  };

  // Her two listings. 416 Colburn was in the thread and got suppressed; 3359 N
  // Detroit had a BLANK status, so the actionable-only map never saw it and the
  // send lane attempted her number on every run for six weeks.
  const listings = [
    { id: "colburn", agentPhone: "4193228620", outreachStatus: "Manual Review" },
    { id: "detroit", agentPhone: "(419) 322-8620", outreachStatus: "" },
    { id: "dead", agentPhone: "419-322-8620", outreachStatus: "Dead" },
    { id: "other", agentPhone: "3137023671", outreachStatus: "Texted" },
    { id: "nophone", agentPhone: null, outreachStatus: "Review" },
  ];

  it("reaches the never-contacted sibling that the actionable map missed", () => {
    const ids = suppressionTargetsForPhone(listings, "+14193228620", toE164).map((l) => l.id);
    expect(ids).toContain("detroit");
  });

  it("suppresses EVERY status on the number, not just the engaged ones", () => {
    const ids = suppressionTargetsForPhone(listings, "+14193228620", toE164).map((l) => l.id).sort();
    expect(ids).toEqual(["colburn", "dead", "detroit"]);
  });

  it("matches across formatting differences in the stored phone", () => {
    // Same number stored three ways across the three records above.
    expect(suppressionTargetsForPhone(listings, "+14193228620", toE164)).toHaveLength(3);
  });

  it("never touches a different agent's number", () => {
    const ids = suppressionTargetsForPhone(listings, "+13137023671", toE164).map((l) => l.id);
    expect(ids).toEqual(["other"]);
  });

  it("ignores records with no phone, and an empty target", () => {
    expect(suppressionTargetsForPhone(listings, "+14193228620", toE164).map((l) => l.id)).not.toContain("nophone");
    expect(suppressionTargetsForPhone(listings, "", toE164)).toEqual([]);
    expect(suppressionTargetsForPhone([], "+14193228620", toE164)).toEqual([]);
  });
});
