import type { Metadata, Viewport } from "next";
import "./globals.css";
import AuthGate from "@/components/AuthGate";
import Navigation from "@/components/Navigation";
import QuotesBar from "@/components/QuotesBar";
import ToastContainer from "@/components/Toast";
import CommandBar from "@/components/CommandBar";

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
          <QuotesBar />
          <Navigation />
          <main className="max-w-7xl mx-auto px-4 py-6">{children}</main>
          <CommandBar />
        </AuthGate>
        <ToastContainer />
      </body>
    </html>
  );
}
