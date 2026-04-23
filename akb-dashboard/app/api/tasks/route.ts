import { NextResponse } from "next/server";

const AIRTABLE_PAT = process.env.AIRTABLE_PAT!;
const BASE_ID = process.env.AIRTABLE_BASE_ID || "appp8inLAGTg4qpEZ";
const TASKS_TABLE = "tblH7QkBVz9KiuHIg";

export interface Task {
  id: string;
  title: string;
  dueDate: string | null;
  category: string | null;
  priority: string | null;
  status: string | null;
}

async function fetchTasks(): Promise<Task[]> {
  const allRecords: Task[] = [];
  let offset: string | undefined;

  do {
    const params = new URLSearchParams();
    if (offset) params.set("offset", offset);

    const url = `https://api.airtable.com/v0/${BASE_ID}/${TASKS_TABLE}?${params.toString()}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${AIRTABLE_PAT}` },
      cache: "no-store",
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Airtable error ${res.status}: ${errText}`);
    }

    const data = await res.json();
    for (const rec of data.records) {
      const f = rec.fields as Record<string, unknown>;
      allRecords.push({
        id: rec.id,
        title: (f.Title as string) ?? (f.Name as string) ?? "",
        dueDate: (f.Due_Date as string) ?? (f["Due Date"] as string) ?? null,
        category: (f.Category as string) ?? null,
        priority: (f.Priority as string) ?? null,
        status: (f.Status as string) ?? null,
      });
    }
    offset = data.offset;
  } while (offset);

  return allRecords;
}

export async function GET() {
  try {
    const tasks = await fetchTasks();
    return NextResponse.json(tasks);
  } catch (error) {
    console.error("Failed to fetch tasks:", error);
    return NextResponse.json(
      { error: "Failed to fetch tasks" },
      { status: 500 }
    );
  }
}
