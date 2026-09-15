// Agent contact off the listing page itself — the RentCast-free phone source.
// @agent: scout
//
// Operator kill test 2026-09-12 (Spine recJKOmUvxQJLWcNA): Zillow prints the
// listing agent's phone on the page; Redfin sometimes; sometimes it is the
// brokerage office line. The sweep already pays ~1 credit to scrape every
// candidate page, and rawHtml is a free extra format on that same call, so
// the phone costs zero additional credits.
//
// PURE. Two readers, first hit wins:
//   1. Zillow embeds attributionInfo in __NEXT_DATA__ as a JSON string, so the
//      keys arrive quote-escaped (\"agentPhoneNumber\":\"(205) 585-0726\").
//   2. Any portal's visible "Listed by ..." block in the markdown, first
//      phone-shaped number within a short window after the phrase.
//
// A brokerage switchboard cannot be texted. When Zillow gives both an agent
// and a broker number and they are the same digits, officeLineSuspected is
// set and the caller must not text it.
// ponytail: no carrier/line-type lookup (every one is a subscription); the
// same-digits heuristic is the ceiling until Quo delivery failures say more.

export interface AgentContact {
  agentName: string | null;
  agentPhone: string | null;
  brokerPhone: string | null;
  officeLineSuspected: boolean;
  source: "zillow_json" | "listed_by_text" | null;
}

const EMPTY: AgentContact = { agentName: null, agentPhone: null, brokerPhone: null, officeLineSuspected: false, source: null };

const US_PHONE_RE = /(?:\+?1[\s.-]?)?\(?\b([2-9]\d{2})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})\b/;

function digits(s: string | null): string {
  const d = (s ?? "").replace(/\D/g, "");
  return d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
}

/** Read one string value out of escaped-or-plain JSON in a blob of HTML. */
function jsonString(html: string, key: string): string | null {
  const m = new RegExp(`\\\\?"${key}\\\\?":\\\\?"([^"\\\\]{1,80})`).exec(html);
  return m?.[1]?.trim() || null;
}

/** Pure: pull the listing agent contact from a scraped page. Never throws. */
export function extractAgentContact(rawHtml: string | null | undefined, markdown: string | null | undefined): AgentContact {
  const html = rawHtml ?? "";
  if (html.includes("agentPhoneNumber")) {
    const agentPhone = jsonString(html, "agentPhoneNumber");
    const brokerPhone = jsonString(html, "brokerPhoneNumber");
    if (agentPhone && US_PHONE_RE.test(agentPhone)) {
      return {
        agentName: jsonString(html, "agentName"),
        agentPhone,
        brokerPhone,
        officeLineSuspected: !!brokerPhone && digits(agentPhone) === digits(brokerPhone),
        source: "zillow_json",
      };
    }
  }

  const md = markdown ?? "";
  const at = md.search(/listed by|listing agent|listing provided by/i);
  if (at >= 0) {
    const window = md.slice(at, at + 400);
    const m = US_PHONE_RE.exec(window);
    if (m) {
      const nameMatch = /(?:listed by|listing agent|listing provided by)[:\s]+([A-Z][A-Za-z.'-]+(?: [A-Z][A-Za-z.'-]+){0,3})/i.exec(window);
      return {
        agentName: nameMatch?.[1]?.trim() ?? null,
        agentPhone: `${m[1]}-${m[2]}-${m[3]}`,
        brokerPhone: null,
        officeLineSuspected: false,
        source: "listed_by_text",
      };
    }
  }
  return EMPTY;
}

/** Pure: do two phone strings carry the same 10 digits? null when either is missing. */
export function phonesAgree(a: string | null | undefined, b: string | null | undefined): boolean | null {
  const da = digits(a ?? null);
  const db = digits(b ?? null);
  if (da.length !== 10 || db.length !== 10) return null;
  return da === db;
}
