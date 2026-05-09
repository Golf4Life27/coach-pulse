import { NextResponse } from "next/server";
import { getListings } from "@/lib/airtable";
import { getMessagesForParticipant } from "@/lib/quo";
import { mergeTimeline } from "@/lib/timeline-merge";
import type { Listing } from "@/lib/types";
import type { TimelineEntry } from "@/types/jarvis";

export const runtime = "nodejs";
export const maxDuration = 60;

const AIRTABLE_PAT = process.env.AIRTABLE_PAT!;
const BASE_ID = process.env.AIRTABLE_BASE_ID || "appp8inLAGTg4qpEZ";

function cleanPhone(phone: string): string {
  const digits = phone.replace(/[^0-9]/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return digits ? `+${digits}` : "";
}

interface AmbiguousReport {
  agentPhone: string;
  agentName: string;
  recordIds: string[];
  ambiguousMessageCount: number;
  samples: Array<{
    timestamp: string;
    body: string;
    bestMatchRecordId: string;
    bestMatchConfidence: number;
  }>;
}

async function writeToDisambiguationQueue(reports: AmbiguousReport[]): Promise<{ written: number; tableId: string | null; error?: string }> {
  const tableId = process.env.DISAMBIGUATION_QUEUE_TABLE_ID ?? null;
  if (!tableId) return { written: 0, tableId: null };
  if (reports.length === 0) return { written: 0, tableId };

  const records = reports.flatMap((r) =>
    r.samples.map((s) => ({
      fields: {
        Agent_Phone: r.agentPhone,
        Agent_Name: r.agentName,
        Candidate_Record_Ids: r.recordIds.join(", "),
        Best_Match_Record_Id: s.bestMatchRecordId,
        Best_Match_Confidence: s.bestMatchConfidence,
        Message_Body: s.body.slice(0, 4000),
        Message_Timestamp: s.timestamp,
        Detected_At: new Date().toISOString(),
        Status: "Pending",
      },
    })),
  );

  // Airtable accepts up to 10 records per request.
  let written = 0;
  for (let i = 0; i < records.length; i += 10) {
    const batch = records.slice(i, i + 10);
    try {
      const res = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${tableId}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${AIRTABLE_PAT}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ records: batch, typecast: true }),
      });
      if (!res.ok) {
        return { written, tableId, error: `Airtable ${res.status}: ${await res.text().catch(() => "")}` };
      }
      written += batch.length;
    } catch (err) {
      return { written, tableId, error: String(err) };
    }
  }
  return { written, tableId };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const writeQueue = url.searchParams.get("writeQueue") === "1";

  try {
    const all = await getListings();

    // Group active listings by normalized agent phone.
    const groups = new Map<string, Listing[]>();
    for (const l of all) {
      if (!l.agentPhone) continue;
      const key = cleanPhone(l.agentPhone);
      if (!key) continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(l);
    }

    const multiListingGroups = Array.from(groups.entries()).filter(([, ls]) => ls.length >= 2);

    const reports: AmbiguousReport[] = [];

    for (const [phone, listings] of multiListingGroups) {
      let quoMessages: Awaited<ReturnType<typeof getMessagesForParticipant>> = [];
      if (process.env.QUO_API_KEY) {
        try {
          quoMessages = await getMessagesForParticipant(phone, 60 * 24 * 90);
        } catch (err) {
          console.error(`[multi-listing-detect] Quo fetch failed for ${phone}:`, err);
        }
      }
      if (quoMessages.length === 0) continue;

      // For each listing in the group, treat it as the target and merge against its siblings.
      // Collect ambiguous messages across the group; dedupe by message id.
      const samples = new Map<string, TimelineEntry & { bestMatchRecordId: string; bestMatchConfidence: number }>();

      for (const target of listings) {
        const siblings = listings
          .filter((s) => s.id !== target.id)
          .map((s) => ({ recordId: s.id, address: s.address, listPrice: s.listPrice }));

        const { ambiguous } = mergeTimeline(quoMessages, [], [], {
          recordId: target.id,
          targetAddress: target.address,
          targetPrice: target.listPrice,
          agentName: target.agentName,
          siblings,
        });

        for (const entry of ambiguous) {
          const raw = entry.raw as { id?: string } | undefined;
          const key = raw?.id ?? `${entry.timestamp}-${entry.body.slice(0, 32)}`;
          if (samples.has(key)) continue;
          samples.set(key, {
            ...entry,
            bestMatchRecordId: entry.propertyMatch.recordId || target.id,
            bestMatchConfidence: entry.propertyMatch.confidence,
          });
        }
      }

      if (samples.size > 0) {
        reports.push({
          agentPhone: phone,
          agentName: listings[0].agentName ?? "Agent",
          recordIds: listings.map((l) => l.id),
          ambiguousMessageCount: samples.size,
          samples: Array.from(samples.values())
            .slice(0, 25)
            .map((s) => ({
              timestamp: s.timestamp,
              body: s.body,
              bestMatchRecordId: s.bestMatchRecordId,
              bestMatchConfidence: Number(s.bestMatchConfidence.toFixed(2)),
            })),
        });
      }
    }

    const queueWrite = writeQueue ? await writeToDisambiguationQueue(reports) : { written: 0, tableId: null as string | null };

    return NextResponse.json({
      generated_at: new Date().toISOString(),
      multiListingAgents: multiListingGroups.length,
      ambiguousReports: reports,
      disambiguationQueue: queueWrite,
    });
  } catch (err) {
    console.error("[multi-listing-detect] error:", err);
    return NextResponse.json(
      { error: "Failed to detect", detail: String(err) },
      { status: 500 },
    );
  }
}
