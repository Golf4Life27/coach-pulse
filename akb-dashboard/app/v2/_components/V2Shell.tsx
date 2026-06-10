"use client";

// V2 cockpit shell. Renders as a full-viewport overlay (fixed inset-0) so it
// visually replaces the v1 chrome WITHOUT touching app/layout.tsx — v1 stays
// untouched underneath; AuthGate in the root layout still gates this subtree.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { V2DataProvider, MaverickPanelProvider } from "../_lib/data";
import HealthStrip from "./HealthStrip";
import MaverickPanel from "./MaverickPanel";

const SURFACES: { name: string; href: string | null }[] = [
  { name: "TODAY", href: "/v2" },
  { name: "PIPELINE", href: null },
  { name: "AGENTS", href: null },
  { name: "MONEY", href: null },
  { name: "THEATER", href: null },
];

export default function V2Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <V2DataProvider>
      <MaverickPanelProvider>
        <div className="fixed inset-0 z-[60] flex flex-col overflow-hidden bg-[#06080b] text-zinc-200">
          {/* Top bar */}
          <header className="flex items-center justify-between border-b border-zinc-800 bg-[#0a0c10] px-3">
            <div className="flex items-center gap-4 overflow-x-auto no-scrollbar">
              <Link href="/v2" className="py-2.5 text-sm font-black tracking-tight text-white">
                MAVERICK<span className="text-cyan-400">CMD</span>
              </Link>
              <nav className="flex items-center">
                {SURFACES.map((s) =>
                  s.href ? (
                    <Link
                      key={s.name}
                      href={s.href}
                      className={`border-b-2 px-3 py-2.5 text-[10px] font-bold tracking-[0.15em] ${
                        pathname === s.href || (s.href === "/v2" && pathname?.startsWith("/v2/deal"))
                          ? "border-cyan-400 text-cyan-300"
                          : "border-transparent text-zinc-500 hover:text-zinc-200"
                      }`}
                    >
                      {s.name}
                    </Link>
                  ) : (
                    <span
                      key={s.name}
                      title="next build block"
                      className="cursor-not-allowed border-b-2 border-transparent px-3 py-2.5 text-[10px] font-bold tracking-[0.15em] text-zinc-700"
                    >
                      {s.name}
                    </span>
                  ),
                )}
              </nav>
            </div>
            <Link
              href="/"
              className="shrink-0 rounded border border-zinc-700 px-2 py-1 text-[9px] font-bold tracking-wider text-zinc-500 hover:text-zinc-300"
              title="back to the v1 dashboard"
            >
              V1
            </Link>
          </header>

          <HealthStrip />

          <main className="flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-5xl px-3 py-4 pb-28">{children}</div>
          </main>

          <MaverickPanel />
        </div>
      </MaverickPanelProvider>
    </V2DataProvider>
  );
}
