// Deal Dossier — Section-7 verbatim prior-contact rendering.
// @agent: orchestrator
//
// Operator rule: "Section 7 — Prior Contact History, including the
// verbatim last exchange, never a summary." Also: "Source-record-first
// on every dossier" — every dossier starts with the Airtable recordId
// and the canonical record URL so the operator can jump straight to
// ground truth.
//
// The builder is PURE — given the raw notes (Verification_Notes
// substring) and structured contact events, it produces the markdown.
// I/O — fetching the notes / events — is the caller's job. This keeps
// the prior-contact rendering testable and free of side effects.

export interface ContactEvent {
  /** ISO timestamp (or ISO date) of the event. */
  ts: string;
  /** Outbound, inbound, system. */
  direction: "outbound" | "inbound" | "system";
  /** Channel: SMS / email / phone / system. */
  channel: "sms" | "email" | "phone" | "system";
  /** The VERBATIM body. NEVER summarize. */
  body: string;
  /** Optional Quo / external message id. */
  externalId?: string | null;
  /** Optional offer amount embedded in the message. */
  amountUsd?: number | null;
}

export interface DossierHeader {
  dealNumber: number;
  recordId: string;
  baseId: string;
  tableId: string;
  address: string;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  agentName?: string | null;
  agentPhone?: string | null;
  listPrice?: number | null;
  stickyFloor?: number | null;
}

/** Pure: render the source-record-first header (Fix d). */
export function renderDossierHeader(h: DossierHeader): string {
  const url = `https://airtable.com/${h.baseId}/${h.tableId}/${h.recordId}`;
  const lines = [
    `# Deal Dossier #${String(h.dealNumber).padStart(3, "0")} — ${h.address}`,
    "",
    "## Source Record (canonical)",
    `- **Airtable recordId**: \`${h.recordId}\``,
    `- **Direct link**: ${url}`,
    `- **Address**: ${h.address}${[h.city, h.state, h.zip].filter(Boolean).length > 0 ? `, ${[h.city, h.state, h.zip].filter(Boolean).join(", ")}` : ""}`,
    h.listPrice != null ? `- **List price**: $${h.listPrice.toLocaleString()}` : "- **List price**: unknown",
    h.agentName != null ? `- **Listing agent**: ${h.agentName}${h.agentPhone ? ` (${h.agentPhone})` : ""}` : "",
    h.stickyFloor != null ? `- **Sticky floor**: $${h.stickyFloor.toLocaleString()}` : "",
  ].filter(Boolean);
  return lines.join("\n");
}

/** Pure: render Section 7 — Prior Contact History, with every event's
 *  VERBATIM body. Most-recent first. Returns "no prior contact" cleanly
 *  when the events array is empty. */
export function renderSection7(events: ContactEvent[]): string {
  if (events.length === 0) {
    return "## 7 — Prior Contact History\n\n_no prior contact on record_";
  }
  const sorted = [...events].sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  const lines: string[] = ["## 7 — Prior Contact History"];
  lines.push("");
  lines.push("> Every line below is **verbatim** from the record / Quo / L3. Never summarized.");
  lines.push("");
  for (const e of sorted) {
    const head = `### ${e.ts.slice(0, 19)} — ${e.direction.toUpperCase()} (${e.channel})${e.externalId ? ` — \`${e.externalId}\`` : ""}${e.amountUsd != null ? ` — **$${e.amountUsd.toLocaleString()}**` : ""}`;
    lines.push(head);
    // Quote the body verbatim, line by line — preserve newlines.
    const quoted = e.body.split("\n").map((l) => `> ${l}`).join("\n");
    lines.push(quoted);
    lines.push("");
  }
  return lines.join("\n");
}

// ── Verbatim event extraction from a Verification_Notes blob ─────────
// The notes blob is our durable, append-only contact ledger. Each event
// is a recognizable pattern; we extract them ALL with bodies intact.
// PURE — given a notes string, return events. Never modifies, never
// summarizes. Tests pin the patterns against the live fixtures.

// Groups: [1]=ts, [2]=id, [3]=body
const QUO_SEND_RE = /\[H2 sent ([0-9T:.Z\-]+)\] Quo msg (\S+):\s*([\s\S]*?)(?=\n\n|$)/g;
// Groups: [1]=ts (M/D), [2]=body
const QUO_OPERATOR_RE = /(\d{1,2}\/\d{1,2})\s+—\s+Automated text sent via Quo to[^\n]*((?:[^\n]*Cash offer at \$[0-9,]+[^\n]*)?)/g;
// Groups: [1]=date (M/D), [2]=body
const L3_INBOUND_RE = /(\d{1,2}\/\d{1,2})\s+—\s+L3(?:\s+INBOUND)?:\s*UNCLASSIFIED\.\s*Body:\s*([\s\S]*?)(?=\n\n|\n\[|\n\d{1,2}\/\d{1,2}\s+—|$)/g;

function parseAmount(body: string): number | null {
  // Suffix-aware: $70k → 70_000, $1.2M → 1_200_000, $52,000 → 52_000.
  const kSuffix = body.match(/\$\s?(\d+(?:\.\d+)?)\s?([kKmM])\b/);
  if (kSuffix) {
    const n = parseFloat(kSuffix[1]) * (kSuffix[2].toLowerCase() === "k" ? 1_000 : 1_000_000);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  const plain = body.match(/\$\s?([\d,]+(?:\.\d+)?)/);
  if (!plain) return null;
  const n = parseFloat(plain[1].replace(/,/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Pure: extract all contact events from a Verification_Notes blob.
 *  The output preserves bodies verbatim — the very point of Section 7. */
export function extractContactEvents(
  notes: string | null | undefined,
  opts: { fallbackYear?: number } = {},
): ContactEvent[] {
  if (!notes) return [];
  const year = opts.fallbackYear ?? new Date().getUTCFullYear();
  const events: ContactEvent[] = [];

  // [H2 sent ...] Quo blocks — outbound, verbatim body after the colon.
  {
    const re = new RegExp(QUO_SEND_RE.source, QUO_SEND_RE.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(notes)) != null) {
      const body = (m[3] ?? "").trim();
      events.push({
        ts: m[1] ?? "",
        direction: "outbound",
        channel: "sms",
        body,
        externalId: m[2] ?? null,
        amountUsd: parseAmount(body),
      });
    }
  }

  // "5/19 — Automated text sent via Quo to ..." legacy operator-marker shape.
  {
    const re = new RegExp(QUO_OPERATOR_RE.source, QUO_OPERATOR_RE.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(notes)) != null) {
      const [mo, da] = (m[1] ?? "").split("/");
      const iso = mo && da ? `${year}-${mo.padStart(2, "0")}-${da.padStart(2, "0")}T00:00:00Z` : "";
      const body = (m[0] ?? "").trim();
      events.push({
        ts: iso,
        direction: "outbound",
        channel: "sms",
        body,
        externalId: null,
        amountUsd: parseAmount(body),
      });
    }
  }

  // L3 inbound / unclassified replies — VERBATIM, never summarized.
  {
    const re = new RegExp(L3_INBOUND_RE.source, L3_INBOUND_RE.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(notes)) != null) {
      const [mo, da] = (m[1] ?? "").split("/");
      const iso = mo && da ? `${year}-${mo.padStart(2, "0")}-${da.padStart(2, "0")}T00:00:00Z` : "";
      const body = (m[2] ?? "").trim();
      events.push({
        ts: iso,
        direction: "inbound",
        channel: "sms",
        body,
        externalId: null,
        amountUsd: parseAmount(body),
      });
    }
  }

  return events;
}
