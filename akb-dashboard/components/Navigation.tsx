"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const tabs = [
  { name: "ACT NOW", href: "/" },
  { name: "PIPELINE", href: "/pipeline" },
  { name: "DEALS", href: "/deals" },
  { name: "BUYERS", href: "/buyers" },
];

export default function Navigation() {
  const pathname = usePathname();

  return (
    <nav className="bg-[#161b22] border-b border-[#30363d] px-4">
      <div className="max-w-7xl mx-auto flex items-center justify-between">
        <div className="flex items-center gap-6">
          <Link href="/" className="text-white font-bold text-lg py-3">
            AKB<span className="text-emerald-400">dash</span>
          </Link>
          <div className="flex gap-1">
            {tabs.map((tab) => {
              const isActive =
                tab.href === "/"
                  ? pathname === "/"
                  : pathname.startsWith(tab.href);
              return (
                <Link
                  key={tab.href}
                  href={tab.href}
                  className={`px-4 py-3 text-xs font-bold tracking-wider transition-colors border-b-2 ${
                    isActive
                      ? "text-emerald-400 border-emerald-400"
                      : "text-gray-400 border-transparent hover:text-white hover:border-gray-600"
                  }`}
                >
                  {tab.name}
                </Link>
              );
            })}
          </div>
        </div>
      </div>
    </nav>
  );
}
