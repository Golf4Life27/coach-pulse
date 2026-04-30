"use client";

import { openCommandBar } from "@/lib/commandBus";

// Floating action button for opening the CommandBar on touch devices that
// have no Cmd+K shortcut. Hidden at lg+ where the keyboard hotkey is
// available. Opens the bar with no context (same as a "raw" Cmd+K press
// outside any focused card).
export default function CommandBarFAB() {
  return (
    <button
      type="button"
      aria-label="Open command bar"
      onClick={() => openCommandBar()}
      className="lg:hidden fixed bottom-6 right-6 z-40 w-12 h-12 rounded-full bg-[#1a5c3a] hover:bg-[#237a4d] text-white shadow-lg shadow-black/40 flex items-center justify-center transition-colors"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="w-5 h-5"
      >
        <circle cx="11" cy="11" r="7" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>
    </button>
  );
}
