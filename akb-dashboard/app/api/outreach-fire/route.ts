import { getListings, updateListingRecord } from "@/lib/airtable";
import { sendMessage } from "@/lib/quo";

export const runtime = "nodejs";
export const maxDuration = 60;

// Field IDs
const F = {
  outreachStatus: "fldGIgqwyCJg4uFyv",
  lastOutboundAt: "fldaK4lR5UNvycg11",
  lastOutreachDate: "fldbRrOW3IEoLtnFE",
  notes: "fldwKGxZly6O8qyPu",
};

function toE164(phone: string): string {
  const digits = phone.replace(/[^0-9]/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return `+${digits}`;
}

function roundToNearest250(n: number): number {
  return Math.ceil(n / 250) * 250;
}

function formatOffer(listPrice: number): string {
  const offer = roundToNearest250(listPrice * 0.65);
  return "$" + offer.toLocaleString("en-US");
}

function buildOutreachText(
  agentName: string,
  address: string,
  offer: string
): string {
  const firstName = agentName.split(" ")[0] || "there";
  return `Hi ${firstName}, this is Alex with AKB Solutions LLC. I'm an investor interested in your listing at ${address}. I'd like to submit a cash offer of ${offer} with a quick close and no financing contingency. We may close under one of our affiliated entities depending on which one we're funding through — just want to make sure that won't be an issue. Is the seller open to cash offers? Happy to send proof of funds. Thanks!`;
}

function appendNote(existing: string | null, newNote: string): string {
  const today = new Date().toLocaleDateString("en-US", {
    month: "numeric", day: "numeric", year: "2-digit",
  });
  const stamped = `${today} — [Outreach] ${newNote}`;
  return existing ? `${existing}\n\n${stamped}` : stamped;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface FireResult {
  recordId: string;
  address: string;
  agentName: string | null;
  agentPhone: string;
  offer: string;
  status: "sent" | "failed" | "skipped";
  error?: string;
}

export async function POST(req: Request) {
  if (!process.env.AIRTABLE_PAT) {
    return Response.json({ error: "AIRTABLE_PAT not set" }, { status: 500 });
  }
  if (!process.env.QUO_API_KEY) {
    return Response.json({ error: "QUO_API_KEY not set" }, { status: 500 });
  }

  // Optional: accept a max count or dry-run flag
  let body: { maxSend?: number; dryRun?: boolean } = {};
  try {
    const text = await req.text();
    if (text.trim()) body = JSON.parse(text);
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const maxSend = body.maxSend ?? 50;
  const dryRun = body.dryRun ?? false;

  try {
    const listings = await getListings();

    // Filter for outreach-ready records per spec
    const qualified = listings.filter((l) => {
      if (l.executionPath !== "Auto Proceed") return false;
      if (l.liveStatus !== "Active") return false;
      if (l.outreachStatus) return false; // must be empty
      if (l.doNotText) return false;
      if (!l.agentPhone) return false;
      if (!l.listPrice || l.listPrice <= 0) return false;
      if (!l.address) return false;
      return true;
    });

    const toSend = qualified.slice(0, maxSend);
    const results: FireResult[] = [];
    let sent = 0;
    let failed = 0;
    let skipped = 0;

    // Dedupe by phone — don't text the same agent twice in one batch
    const phoneSeen = new Set<string>();

    for (const listing of toSend) {
      const phone = toE164(listing.agentPhone!);
      const cleanedPhone = phone.replace(/[^0-9]/g, "").slice(-10);

      if (phoneSeen.has(cleanedPhone)) {
        results.push({
          recordId: listing.id,
          address: listing.address,
          agentName: listing.agentName,
          agentPhone: phone,
          offer: formatOffer(listing.listPrice!),
          status: "skipped",
          error: "Duplicate phone in batch — agent already texted",
        });
        skipped++;
        continue;
      }
      phoneSeen.add(cleanedPhone);

      const offer = formatOffer(listing.listPrice!);
      const message = buildOutreachText(
        listing.agentName ?? "there",
        listing.address,
        offer
      );

      if (dryRun) {
        results.push({
          recordId: listing.id,
          address: listing.address,
          agentName: listing.agentName,
          agentPhone: phone,
          offer,
          status: "skipped",
          error: "Dry run — not sent",
        });
        skipped++;
        continue;
      }

      try {
        await sendMessage(phone, message);

        const now = new Date().toISOString();
        const today = now.split("T")[0];
        await updateListingRecord(listing.id, {
          [F.outreachStatus]: "Texted",
          [F.lastOutboundAt]: now,
          [F.lastOutreachDate]: today,
          [F.notes]: appendNote(
            listing.notes,
            `Sent initial offer text to ${listing.agentName ?? "agent"} at ${phone}. Offer: ${offer}.`
          ),
        });

        results.push({
          recordId: listing.id,
          address: listing.address,
          agentName: listing.agentName,
          agentPhone: phone,
          offer,
          status: "sent",
        });
        sent++;

        // Throttle: 1s between texts per Quo rate limits
        if (sent < toSend.length) await sleep(1000);
      } catch (err) {
        // Send failed — mark Manual Review
        try {
          await updateListingRecord(listing.id, {
            [F.outreachStatus]: "Manual Review",
            [F.notes]: appendNote(
              listing.notes,
              `Outreach failed: ${String(err)}`
            ),
          });
        } catch {
          // best-effort
        }

        results.push({
          recordId: listing.id,
          address: listing.address,
          agentName: listing.agentName,
          agentPhone: phone,
          offer,
          status: "failed",
          error: String(err),
        });
        failed++;
      }
    }

    return Response.json({
      totalQualified: qualified.length,
      attempted: toSend.length,
      sent,
      failed,
      skipped,
      dryRun,
      results,
    });
  } catch (err) {
    console.error("[outreach-fire] Error:", err);
    return Response.json(
      { error: "Outreach failed", detail: String(err) },
      { status: 500 }
    );
  }
}
