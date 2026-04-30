"use client";

import { ConversationEntry } from "@/lib/notes";

interface Props {
  entries: ConversationEntry[];
  emptyMessage?: string;
}

export default function ConversationThread({ entries, emptyMessage }: Props) {
  if (entries.length === 0) {
    return (
      <div className="text-center text-gray-500 text-sm py-8">
        {emptyMessage ?? "No conversation history yet."}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {entries.map((entry, i) => {
        if (entry.type === "system") {
          return (
            <div
              key={i}
              className="text-center text-xs text-gray-500 py-1 px-3"
            >
              {entry.timestamp && (
                <span className="mr-2 opacity-60">{entry.timestamp}</span>
              )}
              {entry.text}
            </div>
          );
        }
        const isOutbound = entry.type === "outbound";
        return (
          <div
            key={i}
            className={`flex ${isOutbound ? "justify-end" : "justify-start"}`}
          >
            <div className="max-w-[80%]">
              <div
                className={`rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap ${
                  isOutbound
                    ? "bg-blue-600 text-white rounded-br-sm"
                    : "bg-[#30363d] text-gray-200 rounded-bl-sm"
                }`}
              >
                {entry.text}
              </div>
              {entry.timestamp && (
                <p
                  className={`text-[10px] text-gray-500 mt-1 ${
                    isOutbound ? "text-right" : ""
                  }`}
                >
                  {entry.timestamp}
                </p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
