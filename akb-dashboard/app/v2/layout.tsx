// V2 surface — feature-flag gate (server-side, no env changes required):
//   - production: OFF unless V2_DASHBOARD=true is set on the project
//   - Vercel preview deploys: ON automatically (this is where v2 is reviewed)
//   - local dev: ON
// Everything under /v2 is read-only against the spine; the only mutation it
// performs is PATCH /api/operator-actions (an existing v1 route the Queue
// already uses). v1 routes, libs, crons, and schemas are untouched.

import V2Shell from "./_components/V2Shell";
import "./v2.css";

export const metadata = {
  title: "MAVERICK CMD — V2",
};

// Evaluate the flag per-request (not baked at build) so ops can flip
// V2_DASHBOARD on the project without a code change.
export const dynamic = "force-dynamic";

function flagEnabled(): boolean {
  if (process.env.V2_DASHBOARD === "true") return true;
  if (process.env.VERCEL_ENV === "preview") return true;
  if (process.env.NODE_ENV === "development") return true;
  return false;
}

export default function V2Layout({ children }: { children: React.ReactNode }) {
  if (!flagEnabled()) {
    return (
      <div className="fixed inset-0 z-[60] flex items-center justify-center bg-[#06080b] px-6">
        <div className="max-w-sm rounded-xl border border-zinc-800 bg-[#0a0c10] p-6 text-center">
          <p className="mb-2 text-sm font-bold tracking-widest text-zinc-300">V2 FLAG IS OFF</p>
          <p className="text-xs leading-relaxed text-zinc-500">
            The v2 cockpit is enabled on preview deploys and local dev. To turn it on here, set{" "}
            <code className="rounded bg-zinc-800 px-1 py-px text-zinc-300">V2_DASHBOARD=true</code>{" "}
            on the Vercel project. v1 is unaffected either way.
          </p>
          <a href="/" className="mt-4 inline-block rounded border border-zinc-700 px-3 py-1.5 text-xs font-bold text-zinc-400 hover:text-white">
            ← back to v1
          </a>
        </div>
      </div>
    );
  }
  return <V2Shell>{children}</V2Shell>;
}
