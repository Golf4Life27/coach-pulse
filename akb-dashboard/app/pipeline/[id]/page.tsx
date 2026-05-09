"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { Listing } from "@/lib/types";
import { formatCurrency } from "@/lib/utils";
import { ALL_DD_ITEMS } from "@/lib/actionQueue";
import { showToast } from "@/components/Toast";
import type { DealContext } from "@/types/jarvis";

function cleanPhone(phone: string): string {
  const digits = phone.replace(/[^0-9]/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return `+${digits}`;
}

function roundOffer(listPrice: number): number {
  return Math.ceil((listPrice * 0.65) / 250) * 250;
}

function statusColor(status: string | null): string {
  const colors: Record<string, string> = {
    "Negotiating": "bg-yellow-500/20 text-yellow-400",
    "Response Received": "bg-orange-500/20 text-orange-400",
    "Offer Accepted": "bg-emerald-500/20 text-emerald-400",
    "Texted": "bg-blue-500/20 text-blue-400",
    "Dead": "bg-red-500/20 text-red-400",
  };
  return colors[status ?? ""] ?? "bg-gray-500/20 text-gray-400";
}

function buildZillowUrl(address: string, city: string, state: string, zip: string): string {
  const slug = `${address} ${city} ${state} ${zip}`.replace(/[^a-zA-Z0-9\s]/g, "").replace(/\s+/g, "-");
  return `https://www.zillow.com/homes/${encodeURIComponent(slug)}_rb/`;
}

function buildRedfinUrl(address: string, city: string, state: string): string {
  const slugify = (s: string) => s.trim().replace(/[^a-zA-Z0-9\s]/g, "").replace(/\s+/g, "-");
  return `https://www.redfin.com/${state.toUpperCase()}/${slugify(city)}/${slugify(address)}`;
}

function buildRealtorUrl(address: string, city: string, state: string, zip: string): string {
  const slug = `${address}-${city}-${state}-${zip}`.replace(/[^a-zA-Z0-9-]/g, "-").replace(/-+/g, "-");
  return `https://www.realtor.com/realestateandhomes-detail/${slug}`;
}

export default function DealWorkspace() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [listing, setListing] = useState<Listing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Unified conversation
  const [convoMessages, setConvoMessages] = useState<Array<{
    id: string; source: string; direction: string; body: string;
    timestamp: string; from: string; to: string;
  }>>([]);
  const [convoLoading, setConvoLoading] = useState(false);

  // Deal context (Jarvis Phase 1 keystone)
  const [dealContext, setDealContext] = useState<DealContext | null>(null);

  // Reply composer
  const [replyOpen, setReplyOpen] = useState(false);
  const [replyText, setReplyText] = useState("");
  const [sending, setSending] = useState(false);
  const replyRef = useRef<HTMLTextAreaElement>(null);

  // Notes editor
  const [newNote, setNewNote] = useState("");
  const [savingNote, setSavingNote] = useState(false);

  // BBC input
  const [bbcCeiling, setBbcCeiling] = useState("");

  const fetchListing = useCallback(() => {
    const id = params?.id;
    if (!id) return;
    setLoading(true);
    fetch(`/api/listings/${id}`)
      .then((r) => r.ok ? r.json() : r.json().then((d) => Promise.reject(d.error ?? `HTTP ${r.status}`)))
      .then((data: Listing) => setListing(data))
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [params?.id]);

  const fetchConversation = useCallback(() => {
    const rid = params?.id;
    if (!rid) return;
    setConvoLoading(true);
    fetch(`/api/conversations/${rid}`)
      .then((r) => r.ok ? r.json() : null)
      .then((data) => { if (data?.messages) setConvoMessages(data.messages); })
      .catch(() => {})
      .finally(() => setConvoLoading(false));
  }, [params?.id]);

  const fetchDealContext = useCallback(() => {
    const rid = params?.id;
    if (!rid) return;
    fetch(`/api/deal-context/${rid}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: DealContext | null) => { if (data && !("error" in data)) setDealContext(data); })
      .catch(() => {});
  }, [params?.id]);

  useEffect(() => { fetchListing(); fetchConversation(); fetchDealContext(); }, [fetchListing, fetchConversation, fetchDealContext]);

  useEffect(() => {
    if (replyOpen && replyRef.current) replyRef.current.focus();
  }, [replyOpen]);

  const handleSendReply = async () => {
    if (!replyText.trim() || !listing?.agentPhone || sending) return;
    setSending(true);
    try {
      const res = await fetch("/api/jarvis-send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          proposalId: `workspace-reply-${Date.now()}`,
          to: cleanPhone(listing.agentPhone),
          message: replyText.trim(),
          recordId: listing.id,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        showToast(data.error || "Send failed");
        return;
      }
      showToast("Sent via Quo", "success");
      setReplyOpen(false);
      setReplyText("");
      fetchListing();
      setTimeout(fetchConversation, 2000);
    } catch { showToast("Send failed"); }
    finally { setSending(false); }
  };

  const handleSaveNote = async () => {
    if (!newNote.trim() || !listing || savingNote) return;
    setSavingNote(true);
    const today = new Date().toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "2-digit" });
    const stamped = `${today} — ${newNote.trim()}`;
    try {
      await fetch(`/api/actions/append_note`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recordId: listing.id, note: stamped }),
      });
      showToast("Note saved", "success");
      setNewNote("");
      fetchListing();
    } catch { showToast("Failed to save note"); }
    finally { setSavingNote(false); }
  };

  const handleMarkDead = async (reason: string) => {
    if (!listing) return;
    try {
      await fetch("/api/actions/mark_dead", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recordId: listing.id, reason }),
      });
      showToast("Marked Dead", "success");
      fetchListing();
    } catch { showToast("Failed"); }
  };

  if (loading) return <div className="text-gray-400 animate-pulse py-20 text-center">Loading workspace...</div>;
  if (error || !listing) {
    return (
      <div className="py-20 text-center">
        <p className="text-red-400 mb-4">{error ?? "Listing not found"}</p>
        <button type="button" onClick={() => router.back()} className="text-blue-400 hover:underline text-sm">&larr; back</button>
      </div>
    );
  }

  const offer = listing.listPrice ? roundOffer(listing.listPrice) : null;
  const checked = new Set(listing.ddChecklist ?? []);
  const bbcNum = parseFloat(bbcCeiling);
  const bbcSpread = !isNaN(bbcNum) && offer ? bbcNum - offer : null;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <button type="button" onClick={() => router.push("/")} className="text-xs text-gray-500 hover:text-gray-300 mb-1">&larr; Command Center</button>
          <h1 className="text-lg font-bold text-white">{listing.address}</h1>
          <p className="text-gray-500 text-xs">
            {[listing.city, listing.state, listing.zip].filter(Boolean).join(", ")}
          </p>
        </div>
        <span className={`px-2.5 py-1 rounded text-xs font-bold ${statusColor(listing.outreachStatus)}`}>
          {listing.outreachStatus ?? "No Status"}
        </span>
      </div>

      {/* Jarvis context strip — keystone deal-context surface */}
      {dealContext && (
        <div className="space-y-2">
          {dealContext.responseDue && (
            <div className="bg-red-500/10 border border-red-500/40 rounded px-3 py-2 text-xs text-red-300 flex items-center gap-2">
              <span className="font-bold">RESPONSE DUE</span>
              <span className="text-red-400/80">
                Last inbound {dealContext.hoursSinceInbound !== null ? `${dealContext.hoursSinceInbound}h ago` : "—"} · agent waiting on you
              </span>
            </div>
          )}
          {dealContext.multiListingAlert && dealContext.siblingRecords && dealContext.siblingRecords.length > 0 && (
            <div className="bg-amber-500/10 border border-amber-500/40 rounded px-3 py-2 text-xs text-amber-300 flex flex-wrap items-center gap-2">
              <span className="font-bold">MULTI-LISTING AGENT</span>
              <span className="text-amber-400/80">{dealContext.agent.name ?? "Agent"} also has:</span>
              {dealContext.siblingRecords.slice(0, 4).map((s) => (
                <Link key={s.recordId} href={`/pipeline/${s.recordId}`} className="underline hover:text-amber-200">
                  {s.address}
                </Link>
              ))}
              {dealContext.siblingRecords.length > 4 && (
                <span className="text-amber-400/60">+{dealContext.siblingRecords.length - 4} more</span>
              )}
            </div>
          )}
          {dealContext.ambiguousMessages.length > 0 && (
            <div className="bg-orange-500/10 border border-orange-500/40 rounded px-3 py-2 text-xs text-orange-300">
              <span className="font-bold">AMBIGUOUS:</span>
              <span className="ml-2 text-orange-400/80">
                {dealContext.ambiguousMessages.length} message(s) could not be confidently matched to this property — may belong to a sibling listing.
              </span>
            </div>
          )}
        </div>
      )}

      {/* Two columns */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* LEFT */}
        <div className="space-y-4 overflow-y-auto">
          <div className="bg-[#1c2128] rounded-lg border border-[#30363d] p-4 space-y-2 text-xs">
            <h3 className="text-sm font-bold text-gray-300 uppercase tracking-wider mb-2">Property Summary</h3>
            <div className="grid grid-cols-2 gap-2">
              <div><span className="text-gray-500">List Price</span><p className="text-white font-medium">{formatCurrency(listing.listPrice)}</p></div>
              <div><span className="text-gray-500">Your Offer (65%)</span><p className="text-emerald-400 font-medium">{formatCurrency(offer)}</p></div>
              <div><span className="text-gray-500">Bed/Bath</span><p className="text-white">{listing.bedrooms ?? "—"} / {listing.bathrooms ?? "—"}</p></div>
              <div><span className="text-gray-500">SqFt</span><p className="text-white">{listing.buildingSqFt?.toLocaleString() ?? "—"}</p></div>
              <div><span className="text-gray-500">DOM</span><p className="text-white">{listing.dom ?? "—"}</p></div>
              <div><span className="text-gray-500">Live Status</span><p className="text-white">{listing.liveStatus ?? "—"}</p></div>
            </div>
            <div className="border-t border-[#30363d] pt-2 mt-2 space-y-1">
              <p className="text-gray-500">Agent: <span className="text-white">{listing.agentName ?? "—"}</span></p>
              {listing.agentPhone && <p><a href={`tel:${listing.agentPhone}`} className="text-blue-400 hover:underline">{listing.agentPhone}</a></p>}
              {listing.agentEmail && <p><a href={`mailto:${listing.agentEmail}`} className="text-blue-400 hover:underline">{listing.agentEmail}</a></p>}
            </div>
            {listing.flipScore !== null && listing.flipScore > 0 && (
              <div className="bg-yellow-500/10 border border-yellow-500/30 rounded px-2 py-1 text-yellow-400 text-xs mt-2">
                Flip Score: {listing.flipScore}
              </div>
            )}
          </div>

          <div className="bg-[#1c2128] rounded-lg border border-[#30363d] p-4">
            <h3 className="text-sm font-bold text-gray-300 uppercase tracking-wider mb-2">DD Checklist ({checked.size}/{ALL_DD_ITEMS.length})</h3>
            <div className="space-y-1 mb-3">
              {ALL_DD_ITEMS.map((item) => (
                <div key={item} className={`text-xs ${checked.has(item) ? "text-emerald-400" : "text-gray-500"}`}>
                  {checked.has(item) ? "✓" : "·"} {item}
                </div>
              ))}
            </div>
          </div>

          <div className="bg-[#1c2128] rounded-lg border border-[#30363d] p-4 space-y-3">
            <h3 className="text-sm font-bold text-gray-300 uppercase tracking-wider mb-2">Deal Analysis</h3>
            <div className="flex gap-2 flex-wrap">
              <a href={buildZillowUrl(listing.address, listing.city, listing.state ?? "", listing.zip)} target="_blank" rel="noopener noreferrer" className="text-[10px] bg-[#30363d] hover:bg-[#3d444d] text-gray-300 px-2 py-1.5 rounded">Zillow</a>
              <a href={buildRedfinUrl(listing.address, listing.city, listing.state ?? "")} target="_blank" rel="noopener noreferrer" className="text-[10px] bg-[#30363d] hover:bg-[#3d444d] text-gray-300 px-2 py-1.5 rounded">Redfin</a>
              <a href={buildRealtorUrl(listing.address, listing.city, listing.state ?? "", listing.zip)} target="_blank" rel="noopener noreferrer" className="text-[10px] bg-[#30363d] hover:bg-[#3d444d] text-gray-300 px-2 py-1.5 rounded">Realtor.com</a>
              <a href="https://investorbase.com" target="_blank" rel="noopener noreferrer" className="text-[10px] bg-[#30363d] hover:bg-[#3d444d] text-gray-300 px-2 py-1.5 rounded">InvestorBase</a>
              <a href="https://facebook.com" target="_blank" rel="noopener noreferrer" className="text-[10px] bg-[#30363d] hover:bg-[#3d444d] text-gray-300 px-2 py-1.5 rounded">Facebook</a>
            </div>
            <div className="border-t border-[#30363d] pt-2">
              <label className="text-[10px] text-gray-500">BBC Buyer Ceiling</label>
              <div className="flex gap-2 items-center mt-1">
                <input type="number" value={bbcCeiling} onChange={(e) => setBbcCeiling(e.target.value)} placeholder="Enter BBC ceiling" className="bg-[#0d1117] border border-[#30363d] rounded px-2 py-1 text-xs text-white w-32 focus:outline-none focus:border-emerald-500" />
                {bbcSpread !== null && (
                  <span className={`text-xs font-bold ${bbcSpread > 0 ? "text-emerald-400" : "text-red-400"}`}>
                    Spread: {formatCurrency(bbcSpread)}
                  </span>
                )}
              </div>
            </div>
          </div>

          <div className="bg-[#1c2128] rounded-lg border border-[#30363d] p-4">
            <h3 className="text-sm font-bold text-gray-300 uppercase tracking-wider mb-2">Notes</h3>
            {listing.notes && (
              <div className="max-h-[200px] overflow-y-auto mb-3">
                <p className="text-xs text-gray-400 whitespace-pre-wrap leading-relaxed">{listing.notes}</p>
              </div>
            )}
            <div className="flex gap-2">
              <input type="text" value={newNote} onChange={(e) => setNewNote(e.target.value)} placeholder="Add a note..." className="flex-1 bg-[#0d1117] border border-[#30363d] rounded px-2 py-1.5 text-xs text-white focus:outline-none focus:border-emerald-500 placeholder-gray-600" onKeyDown={(e) => { if (e.key === "Enter") handleSaveNote(); }} />
              <button type="button" onClick={handleSaveNote} disabled={savingNote || !newNote.trim()} className="bg-emerald-700 hover:bg-emerald-600 text-white text-xs px-3 py-1.5 rounded disabled:opacity-50">Save</button>
            </div>
          </div>
        </div>

        {/* RIGHT */}
        <div className="space-y-4 flex flex-col">
          <div className="bg-[#1c2128] rounded-lg border border-[#30363d] p-4 flex-1 min-h-[300px] overflow-y-auto">
            <div className="flex justify-between items-center mb-3">
              <h3 className="text-sm font-bold text-gray-300 uppercase tracking-wider">Conversation</h3>
              <button type="button" onClick={fetchConversation} className="text-[10px] text-gray-500 hover:text-gray-300">Refresh</button>
            </div>
            {convoLoading && convoMessages.length === 0 && (
              <div className="text-gray-500 text-sm animate-pulse text-center py-8">Loading messages...</div>
            )}
            {!convoLoading && convoMessages.length === 0 && (
              <div className="text-gray-500 text-sm text-center py-8">No conversation history. Send a text to start.</div>
            )}
            <div className="space-y-3">
              {convoMessages.map((msg) => {
                if (msg.direction === "system") {
                  return (
                    <div key={msg.id} className="text-center text-[10px] text-gray-500 py-1">
                      {msg.timestamp && <span className="mr-1 opacity-60">{new Date(msg.timestamp).toLocaleDateString()}</span>}
                      {msg.body}
                    </div>
                  );
                }
                const isOutbound = msg.direction === "outbound";
                const sourceIcon = msg.source === "quo" ? "💬" : msg.source === "email" ? "📧" : "📝";
                return (
                  <div key={msg.id} className={`flex ${isOutbound ? "justify-end" : "justify-start"}`}>
                    <div className="max-w-[80%]">
                      <div className={`rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap ${
                        isOutbound
                          ? "bg-blue-600 text-white rounded-br-sm"
                          : "bg-[#30363d] text-gray-200 rounded-bl-sm"
                      }`}>
                        {msg.body}
                      </div>
                      <div className={`flex items-center gap-1 mt-1 ${isOutbound ? "justify-end" : ""}`}>
                        <span className="text-[9px]">{sourceIcon}</span>
                        <span className="text-[10px] text-gray-500">
                          {msg.from}{msg.timestamp ? ` · ${new Date(msg.timestamp).toLocaleString()}` : ""}
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {replyOpen && (
            <div className="bg-[#1c2128] rounded-lg border border-emerald-500/50 p-3 space-y-2">
              <textarea ref={replyRef} value={replyText} onChange={(e) => setReplyText(e.target.value)} placeholder={`Reply to ${listing.agentName?.split(" ")[0] ?? "agent"}...`} rows={3} className="w-full bg-[#0d1117] border border-[#30363d] rounded p-2 text-sm text-white focus:outline-none focus:border-emerald-400 resize-y placeholder-gray-600" disabled={sending} onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleSendReply(); if (e.key === "Escape") { setReplyOpen(false); setReplyText(""); } }} />
              <div className="flex gap-2">
                <button type="button" onClick={handleSendReply} disabled={sending || !replyText.trim()} className="flex-1 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold py-2 rounded min-h-[44px] disabled:opacity-50">{sending ? "Sending..." : "Send via Quo"}</button>
                <button type="button" onClick={() => { setReplyOpen(false); setReplyText(""); }} className="bg-[#30363d] hover:bg-[#3d444d] text-gray-300 text-xs px-4 py-2 rounded min-h-[44px]">Cancel</button>
              </div>
              <p className="text-[10px] text-gray-600">Cmd+Enter to send · Esc to cancel</p>
            </div>
          )}

          <div className="bg-[#1c2128] rounded-lg border border-[#30363d] p-3">
            <h3 className="text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-2">Quick Actions</h3>
            <div className="flex gap-2 flex-wrap">
              {listing.agentPhone && !replyOpen && (
                <button type="button" onClick={() => setReplyOpen(true)} className="bg-emerald-700 hover:bg-emerald-600 text-white text-xs font-semibold px-3 py-2 rounded min-h-[44px]">Reply via Text</button>
              )}
              {listing.agentPhone && (
                <button type="button" onClick={() => { setReplyText(`Hi ${listing.agentName?.split(" ")[0] ?? "there"}, quick due-diligence questions on ${listing.address}:\n1) Confirming bed/bath count?\n2) Vacancy status?\n3) Approx roof age?\n4) Approx HVAC age?\n5) Water heater age?\n6) Can you grant showing access?\nThanks!`); setReplyOpen(true); }} className="bg-blue-700 hover:bg-blue-600 text-white text-xs font-semibold px-3 py-2 rounded min-h-[44px]">Send DD Questions</button>
              )}
              {listing.agentEmail && (
                <a href={`mailto:${listing.agentEmail}?subject=${encodeURIComponent(`Cash Offer — ${listing.address}`)}&body=${encodeURIComponent(`Hi ${listing.agentName?.split(" ")[0] ?? "there"},\n\nI'd like to submit a formal cash offer on ${listing.address}.\n\nOffer: ${formatCurrency(offer)}\nTerms: Cash, as-is, 10-day option period, quick close\nClosing entity: We may close under one of our affiliated entities.\n\nPlease let me know if the seller is open to this offer. Happy to provide proof of funds.\n\nBest,\nAlex Balog\nAKB Solutions LLC\nalex@akb-properties.com\n(815) 556-9965`)}`} className="bg-purple-700 hover:bg-purple-600 text-white text-xs font-semibold px-3 py-2 rounded min-h-[44px] inline-flex items-center">Send Formal Offer Email</a>
              )}
              <div className="relative group">
                <button type="button" className="bg-red-900/50 hover:bg-red-900/70 text-red-300 text-xs font-semibold px-3 py-2 rounded min-h-[44px]">Mark Dead ▾</button>
                <div className="absolute bottom-full left-0 mb-1 bg-[#1c2128] border border-[#30363d] rounded shadow-lg hidden group-hover:block z-10 min-w-[160px]">
                  {["Too low", "No response", "Off market", "Assignment issues", "Flip", "Other"].map((reason) => (
                    <button key={reason} type="button" onClick={() => handleMarkDead(reason)} className="block w-full text-left px-3 py-2 text-xs text-gray-300 hover:bg-[#30363d]">{reason}</button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
