"use client";

import { useState, useEffect, useCallback } from "react";
import { showToast } from "@/components/Toast";

interface Task {
  id: string;
  title: string;
  dueDate: string | null;
  category: string | null;
  priority: string | null;
  status: string | null;
}

interface TaskBucket {
  label: string;
  description: string;
  tasks: Task[];
  accent: string;
  borderColor: string;
}

export default function SystemPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch("/api/tasks");
      if (!res.ok) throw new Error("API error");
      const data = await res.json();
      setTasks(data);
    } catch {
      showToast("Failed to fetch tasks.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const mustComplete = tasks.filter(
    (t) =>
      t.priority === "High" &&
      t.status !== "Done"
  );

  const wouldBeNice = tasks.filter(
    (t) =>
      t.priority === "Medium" &&
      t.status !== "Done"
  );

  const bigDreams = tasks.filter(
    (t) =>
      (t.priority === "Low" || (t.category && t.category.includes("Vision"))) &&
      t.status !== "Done"
  );

  const buckets: TaskBucket[] = [
    {
      label: "MUST COMPLETE",
      description: "High priority, not done",
      tasks: mustComplete,
      accent: "text-yellow-400",
      borderColor: "border-yellow-500",
    },
    {
      label: "WOULD BE NICE",
      description: "Medium priority, not done",
      tasks: wouldBeNice,
      accent: "text-amber-300",
      borderColor: "border-amber-400",
    },
    {
      label: "BIG DREAMS",
      description: "Low priority or Vision category",
      tasks: bigDreams,
      accent: "text-amber-200",
      borderColor: "border-amber-300/50",
    },
  ];

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-gray-400 animate-pulse">Loading tasks...</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-white">SYSTEM</h1>
        <button
          onClick={fetchData}
          className="text-xs bg-[#1c2128] border border-[#30363d] text-gray-300 px-3 py-1.5 rounded hover:bg-[#30363d] transition-colors"
        >
          Refresh
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {buckets.map((bucket) => (
          <div
            key={bucket.label}
            className={`bg-[#1c2128] rounded-lg border-t-2 ${bucket.borderColor} border border-[#30363d]`}
          >
            <div className="p-4 border-b border-[#30363d]">
              <h2 className={`text-sm font-bold ${bucket.accent} tracking-wider`}>
                {bucket.label}
              </h2>
              <p className="text-xs text-gray-500 mt-0.5">{bucket.description}</p>
              <span className={`text-lg font-bold ${bucket.accent}`}>
                {bucket.tasks.length}
              </span>
            </div>
            <div className="p-2 space-y-1 max-h-[60vh] overflow-y-auto">
              {bucket.tasks.length === 0 ? (
                <div className="text-center py-6 text-gray-600 text-xs">
                  No tasks
                </div>
              ) : (
                bucket.tasks.map((task) => (
                  <div
                    key={task.id}
                    className="bg-[#161b22] rounded p-3 hover:bg-[#1c2128] transition-colors"
                  >
                    <p className="text-sm text-white font-medium leading-snug">
                      {task.title}
                    </p>
                    <div className="flex gap-3 mt-1.5 text-xs text-gray-500">
                      {task.dueDate && (
                        <span>Due: {task.dueDate}</span>
                      )}
                      {task.category && (
                        <span className="px-1.5 py-0.5 rounded bg-[#30363d] text-gray-400">
                          {task.category}
                        </span>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
