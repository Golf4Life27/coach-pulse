// Pre-contract gate — per-deal evaluation + operator inputs. @agent: sentry
//
// GET  → the gate verdict for one record (reads the single-record Listing, so
//        it sees exitStrategy + waivers via the name map).
// PATCH → operator inputs: { exit } sets the exit strategy; { waive: {id,reason} }
//        logs an eyes-open override; { unwaive: id } removes one.
//
// The gate is a READOUT + a STOP surface — it never sends, signs, or advances a
// stage. It just decides whether a deal is ready to contract, priced against
// the ceiling for its chosen exit.

import { NextResponse } from "next/server";
import { getListing, updateListingRecord } from "@/lib/airtable";
import { evaluatePreContractGate, type ExitStrategy, type GateInput } from "@/lib/pre-contract-gate/model";

export const runtime = "nodejs";
export const maxDuration = 30;

const VALID_EXITS: ExitStrategy[] = ["cash_flip", "wholesale", "rental", "creative"];
const DD_TOTAL = 12; // the 12-item deal-room DD checklist

/** Tolerant DD progress read — the checklist may be a JSON array/object of
 *  completed items or an "n/12" string. Errs toward 0 (block) when unclear. */
function parseDdProgress(raw: unknown): { done: number; total: number } {
  if (raw == null) return { done: 0, total: DD_TOTAL };
  if (typeof raw === "string") {
    const s = raw.trim();
    const m = /(\d+)\s*\/\s*(\d+)/.exec(s);
    if (m) return { done: Number(m[1]), total: Number(m[2]) || DD_TOTAL };
    try {
      const parsed = JSON.parse(s);
      return parseDdProgress(parsed);
    } catch {
      return { done: 0, total: DD_TOTAL };
    }
  }
  if (Array.isArray(raw)) return { done: raw.filter(Boolean).length, total: DD_TOTAL };
  if (typeof raw === "object") {
    const done = Object.values(raw as Record<string, unknown>).filter(Boolean).length;
    return { done, total: DD_TOTAL };
  }
  return { done: 0, total: DD_TOTAL };
}

function parseWaivers(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "string" || !raw.trim()) return {};
  try {
    const p = JSON.parse(raw);
    if (p && typeof p === "object" && !Array.isArray(p)) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(p)) out[k] = String(v);
      return out;
    }
  } catch {
    /* malformed → no waivers */
  }
  return {};
}

async function gateFor(recordId: string) {
  const l = (await getListing(recordId, { fresh: true })) as Record<string, unknown> | null;
  if (!l) return null;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const dd = parseDdProgress(l.ddChecklist);
  const exitRaw = typeof l.exitStrategy === "string" ? l.exitStrategy : null;
  const input: GateInput = {
    contractPrice: num(l.contractOfferPrice),
    arv: num(l.realArvMedian),
    rehab: num(l.estRehab),
    buyerCeiling: num(l.buyerCeiling),
    landlordMao: num(l.yourMao),
    listPrice: num(l.listPrice),
    decisionVerdict: typeof l.decisionVerdict === "string" ? l.decisionVerdict : null,
    ddDone: dd.done,
    ddTotal: dd.total,
    lastVerifiedAt: typeof l.lastVerified === "string" ? l.lastVerified : null,
    exit: (VALID_EXITS as string[]).includes(exitRaw ?? "") ? (exitRaw as ExitStrategy) : null,
    waivers: parseWaivers(l.preContractWaivers),
    wholesaleFee: num(l.wholesaleFeeTarget) ?? 15_000,
  };
  const gate = evaluatePreContractGate(input, new Date().toISOString());
  return { gate, exit: input.exit, waivers: input.waivers, address: l.address ?? null };
}

export async function GET(_req: Request, { params }: { params: Promise<{ recordId: string }> }) {
  const { recordId } = await params;
  try {
    const res = await gateFor(recordId);
    if (!res) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json(res);
  } catch (err) {
    console.error("[pre-contract-gate] GET error:", err);
    return NextResponse.json({ error: "gate_failed", detail: String(err).slice(0, 200) }, { status: 500 });
  }
}

export async function PATCH(req: Request, { params }: { params: Promise<{ recordId: string }> }) {
  const { recordId } = await params;
  let body: { exit?: unknown; waive?: { id?: unknown; reason?: unknown }; unwaive?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_body" }, { status: 400 });
  }
  try {
    const fields: Record<string, unknown> = {};

    if (body.exit !== undefined) {
      const exit = String(body.exit);
      if (!(VALID_EXITS as string[]).includes(exit)) {
        return NextResponse.json({ error: "invalid_exit" }, { status: 400 });
      }
      fields.Exit_Strategy = exit;
    }

    if (body.waive || body.unwaive) {
      // Merge into the existing waiver map so overrides accumulate/log.
      const cur = (await getListing(recordId)) as Record<string, unknown> | null;
      const waivers = parseWaivers(cur?.preContractWaivers);
      if (body.waive && typeof body.waive.id === "string") {
        waivers[body.waive.id] = typeof body.waive.reason === "string" && body.waive.reason.trim() ? body.waive.reason.trim() : "waived by operator";
      }
      if (typeof body.unwaive === "string") delete waivers[body.unwaive];
      fields.Pre_Contract_Waivers = JSON.stringify(waivers);
    }

    if (Object.keys(fields).length === 0) {
      return NextResponse.json({ error: "nothing_to_update" }, { status: 400 });
    }
    await updateListingRecord(recordId, fields);
    const res = await gateFor(recordId);
    return NextResponse.json({ ok: true, ...res });
  } catch (err) {
    console.error("[pre-contract-gate] PATCH error:", err);
    return NextResponse.json({ error: "update_failed", detail: String(err).slice(0, 200) }, { status: 500 });
  }
}
