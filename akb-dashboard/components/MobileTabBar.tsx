"use client";

// Thumb-first bottom navigation (mobile only — hidden lg+ where the top
// Navigation lives). Four destinations, 56px targets.

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS: Array<{ href: string; label: string; icon: string; match: (p: string) => boolean }> = [
  { href: "/", label: "Cockpit", icon: "🎛", match: (p) => p === "/" || p.startsWith("/queue") },
  { href: "/pipeline", label: "Pipeline", icon: "🏭", match: (p) => p.startsWith("/pipeline") },
  { href: "/deals", label: "Deals", icon: "🤝", match: (p) => p.startsWith("/deals") },
  { href: "/pulse", label: "Pulse", icon: "🫀", match: (p) => p.startsWith("/pulse") || p.startsWith("/system") },
];

export default function MobileTabBar() {
  const pathname = usePathname() ?? "/";
  return (
    <nav
      className="lg:hidden fixed bottom-0 inset-x-0 z-40 bg-[#0d1117]/95 backdrop-blur border-t border-[#21262d]"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      aria-label="Primary"
    >
      <div className="grid grid-cols-4">
        {TABS.map((t) => {
          const active = t.match(pathname);
          return (
            <Link
              key={t.href}
              href={t.href}
              className={`flex flex-col items-center justify-center gap-0.5 min-h-[56px] text-[10px] font-semibold transition-colors ${
                active ? "text-emerald-300" : "text-gray-500 hover:text-gray-300"
              }`}
            >
              <span className="text-lg leading-none" aria-hidden>
                {t.icon}
              </span>
              {t.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
