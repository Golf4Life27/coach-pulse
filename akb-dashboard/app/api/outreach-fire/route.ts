import { getListings, updateListingRecord } from "@/lib/airtable";
import { sendMessage } from "@/lib/quo";

export const runtime = "nodejs";
export const maxDuration = 300;

const F = {
  outreachStatus: "fldGIgqwyCJg4uFyv",
  lastOutboundAt: "fldaK4lR5UNvycg11",
  lastOutreachDate: "fldbRrOW3IEoLtnFE",
  notes: "fldwKGxZly6O8qyPu",
};

const THROTTLE_MS = 30_000;

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
  return "$" + roundToNearest250(listPrice * 0.65).toLocaleString("en-US");
}

function buildFirstContactText(agentName: string, address: string, offer: string): string {
  const firstName = agentName.split(" ")[0] || "there";
  return `Hi ${firstName}, this is Alex with AKB Solutions. I am interested in your listing at ${address}. I would like to make a cash offer at ${offer} with a quick close. Is the seller open to offers in that range?`;
}

function buildMultiListingText(agentName: string, address: string, offer: string): string {
  const firstName = agentName.split(" ")[0] || "there";
  return `Hi ${firstName}, this is Alex with AKB Solutions again. I see you also have the listing at ${address}. Would the seller be open to a cash offer of ${offer}? Same terms — quick close, no financing contingency. Thanks!`;
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

export async function GET() {
  // Return counts for dashboard badges
  try {
    const listings = await getListings();

    const contactedPhones = new Set<string>();
    for (const l of listings) {
      if (l.agentPhone && l.outreachStatus) {
        contactedPhones.add(l.agentPhone.replace(/[^0-9]/g, "").slice(-10));
      }
    }

    let newOutreach = 0;
    let multiListing = 0;

    for (const l of listings) {
      if (l.outreachStatus === "Multi-Listing Queued") {
        multiListing++;
        continue;
      }
      if (
        l.executionPath === "Auto Proceed" &&
        l.liveStatus === "Active" &&
        !l.outreachStatus &&
        !l.doNotText &&
        l.agentPhone &&
        l.listPrice && l.listPrice > 0 &&
        l.address
      ) {
        const clean = l.agentPhone.replace(/[^0-9]/g, "").slice(-10);
        if (!contactedPhones.has(clean) && roundToNearest250(l.listPrice * 0.65) >= 5000) {
          newOutreach++;
        }
      }
    }

    return Response.json({ newOutreach, multiListing });
  } catch {
    return Response.json({ newOutreach: 0, multiListing: 0 });
  }
}

export async function POST(req: Request) {
  if (!process.env.AIRTABLE_PAT) {
    return Response.json({ error: "AIRTABLE_PAT not set" }, { status: 500 });
  }
  if (!process.env.QUO_API_KEY) {
    return Response.json({ error: "QUO_API_KEY not set" }, { status: 500 });
  }

  let body: { maxSend?: number; dryRun?: boolean; multiListing?: boolean } = {};
  try {
    const text = await req.text();
    if (text.trim()) body = JSON.parse(text);
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const maxSend = body.maxSend ?? 50;
  const dryRun = body.dryRun ?? false;
  const multiListing = body.multiListing ?? false;

  try {
    const listings = await getListings();

    if (multiListing) {
      return handleMultiListing(listings, maxSend, dryRun);
    }

    return handleNewOutreach(listings, maxSend, dryRun);
  } catch (err) {
    console.error("[outreach-fire] Error:", err);
    return Response.json(
      { error: "Outreach failed", detail: String(err) },
      { status: 500 }
    );
  }
}

async function handleNewOutreach(
  listings: Awaited<ReturnType<typeof getListings>>,
  maxSend: number,
  dryRun: boolean
) {
  const contactedPhones = new Set<string>();
  for (const l of listings) {
    if (l.agentPhone && l.outreachStatus) {
      contactedPhones.add(l.agentPhone.replace(/[^0-9]/g, "").slice(-10));
    }
  }

  const qualified = listings.filter((l) => {
    if (l.executionPath !== "Auto Proceed") return false;
    if (l.liveStatus !== "Active") return false;
    if (l.outreachStatus) return false;
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
  let multiQueued = 0;
  const phoneSeen = new Set<string>();

  for (const listing of toSend) {
    const phone = toE164(listing.agentPhone!);
    const cleanedPhone = phone.replace(/[^0-9]/g, "").slice(-10);
    const offerNum = roundToNearest250(listing.listPrice! * 0.65);

    if (offerNum < 5000) {
      results.push({ recordId: listing.id, address: listing.address, agentName: listing.agentName, agentPhone: phone, offer: formatOffer(listing.listPrice!), status: "skipped", error: "Offer below $5K floor" });
      skipped++;
      continue;
    }

    if (contactedPhones.has(cleanedPhone)) {
      // Set Multi-Listing Queued instead of leaving blank
      if (!dryRun) {
        try {
          await updateListingRecord(listing.id, {
            [F.outreachStatus]: "Multi-Listing Queued",
            [F.notes]: appendNote(listing.notes, `Agent already contacted on another property. Queued for multi-listing follow-up.`),
          });
          multiQueued++;
        } catch { /* best-effort */ }
      }
      results.push({ recordId: listing.id, address: listing.address, agentName: listing.agentName, agentPhone: phone, offer: formatOffer(listing.listPrice!), status: "skipped", error: "Agent already contacted — queued for multi-listing" });
      skipped++;
      continue;
    }

    if (phoneSeen.has(cleanedPhone)) {
      if (!dryRun) {
        try {
          await updateListingRecord(listing.id, {
            [F.outreachStatus]: "Multi-Listing Queued",
            [F.notes]: appendNote(listing.notes, `Same agent texted earlier in this batch. Queued for multi-listing follow-up.`),
          });
          multiQueued++;
        } catch { /* best-effort */ }
      }
      results.push({ recordId: listing.id, address: listing.address, agentName: listing.agentName, agentPhone: phone, offer: formatOffer(listing.listPrice!), status: "skipped", error: "Batch dedup — queued for multi-listing" });
      skipped++;
      continue;
    }
    phoneSeen.add(cleanedPhone);

    const offer = formatOffer(listing.listPrice!);
    const message = buildFirstContactText(listing.agentName ?? "there", listing.address, offer);

    if (dryRun) {
      results.push({ recordId: listing.id, address: listing.address, agentName: listing.agentName, agentPhone: phone, offer, status: "skipped", error: `Dry run — message: "${message}"` });
      skipped++;
      continue;
    }

    try {
      await sendMessage(phone, message);

      const now = new Date().toISOString();
      // Per Checklist Phase 11.4 (Finding #9 fix): capture
      // Stored_Offer_Price + List_Price_At_Send at H2 send time. Door-
      // opener semantics: Stored_Offer_Price = 65% List Price rounded
      // to nearest $250. List_Price_At_Send = the list price at the
      // moment of outreach (snapshot — survives subsequent price drops).
      // These match the d3-backfill route's shape so live + backfilled
      // data are queryable uniformly.
      await updateListingRecord(listing.id, {
        [F.outreachStatus]: "Texted",
        [F.lastOutboundAt]: now,
        [F.lastOutreachDate]: now.split("T")[0],
        [F.notes]: appendNote(listing.notes, `Sent initial offer to ${listing.agentName ?? "agent"} at ${phone}. Offer: ${offer}.`),
        Stored_Offer_Price: offerNum,
        List_Price_At_Send: listing.listPrice!,
      });

      contactedPhones.add(cleanedPhone);
      results.push({ recordId: listing.id, address: listing.address, agentName: listing.agentName, agentPhone: phone, offer, status: "sent" });
      sent++;

      if (sent < toSend.length) await sleep(THROTTLE_MS);
    } catch (err) {
      try {
        await updateListingRecord(listing.id, {
          [F.outreachStatus]: "Manual Review",
          [F.notes]: appendNote(listing.notes, `Outreach failed: ${String(err)}`),
        });
      } catch { /* best-effort */ }
      results.push({ recordId: listing.id, address: listing.address, agentName: listing.agentName, agentPhone: phone, offer, status: "failed", error: String(err) });
      failed++;
    }
  }

  return Response.json({
    mode: "new",
    totalQualified: qualified.length,
    attempted: toSend.length,
    sent, failed, skipped, multiQueued, dryRun,
    throttleSeconds: THROTTLE_MS / 1000,
    results,
  });
}

async function handleMultiListing(
  listings: Awaited<ReturnType<typeof getListings>>,
  maxSend: number,
  dryRun: boolean
) {
  const queued = listings.filter(
    (l) => l.outreachStatus === "Multi-Listing Queued" && l.agentPhone && l.listPrice && l.address && !l.doNotText
  );

  const toSend = queued.slice(0, maxSend);
  const results: FireResult[] = [];
  let sent = 0;
  let failed = 0;
  let skipped = 0;

  for (const listing of toSend) {
    const phone = toE164(listing.agentPhone!);
    const offerNum = roundToNearest250(listing.listPrice! * 0.65);

    if (offerNum < 5000) {
      results.push({ recordId: listing.id, address: listing.address, agentName: listing.agentName, agentPhone: phone, offer: formatOffer(listing.listPrice!), status: "skipped", error: "Offer below $5K floor" });
      skipped++;
      continue;
    }

    const offer = formatOffer(listing.listPrice!);
    const message = buildMultiListingText(listing.agentName ?? "there", listing.address, offer);

    if (dryRun) {
      results.push({ recordId: listing.id, address: listing.address, agentName: listing.agentName, agentPhone: phone, offer, status: "skipped", error: `Dry run — message: "${message}"` });
      skipped++;
      continue;
    }

    try {
      await sendMessage(phone, message);

      const now = new Date().toISOString();
      // Same Stored_Offer_Price + List_Price_At_Send capture as the
      // new-outreach handler (Checklist Phase 11.4). Multi-listing
      // queued records reach send via a separate path but share the
      // door-opener pricing semantics.
      await updateListingRecord(listing.id, {
        [F.outreachStatus]: "Texted",
        [F.lastOutboundAt]: now,
        [F.lastOutreachDate]: now.split("T")[0],
        [F.notes]: appendNote(listing.notes, `Sent multi-listing follow-up to ${listing.agentName ?? "agent"} at ${phone}. Offer: ${offer}.`),
        Stored_Offer_Price: offerNum,
        List_Price_At_Send: listing.listPrice!,
      });

      results.push({ recordId: listing.id, address: listing.address, agentName: listing.agentName, agentPhone: phone, offer, status: "sent" });
      sent++;

      if (sent < toSend.length) await sleep(THROTTLE_MS);
    } catch (err) {
      try {
        await updateListingRecord(listing.id, {
          [F.outreachStatus]: "Manual Review",
          [F.notes]: appendNote(listing.notes, `Multi-listing outreach failed: ${String(err)}`),
        });
      } catch { /* best-effort */ }
      results.push({ recordId: listing.id, address: listing.address, agentName: listing.agentName, agentPhone: phone, offer, status: "failed", error: String(err) });
      failed++;
    }
  }

  return Response.json({
    mode: "multi-listing",
    totalQueued: queued.length,
    attempted: toSend.length,
    sent, failed, skipped, dryRun,
    throttleSeconds: THROTTLE_MS / 1000,
    results,
  });
}
