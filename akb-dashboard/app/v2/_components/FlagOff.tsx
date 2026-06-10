// Shared flag-off notice for the V2 tabs (one copy, three routes).
import Link from "next/link";

export default function FlagOff({ surface }: { surface: string }) {
  return (
    <div className="bg-[#161b22] rounded-lg border border-[#30363d] p-6 text-center">
      <p className="text-sm font-bold text-gray-300">{surface} is behind a flag.</p>
      <p className="mt-1 text-xs text-gray-500">
        Enabled on preview deploys and local dev. Set{" "}
        <code className="bg-[#0d1117] px-1 rounded">V2_DASHBOARD=true</code> to turn it on in
        production.
      </p>
      <Link href="/" className="mt-3 inline-block text-xs text-blue-400 hover:underline">
        ← Command Center
      </Link>
    </div>
  );
}
