"use client";

import { useState, useEffect } from "react";
import { usePathname } from "next/navigation";

const PUBLIC_PATH_PREFIXES = ["/buyer-intake"];

export default function AuthGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const isPublic = !!pathname && PUBLIC_PATH_PREFIXES.some((p) => pathname.startsWith(p));

  useEffect(() => {
    if (isPublic) {
      setAuthenticated(true);
      return;
    }
    // Check if already authenticated via cookie
    const isAuth = document.cookie.includes("akb-auth=authenticated");
    setAuthenticated(isAuth);
  }, [isPublic]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");

    try {
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });

      if (res.ok) {
        setAuthenticated(true);
      } else {
        setError("Invalid password");
      }
    } catch {
      setError("Connection error");
    } finally {
      setLoading(false);
    }
  };

  if (authenticated === null) {
    return (
      <div className="min-h-screen bg-[#0d1117] flex items-center justify-center">
        <div className="text-gray-400">Loading...</div>
      </div>
    );
  }

  if (!authenticated) {
    return (
      <div className="min-h-screen bg-[#0d1117] flex items-center justify-center px-4">
        <div className="bg-[#161b22] border border-[#30363d] rounded-xl p-8 w-full max-w-sm">
          <div className="text-center mb-6">
            <h1 className="text-2xl font-bold text-white mb-1">AKB Solutions</h1>
            <p className="text-sm text-gray-400">Wholesale Pipeline Dashboard</p>
          </div>
          <form onSubmit={handleSubmit}>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter password"
              className="w-full bg-[#0d1117] border border-[#30363d] rounded-lg px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:border-emerald-500 mb-3"
              autoFocus
            />
            {error && <p className="text-red-400 text-xs mb-3">{error}</p>}
            <button
              type="submit"
              disabled={loading}
              className="w-full bg-[#1a5c3a] hover:bg-[#237a4d] text-white font-semibold py-3 rounded-lg transition-colors disabled:opacity-50"
            >
              {loading ? "..." : "Access Dashboard"}
            </button>
          </form>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
