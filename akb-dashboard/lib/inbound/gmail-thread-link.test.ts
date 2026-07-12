import { describe, it, expect } from "vitest";
import {
  normalizeSubject,
  extractAddresses,
  messageTouchesAddress,
  parseThreadIds,
  mergeThreadIds,
  selectSweepCohort,
  type CohortCandidate,
} from "./gmail-thread-link";
import { appendGmailMessagesToNotes, newestInboundIso, extractCitedGmailIds } from "./gmail-capture";

const OPERATOR = "alex@akb-properties.com";

describe("normalizeSubject — Re:/Fwd: mutations never break correlation", () => {
  it("strips single and repeated prefixes, any case, any spacing", () => {
    const want = "Cash Offer — 3123 Sunbeam St, Houston TX 77051 — AKB Solutions LLC";
    expect(normalizeSubject(`Re: ${want}`)).toBe(want);
    expect(normalizeSubject(`Fwd: ${want}`)).toBe(want);
    expect(normalizeSubject(`FW:fwd:  RE: ${want}`)).toBe(want);
    expect(normalizeSubject(want)).toBe(want);
  });
  it("the Sunbeam flip: Re:-subject and Fwd:-subject normalize identically", () => {
    expect(normalizeSubject("Re: Cash Offer — 3123 Sunbeam St")).toBe(
      normalizeSubject("Fwd: Cash Offer — 3123 Sunbeam St"),
    );
  });
  it("does not eat non-prefix words starting with re/fw", () => {
    expect(normalizeSubject("Rehab quote for 5 Main")).toBe("Rehab quote for 5 Main");
    expect(normalizeSubject("Forward progress update")).toBe("Forward progress update");
  });
});

describe("messageTouchesAddress — CC-only is still our mail (never To:-only)", () => {
  const sunbeamShape = {
    from: "Dayna Adewuya <dayna@aurelianrealtytx.com>",
    to: "transact.re@gmail.com",
    cc: "ljrealty606@gmail.com, Alex Balog <alex@akb-properties.com>",
  };
  it("matches when the operator is CC-only", () => {
    expect(messageTouchesAddress(sunbeamShape, OPERATOR)).toBe(true);
  });
  it("matches To and From and Bcc too", () => {
    expect(messageTouchesAddress({ to: "a <alex@akb-properties.com>" }, OPERATOR)).toBe(true);
    expect(messageTouchesAddress({ from: OPERATOR }, OPERATOR)).toBe(true);
    expect(messageTouchesAddress({ bcc: OPERATOR }, OPERATOR)).toBe(true);
  });
  it("no address anywhere → no match; case-insensitive when present", () => {
    expect(messageTouchesAddress({ to: "other@x.com", cc: "more@y.com" }, OPERATOR)).toBe(false);
    expect(messageTouchesAddress({ cc: "ALEX@AKB-PROPERTIES.COM" }, OPERATOR)).toBe(true);
  });
  it("extractAddresses tolerates display names and mixed separators", () => {
    expect(extractAddresses("A <a@x.com>; B <b@y.com>, c@z.com")).toEqual(["a@x.com", "b@y.com", "c@z.com"]);
  });
});

describe("thread-link field — persist once, ingest forever", () => {
  it("parse tolerates whitespace/commas and rejects junk", () => {
    expect(parseThreadIds("19d9bb3906ab44db 19f52275f1aca990,19f5359b04419b9e")).toEqual([
      "19d9bb3906ab44db",
      "19f52275f1aca990",
      "19f5359b04419b9e",
    ]);
    expect(parseThreadIds("  ")).toEqual([]);
    expect(parseThreadIds(null)).toEqual([]);
    expect(parseThreadIds("short !!bad!! 19d9bb3906ab44db")).toEqual(["19d9bb3906ab44db"]);
  });
  it("merge adds only new ids, returns null when nothing new (skip the write)", () => {
    expect(mergeThreadIds("19d9bb3906ab44db", ["19d9bb3906ab44db"])).toBeNull();
    expect(mergeThreadIds("19d9bb3906ab44db", ["19f52275f1aca990"])).toBe("19d9bb3906ab44db 19f52275f1aca990");
    expect(mergeThreadIds(null, ["19d9bb3906ab44db", "19d9bb3906ab44db"])).toBe("19d9bb3906ab44db");
    expect(mergeThreadIds("", [])).toBeNull();
  });
});

describe("selectSweepCohort — live money NEVER starves (the actual Sunbeam root cause)", () => {
  const mk = (id: string, status: string, act: string | null, syncable = true): CohortCandidate => ({
    id,
    status,
    syncable,
    lastActivityAt: act,
  });

  it("a Negotiating record is in the cohort even when the population dwarfs the limit", () => {
    const population = [
      // 100 texted records, newest-first activity — they used to crowd out the deal.
      ...Array.from({ length: 100 }, (_, i) =>
        mk(`recTexted${String(i).padStart(3, "0")}`, "Texted", `2026-07-1${i % 2}T0${i % 10}:00:00Z`),
      ),
      mk("recSUNBEAM", "Negotiating", "2026-07-12T04:56:00Z"),
    ];
    for (let hour = 0; hour < 5; hour++) {
      const sel = selectSweepCohort(population, 40, hour);
      expect(sel.cohort.some((c) => c.id === "recSUNBEAM")).toBe(true);
    }
  });

  it("truncation is reported, never silent", () => {
    const sel = selectSweepCohort(
      Array.from({ length: 90 }, (_, i) => mk(`rec${i}`, "Texted", null)),
      40,
      0,
    );
    expect(sel.truncated).toBe(50);
    expect(sel.populationSyncable).toBe(90);
  });

  it("rotation visits every record across consecutive runs (no permanent starvation)", () => {
    const population = Array.from({ length: 90 }, (_, i) => mk(`rec${String(i).padStart(2, "0")}`, "Texted", null));
    const seen = new Set<string>();
    for (let hour = 0; hour < 3; hour++) {
      for (const c of selectSweepCohort(population, 40, hour).cohort) seen.add(c.id);
    }
    expect(seen.size).toBe(90);
  });

  it("unsyncable records (no email, no linked thread) don't consume slots", () => {
    const sel = selectSweepCohort(
      [mk("recA", "Texted", null, false), mk("recB", "Negotiating", null, true)],
      1,
      0,
    );
    expect(sel.cohort.map((c) => c.id)).toEqual(["recB"]);
    expect(sel.populationSyncable).toBe(1);
  });
});

describe("REGRESSION — the exact 3123 Sunbeam missed message shape is ingested", () => {
  // 2026-07-12T13:53:27Z, thread 19d9bb3906ab44db: From the agent, To the
  // transaction coordinator, operator CC-only, subject flipped Re:→Fwd:.
  const missedMessage = {
    id: "19f569aee544ad68",
    threadId: "19d9bb3906ab44db",
    from: "Dayna Adewuya <dayna@aurelianrealtytx.com>",
    to: "transact.re@gmail.com",
    cc: "ljrealty606@gmail.com, alex@akb-properties.com",
    subject: "Fwd: Cash Offer — 3123 Sunbeam St, Houston TX 77051 — AKB Solutions LLC",
    body:
      "The contract you sent is on an old TREC form. I have created a new contract in my compliance file for you to review and sign. We will also need proof of funds. LET'S GET THIS DONE!",
    date: "2026-07-12T13:53:27.000Z",
  };

  it("appender ingests it (from ≠ ours), stamps the thread id, and is idempotent", () => {
    const existing = "[H2 email sent 2026-07-12T04:56:00Z] Gmail msg abc: executed TREC";
    const r1 = appendGmailMessagesToNotes(existing, [missedMessage], OPERATOR);
    expect(r1.newEvents).toHaveLength(1);
    expect(r1.newEvents[0].threadId).toBe("19d9bb3906ab44db");
    expect(r1.notes).toContain("EMAIL INBOUND");
    expect(r1.notes).toContain("proof of funds");
    expect(r1.notes).toContain(`[Gmail inbound msg ${missedMessage.id} thread=19d9bb3906ab44db ts=2026-07-12T13:53:27.000Z`);
    // idempotent by message id — second sweep adds nothing
    const r2 = appendGmailMessagesToNotes(r1.notes, [missedMessage], OPERATOR);
    expect(r2.newEvents).toHaveLength(0);
    expect(r2.skippedAlreadyPresent).toEqual([missedMessage.id]);
    // cited-id extraction still parses the thread-tagged marker
    expect(extractCitedGmailIds(r1.notes).has(missedMessage.id)).toBe(true);
  });

  it("its thread id persists to the listing link field for future direct fetches", () => {
    const r = appendGmailMessagesToNotes(null, [missedMessage], OPERATOR);
    const merged = mergeThreadIds(null, r.newEvents.map((e) => e.threadId ?? ""));
    expect(merged).toBe("19d9bb3906ab44db");
  });

  it("newestInboundIso surfaces 13:53:27Z for the Last_Inbound_At stamp", () => {
    const r = appendGmailMessagesToNotes(null, [missedMessage], OPERATOR);
    expect(newestInboundIso(r.newEvents)).toBe("2026-07-12T13:53:27.000Z");
  });

  it("the operator is reachable on the message via CC (the recipient-fallback path)", () => {
    expect(messageTouchesAddress(missedMessage, OPERATOR)).toBe(true);
  });
});
