// Decision Card screen — Layer 2 of the Maverick coordinator.
// @agent: maverick
//
// This is what the text-message link opens. No auth gate: the token IS the
// credential (see lib/maverick/decision-card.ts for why that's safe here).
// Server component so the card's content never round-trips through client
// JS before Alex can read it — one fetch, one render, on his phone, one
// thumb. The actual tap-and-confirm interaction lives in the small client
// component CardActions.tsx alongside this file.

import { getCard, isRedeemable, findOption } from "@/lib/maverick/decision-card";
import { kvConfigured, kvProd } from "@/lib/maverick/oauth/kv";
import CardActions from "./CardActions";

export const runtime = "nodejs";

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-neutral-50 flex items-start justify-center px-4 py-8">
      <div className="w-full max-w-md">{children}</div>
    </div>
  );
}

function StatusScreen({ heading, body }: { heading: string; body: string }) {
  return (
    <Shell>
      <div className="rounded-2xl border border-neutral-200 bg-white p-6 text-center">
        <h1 className="text-lg font-semibold text-neutral-900">{heading}</h1>
        <p className="mt-2 text-base text-neutral-600">{body}</p>
      </div>
    </Shell>
  );
}

export default async function DecisionCardPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  if (!kvConfigured()) {
    return (
      <StatusScreen
        heading="This link is not valid"
        body="The dashboard can't reach its storage right now, so this card can't be checked. Try again in a bit."
      />
    );
  }

  const card = await getCard(kvProd, token);
  if (!card) {
    return (
      <StatusScreen
        heading="This link is not valid"
        body="This isn't a decision card the dashboard knows about."
      />
    );
  }

  const nowIso = new Date().toISOString();
  const redeemable = isRedeemable(card, nowIso);

  if (!redeemable.ok && redeemable.reason === "expired") {
    return <StatusScreen heading="This link expired" body="It's no longer live — nothing was chosen." />;
  }

  if (!redeemable.ok && redeemable.reason === "already_used") {
    const chosen = card.redeemedOptionKey ? findOption(card, card.redeemedOptionKey) : null;
    const when = card.redeemedAt ? new Date(card.redeemedAt).toLocaleString("en-US", { timeZone: "America/Chicago" }) : "earlier";
    return (
      <StatusScreen
        heading="This link was already used"
        body={chosen ? `You chose "${chosen.label}" on ${when}.` : `A choice was already made on ${when}.`}
      />
    );
  }

  return (
    <Shell>
      <div className="rounded-2xl border border-neutral-200 bg-white p-6">
        <h1 className="text-xl font-semibold text-neutral-900 leading-snug">{card.title}</h1>
        {card.context.length > 0 && (
          <ul className="mt-4 space-y-1.5 text-sm text-neutral-600 list-disc list-inside">
            {card.context.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        )}
        <div className="mt-6">
          <CardActions token={token} options={card.options} />
        </div>
      </div>
    </Shell>
  );
}
