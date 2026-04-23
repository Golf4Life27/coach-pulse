"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { showToast } from "@/components/Toast";

interface CommandResult {
  intent: "navigate" | "action" | "query" | "unclear";
  route?: string | null;
  action_type?: string | null;
  action_payload?: { recordId: string } | null;
  answer?: string | null;
  clarification?: string | null;
}

interface CommandBarProps {
  onDraftFollowUp?: (recordId: string) => void;
}

export default function CommandBar({ onDraftFollowUp }: CommandBarProps) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<CommandResult | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen((prev) => !prev);
        setResult(null);
        setInput("");
      }
      if (e.key === "Escape" && open) {
        setOpen(false);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!input.trim() || loading) return;

      setLoading(true);
      setResult(null);

      try {
        const res = await fetch("/api/claude/command", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ command: input }),
        });
        const data = await res.json();

        if (!res.ok) {
          showToast(data.error || `Error ${res.status}`);
          return;
        }

        setResult(data);

        if (data.intent === "navigate" && data.route) {
          router.push(data.route);
          setOpen(false);
        } else if (
          data.intent === "action" &&
          data.action_type === "draft_followup" &&
          data.action_payload?.recordId
        ) {
          if (onDraftFollowUp) {
            onDraftFollowUp(data.action_payload.recordId);
          }
          setOpen(false);
        }
      } catch {
        showToast("Command failed");
      } finally {
        setLoading(false);
      }
    },
    [input, loading, router, onDraftFollowUp]
  );

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh] bg-black/70 px-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <div className="bg-[#161b22] border border-[#30363d] rounded-xl w-full max-w-lg shadow-2xl">
        <form onSubmit={handleSubmit}>
          <div className="flex items-center px-4 border-b border-[#30363d]">
            <span className="text-gray-500 text-sm mr-2">&gt;</span>
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="What do you need? (e.g. 'total spread on active deals')"
              className="flex-1 bg-transparent text-white text-sm py-3 focus:outline-none placeholder-gray-600"
              disabled={loading}
            />
            {loading && (
              <span className="text-xs text-gray-500 animate-pulse">
                thinking...
              </span>
            )}
          </div>
        </form>

        {result && (
          <div className="p-4">
            {result.intent === "query" && result.answer && (
              <div className="text-sm text-gray-200 leading-relaxed whitespace-pre-wrap">
                {result.answer}
              </div>
            )}
            {result.intent === "unclear" && result.clarification && (
              <div className="text-sm text-yellow-400">
                {result.clarification}
              </div>
            )}
            {result.intent === "action" && (
              <div className="text-sm text-emerald-400">
                Action triggered: {result.action_type}
              </div>
            )}
          </div>
        )}

        <div className="px-4 py-2 border-t border-[#30363d] flex justify-between text-xs text-gray-600">
          <span>Esc to close</span>
          <span>Enter to submit</span>
        </div>
      </div>
    </div>
  );
}
