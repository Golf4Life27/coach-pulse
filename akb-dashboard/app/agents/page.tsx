// AGENTS — V1 tab (V2 absorption), behind the V2 flag.
import Link from "next/link";
import AgentsBoard from "../v2/_components/AgentsBoard";
import { v2Enabled } from "../v2/_lib/flag";

export const dynamic = "force-dynamic";

export default function AgentsPage() {
  if (!v2Enabled()) {
    return (
      <div className="bg-[#161b22] rounded-lg border border-[#30363d] p-6 text-center">
        <p className="text-sm font-bold text-gray-300">Agents is behind a flag.</p>
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
  return <AgentsBoard />;
}
