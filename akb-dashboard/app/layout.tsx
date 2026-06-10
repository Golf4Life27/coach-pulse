import type { Metadata, Viewport } from "next";
import "./globals.css";
import AuthGate from "@/components/AuthGate";
import Navigation from "@/components/Navigation";
import QuotesBar from "@/components/QuotesBar";
import ToastContainer from "@/components/Toast";
import CommandBar from "@/components/CommandBar";
import CommandBarFAB from "@/components/CommandBarFAB";
import ShepherdPanel from "@/components/ShepherdPanel";
import BriefingProvider from "@/components/BriefingProvider";
import { v2Enabled } from "./v2/_lib/flag";
import V2Frame from "./v2/_components/V2Frame";

export const metadata: Metadata = {
  title: "AKB Solutions — Pipeline Dashboard",
  description: "Wholesale pipeline operations dashboard",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
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
            <Navigation v2={v2Enabled()} />
            {v2Enabled() ? (
              // V2 absorption (flag-gated): slim health strip + shared data
              // provider + Maverick panel around the SAME <main> container.
              // NOTE: for statically-prerendered pages this evaluates at
              // BUILD time — correct on Vercel, where env changes always
              // trigger a rebuild (flipping V2_DASHBOARD requires redeploy).
              <V2Frame>{children}</V2Frame>
            ) : (
              <main className="max-w-7xl mx-auto px-4 py-6">{children}</main>
            )}
            <CommandBar />
            <CommandBarFAB />
            <ShepherdPanel />
          </BriefingProvider>
        </AuthGate>
        <ToastContainer />
      </body>
    </html>
  );
}
