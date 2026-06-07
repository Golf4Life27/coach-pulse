// @agent: orchestrator — dossier renderer + verbatim-event extractor tests.
import { describe, it, expect } from "vitest";
import { renderDossierHeader, renderSection7, extractContactEvents } from "./dossier";

describe("renderDossierHeader — source-record-first (Fix d)", () => {
  it("emits the canonical recordId + Airtable URL at the top", () => {
    const md = renderDossierHeader({
      dealNumber: 2,
      recordId: "recO7XFKcUVTTxMcB",
      baseId: "appp8inLAGTg4qpEZ",
      tableId: "tbldMjKBgPiq45Jjs",
      address: "12724 Strathmoor St",
      city: "Detroit",
      state: "MI",
      zip: "48227",
      agentName: "Ali Fawaz",
      agentPhone: "313-932-7272",
      listPrice: 79900,
      stickyFloor: 52000,
    });
    expect(md).toContain("# Deal Dossier #002 — 12724 Strathmoor St");
    expect(md).toContain("`recO7XFKcUVTTxMcB`");
    expect(md).toContain("https://airtable.com/appp8inLAGTg4qpEZ/tbldMjKBgPiq45Jjs/recO7XFKcUVTTxMcB");
    expect(md).toContain("Sticky floor**: $52,000");
    expect(md).toContain("Ali Fawaz");
  });
});

describe("renderSection7 — verbatim, most-recent first (Fix a)", () => {
  it("renders an empty 'no prior contact' when no events", () => {
    expect(renderSection7([])).toContain("no prior contact on record");
  });

  it("preserves the body verbatim — never a summary", () => {
    const md = renderSection7([
      {
        ts: "2026-05-06T18:52:08.444Z",
        direction: "inbound",
        channel: "sms",
        body: "Hi Alex thanks for the text it's a bit low it's only been on the market for a few days. I can make $70k work for you tho I'm sure",
        amountUsd: 70_000,
      },
      {
        ts: "2026-05-06T17:30:00.000Z",
        direction: "outbound",
        channel: "sms",
        body: "Sent initial offer to Ali Fawaz at +13139327272. Offer: $52,000.",
        amountUsd: 52_000,
      },
    ]);
    // Most-recent FIRST (the inbound at 18:52).
    expect(md.indexOf("$70k work for you")).toBeLessThan(md.indexOf("Sent initial offer"));
    expect(md).toContain("> Hi Alex thanks for the text");
    expect(md).toContain("**$70,000**");
    expect(md).toContain("**$52,000**");
    // No summarization — body unchanged.
    expect(md).toContain("it's only been on the market for a few days");
  });
});

describe("extractContactEvents — verbatim from notes blob", () => {
  it("parses the 12724 Strathmoor live notes (5/6 outbound $52k + 5/6 L3 reply $70k)", () => {
    const notes = `5/6/26 — [Verify] Verified active. Score 0. No keyword matches.

5/6/26 — [Outreach] Sent initial offer to Ali Fawaz at +13139327272. Offer: $52,000.

5/6 — L3: UNCLASSIFIED. Body: Hi Alex thanks for the text it's a bit low it's only been on the market for a few days. I can make $70k work for you tho I'm sure
[MAO_V2.1 status=hold your_mao=- investor_mao=- cap=- rent=1500 taxes=240 @2026-06-05]

2026-06-05 — STALE-TRIAGE HOLD: responded then went cold`;
    const events = extractContactEvents(notes, { fallbackYear: 2026 });
    const inbound = events.find((e) => e.direction === "inbound");
    expect(inbound).toBeTruthy();
    // VERBATIM — the body includes the full sentence including "$70k".
    expect(inbound!.body).toContain("$70k work for you");
    expect(inbound!.amountUsd).toBe(70_000);
  });

  it("parses the H2-sent block (15875 Strathmoor 5/2 outbound)", () => {
    const notes = `Redfin property page returned schema.org InStock and no restriction keywords were detected.

5/2 — H2 trigger reset.

5/2 — Automated text sent via Quo to Charles Campbell. Cash offer at $51,250. Waiting for response.`;
    const events = extractContactEvents(notes, { fallbackYear: 2026 });
    const out = events.find((e) => e.direction === "outbound" && e.body.includes("$51,250"));
    expect(out).toBeTruthy();
    expect(out!.amountUsd).toBe(51_250);
  });

  it("handles a [H2 sent <iso>] Quo msg block", () => {
    const notes = `[H2 sent 2026-06-05T15:30:26.716Z] Quo msg AC97917382: Hi Bridget, this is Alex with AKB Solutions. I would like to make a cash offer at $52,000 with a quick close.

6/5 — L3: UNCLASSIFIED. Body: Can you please send to this number +1 (901) 500-7358`;
    const events = extractContactEvents(notes, { fallbackYear: 2026 });
    const out = events.find((e) => e.externalId === "AC97917382");
    expect(out).toBeTruthy();
    expect(out!.body).toContain("$52,000");
    expect(out!.amountUsd).toBe(52_000);
    const inb = events.find((e) => e.direction === "inbound");
    expect(inb!.body).toContain("901) 500-7358");
  });

  it("empty/null notes → empty events list", () => {
    expect(extractContactEvents(null)).toEqual([]);
    expect(extractContactEvents("")).toEqual([]);
  });
});
