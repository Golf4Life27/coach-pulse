"use client";

import { useState } from "react";

const MARKET_OPTIONS = ["Detroit", "San Antonio", "Dallas", "Houston", "Memphis", "Atlanta", "Other"];
const PROPERTY_TYPE_OPTIONS = ["Single Family", "Multi Family", "Mixed", "Land"];
const BUYER_TYPE_OPTIONS = ["flipper", "landlord", "wholesaler", "owner-occupant", "unknown"];

export default function BuyerIntakePage() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [entity, setEntity] = useState("");
  const [phone, setPhone] = useState("");
  const [markets, setMarkets] = useState<string[]>([]);
  const [targetZips, setTargetZips] = useState("");
  const [minPrice, setMinPrice] = useState("");
  const [maxPrice, setMaxPrice] = useState("");
  const [minBeds, setMinBeds] = useState("");
  const [propertyTypePreference, setPropertyTypePreference] = useState<string[]>([]);
  const [buyerType, setBuyerType] = useState("unknown");
  const [volumePerYear, setVolumePerYear] = useState("");
  const [notes, setNotes] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (val: string, list: string[], setter: (v: string[]) => void) => {
    setter(list.includes(val) ? list.filter((x) => x !== val) : [...list, val]);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/buyers/intake", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          email: email.trim(),
          entity: entity.trim() || undefined,
          phone: phone.trim() || undefined,
          markets,
          targetZips: targetZips.trim() || undefined,
          minPrice: minPrice ? Number(minPrice) : undefined,
          maxPrice: maxPrice ? Number(maxPrice) : undefined,
          minBeds: minBeds ? Number(minBeds) : undefined,
          propertyTypePreference,
          buyerType,
          volumePerYear: volumePerYear ? Number(volumePerYear) : undefined,
          notes: notes.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      setDone(true);
    } catch (err) {
      setError(String(err));
    } finally {
      setSubmitting(false);
    }
  };

  if (done) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4 -mt-6">
        <div className="bg-[#161b22] border border-[#30363d] rounded-xl p-8 max-w-md w-full text-center">
          <h1 className="text-2xl font-bold text-emerald-400 mb-2">You're on the list</h1>
          <p className="text-gray-400 text-sm">
            Thanks. We'll reach out as deals matching your criteria come up.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto py-2">
      <div className="mb-4">
        <h1 className="text-2xl font-bold text-white">AKB Buyer Intake</h1>
        <p className="text-gray-400 text-sm">Get on the list. We'll send deals matching your criteria.</p>
      </div>

      <form onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Field label="Full name *">
            <input required value={name} onChange={(e) => setName(e.target.value)} className={inputCls} />
          </Field>
          <Field label="Email *">
            <input required type="email" value={email} onChange={(e) => setEmail(e.target.value)} className={inputCls} />
          </Field>
          <Field label="Entity / company">
            <input value={entity} onChange={(e) => setEntity(e.target.value)} className={inputCls} />
          </Field>
          <Field label="Phone">
            <input value={phone} onChange={(e) => setPhone(e.target.value)} className={inputCls} />
          </Field>
        </div>

        <Field label="Markets">
          <div className="flex flex-wrap gap-2">
            {MARKET_OPTIONS.map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => toggle(m, markets, setMarkets)}
                className={`text-xs px-3 py-1.5 rounded border ${markets.includes(m) ? "bg-emerald-700 border-emerald-500 text-white" : "bg-[#0d1117] border-[#30363d] text-gray-400"}`}
              >
                {m}
              </button>
            ))}
          </div>
        </Field>

        <Field label="Target ZIPs (comma-separated)">
          <input value={targetZips} onChange={(e) => setTargetZips(e.target.value)} placeholder="48205, 48224, 48207" className={inputCls} />
        </Field>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <Field label="Min price"><input type="number" value={minPrice} onChange={(e) => setMinPrice(e.target.value)} className={inputCls} /></Field>
          <Field label="Max price"><input type="number" value={maxPrice} onChange={(e) => setMaxPrice(e.target.value)} className={inputCls} /></Field>
          <Field label="Min beds"><input type="number" value={minBeds} onChange={(e) => setMinBeds(e.target.value)} className={inputCls} /></Field>
        </div>

        <Field label="Property type preference">
          <div className="flex flex-wrap gap-2">
            {PROPERTY_TYPE_OPTIONS.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => toggle(t, propertyTypePreference, setPropertyTypePreference)}
                className={`text-xs px-3 py-1.5 rounded border ${propertyTypePreference.includes(t) ? "bg-emerald-700 border-emerald-500 text-white" : "bg-[#0d1117] border-[#30363d] text-gray-400"}`}
              >
                {t}
              </button>
            ))}
          </div>
        </Field>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Field label="Buyer type">
            <select value={buyerType} onChange={(e) => setBuyerType(e.target.value)} className={inputCls}>
              {BUYER_TYPE_OPTIONS.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </Field>
          <Field label="Deals per year">
            <input type="number" value={volumePerYear} onChange={(e) => setVolumePerYear(e.target.value)} className={inputCls} />
          </Field>
        </div>

        <Field label="Anything else?">
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} className={`${inputCls} resize-y`} />
        </Field>

        {error && (
          <div className="bg-red-500/10 border border-red-500/40 rounded px-3 py-2 text-xs text-red-300">{error}</div>
        )}

        <button
          type="submit"
          disabled={submitting || !name.trim() || !email.trim()}
          className="w-full bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-white font-semibold py-3 rounded"
        >
          {submitting ? "Submitting..." : "Get on the list"}
        </button>
      </form>
    </div>
  );
}

const inputCls =
  "w-full bg-[#0d1117] border border-[#30363d] rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-emerald-500 placeholder-gray-600";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-[11px] uppercase tracking-wider text-gray-500 mb-1 block">{label}</span>
      {children}
    </label>
  );
}
