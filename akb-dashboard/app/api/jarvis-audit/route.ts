// @deprecated Legacy audit endpoint. Maverick's `audit_summary` field
// in the load-state response now provides the same data with richer
// grouping (by_agent + mcp_call_latency + recent_failures). Phase 9
// deprecation tag; URL kept live until consumers migrate.

import { NextResponse } from "next/server";
import { getListings } from "@/lib/airtable";

export const runtime = "nodejs";
export const maxDuration = 300;

const DEAD_OR_WON = new Set(["Dead", "Walked", "Terminated", "No Response", "Won", "Closed"]);
const ACTIVE_NEGOTIATION = new Set(["Negotiating", "Response Received", "Offer Accepted"]);

const RATE_LIMIT_MS = 12_000; // 5/min for Anthropic-bound photo-analysis
const RENTCAST_RATE_LIMIT_MS = 6_000; // 10/min

function originFromReq(req: Request): string {
  const url = new URL(req.url);
  return `${url.protocol}//${url.host}`;
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function POST(req: Request) {
  const url = new URL(req.url);
  const mode = url.searchParams.get("mode") ?? "all"; // "all" | "photo" | "arv" | "screen" | "dd"
  const limit = parseInt(url.searchParams.get("limit") ?? "50", 10);

  // Optional CRON_SECRET gate.
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization") ?? "";
    if (!auth.includes(secret)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const all = await getListings();
  const active = all.filter((l) => !DEAD_OR_WON.has(l.outreachStatus ?? ""));

  const origin = originFromReq(req);
  const cookie = req.headers.get("cookie");

  const photoCandidates = active.filter((l) => !l.photoAnalyzedAt).slice(0, limit);
  const arvCandidates = active.filter((l) => l.estRehabMid != null && !l.arvValidatedAt).slice(0, limit);
  const screenCandidates = active.filter((l) => l.photoAnalyzedAt && !l.preOfferScreenAt).slice(0, limit);
  const ddCandidates = active.filter((l) => ACTIVE_NEGOTIATION.has(l.outreachStatus ?? "")).slice(0, limit);

  const summary = {
    activeRecords: active.length,
    photoRan: 0,
    arvRan: 0,
    screenRan: 0,
    ddChecked: 0,
    blockers: [] as Array<{ recordId: string; address: string; reason: string }>,
    errors: [] as Array<{ recordId: string; phase: string; reason: string }>,
  };

  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;

  if (mode === "all" || mode === "photo") {
    for (const l of photoCandidates) {
      try {
        const res = await fetch(`${origin}/api/photo-analysis/${l.id}`, { headers, cache: "no-store" });
        if (!res.ok) {
          summary.errors.push({ recordId: l.id, phase: "photo", reason: `HTTP ${res.status}` });
        } else {
          summary.photoRan++;
        }
      } catch (err) {
        summary.errors.push({ recordId: l.id, phase: "photo", reason: String(err) });
      }
      await sleep(RATE_LIMIT_MS);
    }
  }

  if (mode === "all" || mode === "arv") {
    for (const l of arvCandidates) {
      try {
        const res = await fetch(`${origin}/api/arv-validate/${l.id}`, { headers, cache: "no-store" });
        if (!res.ok) summary.errors.push({ recordId: l.id, phase: "arv", reason: `HTTP ${res.status}` });
        else summary.arvRan++;
      } catch (err) {
        summary.errors.push({ recordId: l.id, phase: "arv", reason: String(err) });
      }
      await sleep(RENTCAST_RATE_LIMIT_MS);
    }
  }

  if (mode === "all" || mode === "screen") {
    for (const l of screenCandidates) {
      try {
        const res = await fetch(`${origin}/api/pre-offer-screen/${l.id}`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        if (!res.ok) {
          summary.errors.push({ recordId: l.id, phase: "screen", reason: `HTTP ${res.status}` });
        } else {
          summary.screenRan++;
          const data = (await res.json()) as { passed: boolean; blockers?: Array<{ check: string; reason: string }> };
          if (!data.passed) {
            summary.blockers.push({
              recordId: l.id,
              address: l.address,
              reason: (data.blockers ?? []).map((b) => `${b.check}: ${b.reason}`).join(" | "),
            });
          }
        }
      } catch (err) {
        summary.errors.push({ recordId: l.id, phase: "screen", reason: String(err) });
      }
    }
  }

  if (mode === "all" || mode === "dd") {
    for (const l of ddCandidates) {
      try {
        const res = await fetch(`${origin}/api/dd-status/${l.id}`, { headers, cache: "no-store" });
        if (!res.ok) summary.errors.push({ recordId: l.id, phase: "dd", reason: `HTTP ${res.status}` });
        else summary.ddChecked++;
      } catch (err) {
        summary.errors.push({ recordId: l.id, phase: "dd", reason: String(err) });
      }
    }
  }

  return NextResponse.json({
    mode,
    summary,
    photoCandidates: photoCandidates.length,
    arvCandidates: arvCandidates.length,
    screenCandidates: screenCandidates.length,
    ddCandidates: ddCandidates.length,
  });
}
