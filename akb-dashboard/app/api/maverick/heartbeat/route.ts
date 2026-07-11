// Mission Control heartbeat — the dashboard belt's data feed.
// @agent: maverick
//
// GET → daily throughput (crawled/accepted/sent/replies, today vs yesterday),
// cron freshness (last intake / last send), next send slot, and the live
// event tape. Read-only, same trust boundary as /api/morning-briefing.
// Three filtered Airtable reads (48h windows, minimal fields) — no KV, no
// paid APIs, safe to poll from the dashboard.

import { NextResponse } from "next/server";
import {
  countLiveNegotiations,
  bucketByDay,
  buildTape,
  cronFreshness,
  nextSendSlotIso,
} from "@/lib/maverick/heartbeat";

export const runtime = "nodejs";
export const maxDuration = 30;

const AIRTABLE_PAT = process.env.AIRTABLE_PAT!;
const BASE_ID = process.env.AIRTABLE_BASE_ID || "appp8inLAGTg4qpEZ";
const LISTINGS_TABLE = "tbldMjKBgPiq45Jjs";

interface RawRecord {
  id: string;
  createdTime: string;
  fields: Record<string, unknown>;
}

async function fetchFiltered(formula: string, fields: string[]): Promise<RawRecord[]> {
  const out: RawRecord[] = [];
  let offset: string | undefined;
  do {
    const p = new URLSearchParams();
    p.set("filterByFormula", formula);
    for (const f of fields) p.append("fields[]", f);
    p.set("pageSize", "100");
    if (offset) p.set("offset", offset);
    const res = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${LISTINGS_TABLE}?${p.toString()}`, {
      headers: { Authorization: `Bearer ${AIRTABLE_PAT}` },
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`Airtable ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    out.push(...(data.records as RawRecord[]));
    offset = data.offset;
  } while (offset && out.length < 500);
  return out;
}

/** Midnight in America/Chicago for `daysAgo`, as an ISO instant. */
function chicagoMidnightIso(now: Date, daysAgo: number): string {
  const chicago = new Date(now.toLocaleString("en-US", { timeZone: "America/Chicago" }));
  const offsetMs = now.getTime() - chicago.getTime();
  const mid = new Date(chicago.getFullYear(), chicago.getMonth(), chicago.getDate() - daysAgo, 0, 0, 0);
  return new Date(mid.getTime() + offsetMs).toISOString();
}

export async function GET() {
  const now = new Date();
  const nowIso = now.toISOString();
  const todayStart = chicagoMidnightIso(now, 0);
  const yesterdayStart = chicagoMidnightIso(now, 1);
  const chicagoNow = new Date(now.toLocaleString("en-US", { timeZone: "America/Chicago" }));
  const monthOffsetMs = now.getTime() - chicagoNow.getTime();
  const monthStart = new Date(
    new Date(chicagoNow.getFullYear(), chicagoNow.getMonth(), 1, 0, 0, 0).getTime() + monthOffsetMs,
  ).toISOString();

  try {
    const [crawled, outbound, inbound, monthInbound] = await Promise.all([
      fetchFiltered(`IS_AFTER(CREATED_TIME(), '${yesterdayStart}')`, ["Execution_Path"]),
      fetchFiltered(`IS_AFTER({Last_Outbound_At}, '${yesterdayStart}')`, [
        "Address",
        "Last_Outbound_At",
        "Outreach_Offer_Price",
        "Outreach_Status",
      ]),
      fetchFiltered(`IS_AFTER({Last_Inbound_At}, '${yesterdayStart}')`, ["Address", "Last_Inbound_At"]),
      fetchFiltered(`IS_AFTER({Last_Inbound_At}, '${monthStart}')`, ["Last_Inbound_At", "Outreach_Status"]),
    ]);

    const path = (r: RawRecord) => {
      const v = r.fields["Execution_Path"];
      return typeof v === "string" ? v : ((v as { name?: string })?.name ?? "");
    };
    const crawledRows = crawled.map((r) => ({ ts: r.createdTime }));
    const acceptedRows = crawled.filter((r) => path(r) === "Auto Proceed").map((r) => ({ ts: r.createdTime }));
    const sentRows = outbound.map((r) => ({ ts: String(r.fields["Last_Outbound_At"] ?? r.createdTime) }));
    const replyRows = inbound.map((r) => ({ ts: String(r.fields["Last_Inbound_At"] ?? r.createdTime) }));

    const lastIntakeAt = crawled.reduce<string | null>(
      (acc, r) => (!acc || r.createdTime > acc ? r.createdTime : acc),
      null,
    );
    const lastSendAt = sentRows.reduce<string | null>((acc, r) => (!acc || r.ts > acc ? r.ts : acc), null);

    const tape = buildTape({
      outbound: outbound.map((r) => ({
        ts: String(r.fields["Last_Outbound_At"] ?? r.createdTime),
        address: (r.fields["Address"] as string) ?? null,
        offer: typeof r.fields["Outreach_Offer_Price"] === "number" ? (r.fields["Outreach_Offer_Price"] as number) : null,
        status:
          typeof r.fields["Outreach_Status"] === "string"
            ? (r.fields["Outreach_Status"] as string)
            : ((r.fields["Outreach_Status"] as { name?: string })?.name ?? null),
      })),
      inbound: inbound.map((r) => ({
        ts: String(r.fields["Last_Inbound_At"] ?? r.createdTime),
        address: (r.fields["Address"] as string) ?? null,
      })),
    });

    return NextResponse.json({
      generated_at: nowIso,
      day_start: todayStart,
      stations: {
        crawled: bucketByDay(crawledRows, todayStart, yesterdayStart),
        accepted: bucketByDay(acceptedRows, todayStart, yesterdayStart),
        sent: bucketByDay(sentRows, todayStart, yesterdayStart),
        replies: bucketByDay(replyRows, todayStart, yesterdayStart),
      },
      north_star: {
        live_negotiations_this_month: countLiveNegotiations(
          monthInbound.map((r) => ({
            lastInboundAt: (r.fields["Last_Inbound_At"] as string) ?? null,
            status:
              typeof r.fields["Outreach_Status"] === "string"
                ? (r.fields["Outreach_Status"] as string)
                : ((r.fields["Outreach_Status"] as { name?: string })?.name ?? null),
          })),
          monthStart,
        ),
        month_start: monthStart,
      },
      heartbeats: {
        intake: { last: lastIntakeAt, freshness: cronFreshness(lastIntakeAt, nowIso) },
        send: { last: lastSendAt, freshness: cronFreshness(lastSendAt, nowIso) },
        next_send_slot: nextSendSlotIso(nowIso),
      },
      tape,
    });
  } catch (err) {
    console.error("[heartbeat] error:", err);
    return NextResponse.json({ error: "heartbeat_failed", detail: String(err).slice(0, 200) }, { status: 500 });
  }
}
