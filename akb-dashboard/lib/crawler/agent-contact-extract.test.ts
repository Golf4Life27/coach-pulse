import { describe, it, expect } from "vitest";
import { extractAgentContact, phonesAgree } from "./agent-contact-extract";

const ZILLOW_HTML =
  `<script id="__NEXT_DATA__">{"gdpClientCache":"{\\"attributionInfo\\":{\\"agentName\\":\\"Pamela Calamusa\\",` +
  `\\"agentPhoneNumber\\":\\"(205) 585-0726\\",\\"brokerName\\":\\"Keller Williams Trussville\\",` +
  `\\"brokerPhoneNumber\\":\\"(205) 661-0811\\"}}"}</script>`;

describe("extractAgentContact — the page is the phone source", () => {
  it("reads Zillow's escaped attributionInfo JSON", () => {
    const c = extractAgentContact(ZILLOW_HTML, "irrelevant markdown");
    expect(c).toEqual({
      agentName: "Pamela Calamusa",
      agentPhone: "(205) 585-0726",
      brokerPhone: "(205) 661-0811",
      officeLineSuspected: false,
      source: "zillow_json",
    });
  });

  it("flags an office line when agent and broker numbers are the same digits", () => {
    const html = ZILLOW_HTML.replace("(205) 661-0811", "205-585-0726");
    expect(extractAgentContact(html, null).officeLineSuspected).toBe(true);
  });

  it("reads plain (unescaped) JSON too", () => {
    const html = `{"attributionInfo":{"agentName":"Emi Cross","agentPhoneNumber":"734-740-7389"}}`;
    const c = extractAgentContact(html, null);
    expect(c.agentPhone).toBe("734-740-7389");
    expect(c.brokerPhone).toBeNull();
    expect(c.officeLineSuspected).toBe(false);
  });

  it("falls back to the markdown 'Listed by' block", () => {
    const md = "Price cut\n\nListed by Marlin Winchester • Danberry Realtors • (419) 466-3514\n\nMore text";
    const c = extractAgentContact("<html>no json here</html>", md);
    expect(c.agentPhone).toBe("419-466-3514");
    expect(c.agentName).toBe("Marlin Winchester");
    expect(c.source).toBe("listed_by_text");
  });

  it("returns nothing rather than a guess", () => {
    const c = extractAgentContact("<html></html>", "Listed by Someone with no number at all.");
    expect(c.agentPhone).toBeNull();
    expect(c.source).toBeNull();
    expect(extractAgentContact(null, null).agentPhone).toBeNull();
  });

  it("ignores a Zillow number that is not phone-shaped", () => {
    const html = `{"agentPhoneNumber":"call office"}`;
    expect(extractAgentContact(html, null).source).toBeNull();
  });
});

describe("phonesAgree — the A/B metric", () => {
  it("compares on digits only", () => {
    expect(phonesAgree("(205) 585-0726", "+1 205.585.0726")).toBe(true);
    expect(phonesAgree("(205) 585-0726", "205-585-0727")).toBe(false);
  });
  it("is null when either side is missing", () => {
    expect(phonesAgree(null, "205-585-0726")).toBeNull();
    expect(phonesAgree("205-585-0726", "")).toBeNull();
  });
});
