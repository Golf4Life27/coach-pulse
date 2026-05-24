"use client";

/**
 * @deprecated Legacy chat surface. Superseded by the Maverick
 * Shepherd panel chat surface (Phase 9.1). Component file retains
 * the `Jarvis` name for backwards compatibility with existing
 * imports until 9.1 lands and Shepherd panel replaces this. Visible
 * identity strings updated to "Maverick" per Phase 9.11.
 */

import { useState, useCallback, useRef, useEffect } from "react";
import { showToast } from "@/components/Toast";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export default function JarvisChat() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open && inputRef.current) inputRef.current.focus();
  }, [open]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const handleOpen = useCallback(() => {
    setOpen(true);
    if (messages.length === 0) {
      sendMessage("What should I focus on right now?");
    }
  }, [messages.length]);

  const sendMessage = useCallback(
    async (text: string) => {
      const userMsg: ChatMessage = { role: "user", content: text };
      const newMessages = [...messages, userMsg];
      setMessages(newMessages);
      setInput("");
      setLoading(true);

      try {
        const res = await fetch("/api/jarvis-chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: newMessages }),
        });
        const data = await res.json();

        if (!res.ok) {
          showToast(data.error || "Maverick failed");
          return;
        }

        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: data.answer },
        ]);
      } catch {
        showToast("Maverick failed");
      } finally {
        setLoading(false);
      }
    },
    [messages]
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || loading) return;
    sendMessage(input.trim());
  };

  return (
    <>
      <button
        type="button"
        onClick={handleOpen}
        className="text-xs bg-purple-700 hover:bg-purple-600 text-white px-3 py-1.5 rounded transition-colors"
      >
        What&apos;s Next
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 px-4 pb-4 sm:items-center sm:pb-0"
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div className="bg-[#161b22] border border-[#30363d] rounded-xl w-full max-w-lg max-h-[80vh] flex flex-col shadow-2xl">
            {/* Header */}
            <div className="flex justify-between items-center px-4 py-3 border-b border-[#30363d]">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-purple-500 animate-pulse" />
                <h2 className="text-white font-bold text-sm">Maverick</h2>
              </div>
              <button
                onClick={() => setOpen(false)}
                className="text-gray-400 hover:text-white text-lg leading-none"
              >
                &times;
              </button>
            </div>

            {/* Messages */}
            <div
              ref={scrollRef}
              className="flex-1 overflow-y-auto p-4 space-y-3 min-h-[200px]"
            >
              {messages.map((m, i) => (
                <div
                  key={i}
                  className={`text-sm leading-relaxed ${
                    m.role === "user"
                      ? "text-gray-400 italic"
                      : "text-gray-200 whitespace-pre-wrap"
                  }`}
                >
                  {m.role === "user" ? (
                    <span className="text-purple-400">You:</span>
                  ) : (
                    <span className="text-purple-400">Maverick:</span>
                  )}{" "}
                  {m.content}
                </div>
              ))}
              {loading && (
                <div className="text-sm text-gray-500 animate-pulse">
                  Maverick is thinking...
                </div>
              )}
            </div>

            {/* Input */}
            <form
              onSubmit={handleSubmit}
              className="border-t border-[#30363d] px-4 py-3"
            >
              <div className="flex gap-2">
                <input
                  ref={inputRef}
                  type="text"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder="Ask Maverick..."
                  className="flex-1 bg-[#0d1117] border border-[#30363d] rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-purple-500 placeholder-gray-600"
                  disabled={loading}
                />
                <button
                  type="submit"
                  disabled={loading || !input.trim()}
                  className="bg-purple-700 hover:bg-purple-600 text-white text-xs font-semibold px-4 py-2 rounded transition-colors disabled:opacity-50 min-h-[44px]"
                >
                  Send
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
