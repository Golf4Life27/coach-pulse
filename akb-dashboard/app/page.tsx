"use client";

// The silver-platter cockpit landing (operator 2026-07-11).
//
// THE UX LAW: if it renders, it's live and needs the operator. The landing
// is exactly three things, in order:
//   1. The decision conveyor — ONE ranked feed (replaced the Top Priorities
//      strip + Act Now + the /queue grid; those surfaces' APIs feed it).
//   2. Mission Control — the living belt (crawled → accepted → sent →
//      replies, north-star 🎯, heartbeats, event tape).
//   3. The factory floor — agent rooms, the machine at work.
//
// Everything else that used to stack here (MorningBriefing, OutreachPanel,
// PipelineBoard) was machine-work or duplicated a dedicated page — noise on
// the decision surface. Removed 2026-07-11; their pages remain in the nav.

import { useEffect } from "react";
import MissionControl from "@/components/MissionControl";
import ConveyorFeed from "@/components/conveyor/ConveyorFeed";
import FactoryFloor from "@/components/factory-floor/FactoryFloor";

const LAST_LOGIN_KEY = "akb_dashboard_last_login";

export default function CommandCenter() {
  useEffect(() => {
    try {
      window.localStorage.setItem(LAST_LOGIN_KEY, new Date().toISOString());
    } catch {
      /* non-fatal */
    }
  }, []);

  return (
    <div className="space-y-6">
      {/* 1 — What needs the operator, ranked. */}
      <ConveyorFeed />

      {/* 2 — The living machine. */}
      <MissionControl />

      {/* 3 — Agent rooms. */}
      <FactoryFloor />
    </div>
  );
}
