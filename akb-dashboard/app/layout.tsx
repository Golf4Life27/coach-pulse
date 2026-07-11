import type { Metadata, Viewport } from "next";
import "./globals.css";
import AuthGate from "@/components/AuthGate";
import Navigation from "@/components/Navigation";
import NorthStarHeader from "@/components/NorthStarHeader";
import MobileTabBar from "@/components/MobileTabBar";
import PwaRegister from "@/components/PwaRegister";
import QuotesBar from "@/components/QuotesBar";
import ToastContainer from "@/components/Toast";
import CommandBar from "@/components/CommandBar";
import CommandBarFAB from "@/components/CommandBarFAB";
import MaverickDock from "@/components/MaverickDock";
import BriefingProvider from "@/components/BriefingProvider";
import { v2Enabled } from "./v2/_lib/flag";
import V2Frame from "./v2/_components/V2Frame";

export const metadata: Metadata = {
  title: "AKB Cockpit",
  description: "AKB Solutions — the operator cockpit",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "AKB",
  },
  icons: {
    apple: "/icons/apple-touch-icon.png",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  themeColor: "#0d1117",
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased dark">
      <body className="min-h-full bg-[#0d1117] text-gray-200" style={{ fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' }}>
        <AuthGate>
          <BriefingProvider>
            <QuotesBar />
            {/* North star + belt health — always visible, every page. */}
            <NorthStarHeader />
            <Navigation v2={v2Enabled()} />
            {v2Enabled() ? (
              // V2 absorption (flag-gated): slim health strip + shared data
              // provider + Maverick panel around the SAME <main> container.
              // NOTE: for statically-prerendered pages this evaluates at
              // BUILD time — correct on Vercel, where env changes always
              // trigger a rebuild (flipping V2_DASHBOARD requires redeploy).
              <V2Frame>{children}</V2Frame>
            ) : (
              // pb-24 clears the mobile tab bar's thumb zone.
              <main className="max-w-7xl mx-auto px-4 py-6 pb-24 lg:pb-6">{children}</main>
            )}
            <CommandBar />
            <CommandBarFAB />
            {/* Maverick everywhere — context-aware chat dock. Replaced the
                ShepherdPanel priorities list 2026-07-11: its cards duplicated
                the conveyor (one surface per job). */}
            <MaverickDock />
            <MobileTabBar />
          </BriefingProvider>
        </AuthGate>
        <ToastContainer />
        <PwaRegister />
      </body>
    </html>
  );
}
