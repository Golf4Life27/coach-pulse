// FUNNEL — V1 tab (V2 absorption), behind the V2 flag. Named FUNNEL so it
// doesn't collide with V1's PIPELINE tab (the listings table).
import Link from "next/link";
import FunnelBoard from "../v2/_components/FunnelBoard";
import { v2Enabled } from "../v2/_lib/flag";

export const dynamic = "force-dynamic";

export default function FunnelPage() {
  if (!v2Enabled()) {
    return (
      <div className="bg-[#161b22] rounded-lg border border-[#30363d] p-6 text-center">
        <p className="text-sm font-bold text-gray-300">Funnel is behind a flag.</p>
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
  return <FunnelBoard />;
}
