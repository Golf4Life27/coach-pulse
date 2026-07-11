"use client";

// Maverick everywhere (silver-platter cockpit): a floating dock on every
// page that opens a chat sheet. Context-aware — on a deal room it passes
// the on-screen recordId, so the backend injects THAT deal's sourced
// numbers (delivery-stamped offer, ceiling, bands) and answers under the
// pricing doctrine: it cites, it never invents.

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";

interface Msg {
  role: "user" | "assistant";
  content: string;
}

export default function MaverickDock() {
  const pathname = usePathname() ?? "/";
  const recordMatch = /^\/pipeline\/(rec[A-Za-z0-9]{14})/.exec(pathname);
  const recordId = recordMatch ? recordMatch[1] : null;

  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contextRef = useRef<string | null>(null);

  // A navigation to a different record starts a fresh thread — context-aware
  // means the conversation is ABOUT what's on screen.
  useEffect(() => {
    if (contextRef.current !== recordId) {
      contextRef.current = recordId;
      setMessages([]);
    }
  }, [recordId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, thinking]);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || thinking) return;
      const next: Msg[] = [...messages, { role: "user", content: trimmed }];
      setMessages(next);
      setInput("");
      setThinking(true);
      try {
        const res = await fetch("/api/jarvis-chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: next, recordId: recordId ?? undefined }),
        });
        const data = await res.json().catch(() => ({}));
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: res.ok ? (data.answer ?? "[no answer]") : `Maverick error: ${data.error ?? res.status}` },
        ]);
      } catch {
        setMessages((prev) => [...prev, { role: "assistant", content: "Maverick is unreachable right now." }]);
      } finally {
        setThinking(false);
      }
    },
    [messages, recordId, thinking],
  );

  return (
    <>
      {/* Dock button — clear of the mobile tab bar. */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Ask Maverick"
        className="fixed z-50 right-4 bottom-20 lg:bottom-6 w-14 h-14 rounded-full bg-[#238636] hover:bg-[#2ea043] text-white shadow-lg shadow-black/40 border border-emerald-400/30 flex items-center justify-center text-xl transition-colors"
      >
        {open ? "✕" : "🎯"}
      </button>

      {open && (
        <div className="fixed z-50 inset-x-0 bottom-0 lg:inset-auto lg:right-4 lg:bottom-24 lg:w-[420px] max-h-[75vh] flex flex-col bg-[#161b22] border border-[#30363d] lg:rounded-2xl rounded-t-2xl shadow-2xl shadow-black/60">
          <div className="px-4 py-3 border-b border-[#30363d] flex items-center justify-between">
            <div>
              <div className="text-sm font-bold text-white">Maverick</div>
              <div className="text-[10px] text-gray-500">
                {recordId ? "answering about the deal on your screen" : "pipeline-wide"} · doctrine numbers only
              </div>
            </div>
            <button type="button" onClick={() => setOpen(false)} className="text-gray-500 hover:text-gray-300 min-h-[44px] min-w-[44px]" aria-label="Close">
              ✕
            </button>
          </div>

          <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3 min-h-[160px]">
            {messages.length === 0 && !thinking && (
              <div className="space-y-2">
                <p className="text-xs text-gray-500">
                  {recordId
                    ? "Ask about this deal — stamped offer, ceiling, next move. Maverick cites the record's numbers; it never invents one."
                    : "Ask what needs you, where the belt stands, or about any deal."}
                </p>
                <div className="flex flex-wrap gap-2">
                  {(recordId
                    ? ["What's my ceiling here?", "Draft my next move", "Is the math good on this one?"]
                    : ["What should I focus on right now?", "How's the belt running today?"]
                  ).map((q) => (
                    <button
                      key={q}
                      type="button"
                      onClick={() => send(q)}
                      className="text-[11px] bg-[#0d1117] border border-[#30363d] hover:border-emerald-500/50 text-gray-300 px-3 py-2 rounded-full min-h-[40px]"
                    >
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                <div
                  className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap leading-relaxed ${
                    m.role === "user" ? "bg-blue-600 text-white rounded-br-sm" : "bg-[#0d1117] border border-[#30363d] text-gray-200 rounded-bl-sm"
                  }`}
                >
                  {m.content}
                </div>
              </div>
            ))}
            {thinking && <div className="text-xs text-gray-500 animate-pulse">Maverick is thinking…</div>}
          </div>

          <div className="p-3 border-t border-[#30363d] flex gap-2" style={{ paddingBottom: "max(12px, env(safe-area-inset-bottom))" }}>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") send(input);
              }}
              placeholder={recordId ? "Ask about this deal…" : "Ask Maverick…"}
              className="flex-1 bg-[#0d1117] border border-[#30363d] rounded-xl px-3 py-2.5 text-sm text-white focus:outline-none focus:border-emerald-500 placeholder-gray-600 min-h-[44px]"
            />
            <button
              type="button"
              onClick={() => send(input)}
              disabled={thinking || !input.trim()}
              className="bg-emerald-700 hover:bg-emerald-600 text-white text-sm font-semibold px-4 rounded-xl min-h-[44px] disabled:opacity-50"
            >
              Send
            </button>
          </div>
        </div>
      )}
    </>
  );
}
