// TODAY — mounted as a tab INSIDE the V1 shell (root layout: AuthGate,
// Navigation, etc.). Not the old /v2 overlay. Behind the V2 flag.
//
// The board itself lives in app/v2/_components (still "in my folder") and
// carries the four portable libs. Deal links point at V1's /pipeline/[id].

import Link from "next/link";
import TodayBoard from "../v2/_components/TodayBoard";
import { v2Enabled } from "../v2/_lib/flag";

export const dynamic = "force-dynamic";

export default function TodayPage() {
  if (!v2Enabled()) {
    return (
      <div className="bg-[#161b22] rounded-lg border border-[#30363d] p-6 text-center">
        <p className="text-sm font-bold text-gray-300">Today is behind a flag.</p>
        <p className="mt-1 text-xs text-gray-500">
          Enabled on preview deploys and local dev. Set{" "}
          <code className="bg-[#0d1117] px-1 rounded">V2_DASHBOARD=true</code> to turn it on in production.
        </p>
        <Link href="/" className="mt-3 inline-block text-xs text-blue-400 hover:underline">
          ← Command Center
        </Link>
      </div>
    );
  }
  return <TodayBoard />;
}
