"use client";

/**
 * Factory floor (Phase 9.4b).
 *
 * The named-agent rooms layout per Daily UX Spec §4.1 + §4.2. Two
 * rows:
 *
 *   Pipeline row (workflow order per user direction):
 *     Sentinel intake → Sentry verification → Appraiser pricing → Crier outreach
 *
 *   Support row:
 *     Scout (buyer pipeline, active) + Forge / Scribe / Ledger / Pulse
 *     (standing by, ship in later phases)
 *
 * Maverick is not a room here — he lives in the persistent Shepherd
 * panel at every viewport corner (Daily UX Spec §3.1).
 *
 * Each room consumes the shared BriefingProvider context — single
 * fetch, multiple views, per Phase 9.4 data-fetching discipline.
 */

import CrierRoom from "./CrierRoom";
import SentryRoom from "./SentryRoom";
import AppraiserRoom from "./AppraiserRoom";
import SentinelRoom from "./SentinelRoom";
import ScoutRoom from "./ScoutRoom";
import ScribeRoom from "./ScribeRoom";
import PulseRoom from "./PulseRoom";
import StandingByRoom from "./StandingByRoom";

export default function FactoryFloor() {
  return (
    <section aria-label="Factory floor" className="space-y-3">
      <header className="flex items-center justify-between">
        <h2 className="text-sm font-bold text-white uppercase tracking-wide">
          Factory Floor
        </h2>
        <span className="text-[10px] text-gray-600">
          Pipeline order: Sentinel → Sentry → Appraiser → Crier
        </span>
      </header>

      {/* Pipeline row — workflow order. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <SentinelRoom />
        <SentryRoom />
        <AppraiserRoom />
        <CrierRoom />
      </div>

      {/* Support row — Scout (active) + the four standing-by agents. */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <ScoutRoom />
        <StandingByRoom
          agent="forge"
          displayName="Forge"
          role="Outreach drafting"
          shipsIn="Phase 13 — templates + voice library"
        />
        <ScribeRoom />
        <StandingByRoom
          agent="ledger"
          displayName="Ledger"
          role="Economics"
          shipsIn="Phase 15 — revenue + retirement meter"
        />
        <PulseRoom />
      </div>
    </section>
  );
}
