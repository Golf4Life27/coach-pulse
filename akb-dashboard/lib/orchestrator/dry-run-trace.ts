// Single-property dry-run gate trace — CONVEYOR Milestone 1.
// @agent: sentry (read-only)
//
// THE POINT: walk ONE real listing through the EXISTING orchestrator gate
// logic + the EXISTING pricer, with EVERY external I/O mocked, producing a
// deterministic, human-readable report of how far the property gets and
// exactly which gate stops it — with ZERO Airtable writes and ZERO sends.
// This is the "is the pipeline alive" trace: a fix can finally be eyeballed
// before deploy instead of round-tripping through production.
//
// WHAT IT COMPOSES (does NOT reimplement pipeline logic):
//   - the five gates' check functions exported from ./*-checks.ts
//   - lib/opener-pricing.priceOpenerWithSeed (→ lib/per-market-pricer)
//   - lib/markets/registry.getMarketForListing (reads committed markets.json)
//
// WHAT IT DOES NOT DO:
//   - It does NOT call gate-runner.runGate(). runGate fetches live sources
//     (Quo/Gmail/RentCast/Airtable) AND writes a KV audit entry — both
//     forbidden here. Instead this file MIRRORS gate-runner.ts steps 4–5
//     (run checks against a pre-built context + compose status), keeping the
//     audit write and the live fetch OUT. The mirrored block is marked
//     "MIRRORS gate-runner.ts" — if that file's status logic changes, change
//     evaluateGateChecks() too (the smoke test pins the shared decisions).
//   - It imports NO network/write/send client. The whole trace is
//     synchronous, so proveNoNetwork() can MEASURE that zero fetch() calls
//     happen during a run (not merely assert it).
//
// Externals are mocked to deterministic, benign defaults (empty threads /
// empty CMA / live-listing derived from the record / no DocuSign). A gate
// that needs live evidence an empty mock can't supply surfaces data_missing
// — that is the gate honestly saying "I need live X", not a harness bug.

import type {
  CheckFn,
  CheckResult,
  DataSource,
  Gate,
  GateContext,
  GateRunResult,
  LiveListingSnapshot,
  PipelineStage,
} from "./types";
import type { Listing } from "@/lib/types";
import {
  PRE_OUTREACH_GATE,
  PRE_OUTREACH_CHECKS,
  PRE_OUTREACH_CONFIG,
} from "./pre-outreach-checks";
import {
  PRE_SEND_GATE,
  PRE_SEND_CHECKS,
  PRE_SEND_CONFIG,
} from "./pre-send-checks";
import {
  PRE_NEGOTIATION_GATE,
  PRE_NEGOTIATION_CHECKS,
  PRE_NEGOTIATION_CONFIG,
} from "./pre-negotiation-checks";
import {
  PRE_CONTRACT_GATE,
  PRE_CONTRACT_CHECKS,
  PRE_CONTRACT_CONFIG,
} from "./pre-contract-checks";
import { PRE_EMD_GATE, PRE_EMD_CHECKS, PRE_EMD_CONFIG } from "./pre-emd-checks";
import { priceOpenerWithSeed } from "@/lib/opener-pricing";
import { getMarketForListing } from "@/lib/markets/registry";

// ── Gate sequence (live pipeline order, AKB_Deal_Flow_Orchestrator_Spec) ──
interface GateSpec {
  gate: Gate;
  checks: Record<string, CheckFn>;
  config: Record<string, unknown>;
}
export const GATE_SEQUENCE: GateSpec[] = [
  { gate: PRE_OUTREACH_GATE, checks: PRE_OUTREACH_CHECKS, config: PRE_OUTREACH_CONFIG },
  { gate: PRE_SEND_GATE, checks: PRE_SEND_CHECKS, config: PRE_SEND_CONFIG },
  { gate: PRE_NEGOTIATION_GATE, checks: PRE_NEGOTIATION_CHECKS, config: PRE_NEGOTIATION_CONFIG },
  { gate: PRE_CONTRACT_GATE, checks: PRE_CONTRACT_CHECKS, config: PRE_CONTRACT_CONFIG },
  { gate: PRE_EMD_GATE, checks: PRE_EMD_CHECKS, config: PRE_EMD_CONFIG },
];

// ── Mocked external snapshots ──────────────────────────────────────────
/** Per-source overrides for the GateContext. Anything omitted falls to a
 *  deterministic benign default (see buildDryRunContext). `pa_document`
 *  defaults to UNAVAILABLE — mirroring production, where the DocuSign fetch
 *  is unwired in Phase 1 and its dependent items resolve to data_missing. */
export interface DryRunMocks {
  quoThread?: GateContext["quoThread"];
  gmailThread?: GateContext["gmailThread"];
  liveListing?: GateContext["liveListing"];
  cma?: GateContext["cma"];
  paDocument?: GateContext["paDocument"];
  buyerPipeline?: GateContext["buyerPipeline"];
  propertyIntel?: GateContext["propertyIntel"];
  deal?: GateContext["deal"];
  auditLog?: GateContext["auditLog"];
  /** Sources treated as "could not fetch" → their items short-circuit to
   *  data_missing without invoking the check (spec §6, gate-runner.ts:119).
   *  Default: {"pa_document"}. */
  unavailableSources?: DataSource[];
}

/** A live-listing snapshot DERIVED from the record (no network) — Phase-1
 *  parity with gate-runner.ts fetchSource("live_listing"). */
function deriveLiveListing(listing: Listing | null): LiveListingSnapshot | null {
  if (!listing) return null;
  return {
    listingType: null,
    listingStatus: listing.liveStatus ?? null,
    lastSeenDate: listing.lastVerified ?? null,
    listPrice: listing.listPrice,
    photoUrls: [],
  };
}

/** Build the GateContext from a record + mocks. Pure; no I/O. */
export function buildDryRunContext(
  recordId: string,
  listing: Listing | null,
  mocks: DryRunMocks = {},
): { ctx: GateContext; fetchErrors: Partial<Record<DataSource, string>> } {
  const ctx: GateContext = {
    recordId,
    listing,
    auditLog: mocks.auditLog ?? [],
    quoThread: mocks.quoThread ?? [],
    gmailThread: mocks.gmailThread ?? [],
    liveListing: mocks.liveListing ?? deriveLiveListing(listing),
    cma: mocks.cma ?? [],
    paDocument: mocks.paDocument ?? null,
    buyerPipeline: mocks.buyerPipeline ?? [],
    propertyIntel: mocks.propertyIntel ?? null,
    deal: mocks.deal ?? null,
  };
  const unavailable = mocks.unavailableSources ?? ["pa_document"];
  const fetchErrors: Partial<Record<DataSource, string>> = {};
  for (const s of unavailable) {
    fetchErrors[s] =
      s === "pa_document"
        ? "dry-run: DocuSign/pa_document is unwired in production (Phase 1) — not fetched"
        : "dry-run: source not provided (no live fetch)";
  }
  return { ctx, fetchErrors };
}

// ── Gate evaluation — MIRRORS gate-runner.ts steps 4–5 (no fetch, no audit) ──
// Keep this in lockstep with lib/orchestrator/gate-runner.ts runGate(): the
// item loop (incl. the missing-check-fn and fetchError short-circuits), the
// blocker/warning/data_missing tally, and the overall_status rule
// (data_missing on a BLOCKING item is treated as fail; no listing →
// incomplete). dry-run-trace.test.ts pins the resulting decisions.
export function evaluateGateChecks(input: {
  gate: Gate;
  ctx: GateContext;
  checks: Record<string, CheckFn>;
  config: Record<string, unknown>;
  fetchErrors?: Partial<Record<DataSource, string>>;
  now?: Date;
}): GateRunResult {
  const t0 = Date.now();
  const { gate, ctx, checks, config } = input;
  const fetchErrors = input.fetchErrors ?? {};

  const results: CheckResult[] = [];
  for (const item of gate.items) {
    const checkFn = checks[item.id];
    if (!checkFn) {
      results.push({
        item_id: item.id,
        status: "data_missing",
        reasoning: `No check function registered for item ${item.id}. Gate config + check map mismatch.`,
        data_examined: { error: "missing_check_fn" },
        failure_action: item.failure_action,
      });
      continue;
    }
    const missingSources = item.data_sources.filter((s) => fetchErrors[s] != null);
    if (missingSources.length > 0) {
      results.push({
        item_id: item.id,
        status: "data_missing",
        reasoning: `Required data source(s) not available in dry-run: ${missingSources.join(", ")}`,
        data_examined: {
          missing_sources: missingSources,
          fetch_errors: Object.fromEntries(missingSources.map((s) => [s, fetchErrors[s] ?? "unknown"])),
        },
        failure_action: item.failure_action,
      });
      continue;
    }
    try {
      results.push(checkFn(ctx, config));
    } catch (err) {
      results.push({
        item_id: item.id,
        status: "data_missing",
        reasoning: `Check function threw: ${String(err)}`,
        data_examined: { error: String(err) },
        failure_action: item.failure_action,
      });
    }
  }

  const blockers: string[] = [];
  const warnings: string[] = [];
  const dataMissing: string[] = [];
  for (const r of results) {
    if (r.status === "fail") blockers.push(r.item_id);
    else if (r.status === "warning") warnings.push(r.item_id);
    else if (r.status === "data_missing") dataMissing.push(r.item_id);
  }
  const blockingDataMissing = results.filter(
    (r) => r.status === "data_missing" && gate.items.find((i) => i.id === r.item_id)?.blocking,
  );
  const hardBlocked = blockers.length > 0 || blockingDataMissing.length > 0;
  const overall_status: "pass" | "fail" | "incomplete" = !ctx.listing
    ? "incomplete"
    : hardBlocked
      ? "fail"
      : "pass";

  return {
    gate_id: gate.id,
    recordId: ctx.recordId,
    stage_from: gate.stage_from,
    stage_to: gate.stage_to,
    current_stage: (ctx.listing?.pipelineStage as PipelineStage | null | undefined) ?? null,
    overall_status,
    results,
    blockers,
    warnings,
    data_missing: dataMissing,
    property_address: ctx.listing?.address,
    computed_at: (input.now ?? new Date()).toISOString(),
    elapsed_ms: Date.now() - t0,
  };
}

// ── Opener pricing (read-only; composes the live priceOpenerWithSeed) ──────
export interface OpenerTrace {
  /** What is CURRENTLY on the record (read-only). */
  stored: {
    roughOpenerAmount: number | null;
    openerBasis: string | null;
    mao_v1: number | null;
  };
  /** What priceOpenerWithSeed produces from the record's inputs RIGHT NOW.
   *  Seed + anchor are MOCKED (no KV / no Airtable read) — see inputs. */
  recomputed: {
    opener: number | null;
    basis: string;
    basisLabel: string;
    confidence: string;
    arvSource: string;
    arvUsed: number | null;
    ceiling: number | null;
    anchorPct: number | null;
    cappedToList: boolean;
    arvDistrusted: boolean;
    flooredToFallback: boolean;
    flagReseed: boolean;
    detail: string;
  };
  inputs: {
    listPrice: number | null;
    storedArv: number | null;
    arvConfidence: string | null;
    estRehabMid: number | null;
    estRehab: number | null;
    sqft: number | null;
    arvPctMax: number | null;
    wholesaleFee: number | null;
    anchorPct: number | null;
    marketId: string | null;
    seed: "MOCKED(null) — live path reads ZIP_ARV_Seed (Airtable)";
  };
}

/** Default dry-run anchor. The live path resolves a per-market anchor from
 *  Vercel KV (lib/markets/anchor.resolveAnchorPct); reading it is external
 *  I/O, so the dry-run pins the launch default (0.90, Detroit at launch) and
 *  labels it. The anchor only affects the ARV buy-box path. */
export const DRY_RUN_ANCHOR_PCT = 0.9;

export function traceOpener(listing: Listing): OpenerTrace {
  const market = getMarketForListing({ state: listing.state, zip: listing.zip });
  const arvPctMax = market?.buyer_params?.arv_pct_max ?? null;
  const inputs = {
    listPrice: listing.listPrice ?? null,
    storedArv: listing.realArvMedian ?? null,
    arvConfidence: listing.arvConfidence ?? null,
    estRehabMid: listing.estRehabMid ?? null,
    estRehab: listing.estRehab ?? null,
    sqft: listing.buildingSqFt ?? null,
    arvPctMax,
    wholesaleFee: listing.wholesaleFeeTarget ?? null,
    anchorPct: DRY_RUN_ANCHOR_PCT,
    marketId: market?.id ?? null,
    seed: "MOCKED(null) — live path reads ZIP_ARV_Seed (Airtable)" as const,
  };
  const priced = priceOpenerWithSeed({
    listPrice: inputs.listPrice,
    storedArv: inputs.storedArv,
    storedArvConfidence: listing.arvConfidence ?? null,
    estRehabMid: inputs.estRehabMid,
    estRehab: inputs.estRehab,
    sqft: inputs.sqft,
    arvPctMax: inputs.arvPctMax,
    wholesaleFee: inputs.wholesaleFee,
    anchorPct: inputs.anchorPct,
    seed: null, // MOCKED — no Airtable ZIP_ARV_Seed read.
  });
  const r = priced.result;
  return {
    stored: {
      roughOpenerAmount: (listing as { roughOpenerAmount?: number | null }).roughOpenerAmount ?? null,
      openerBasis: (listing as { openerBasis?: string | null }).openerBasis ?? null,
      mao_v1: listing.mao ?? null,
    },
    recomputed: {
      opener: r.opener,
      basis: r.basis,
      basisLabel: priced.basisLabel,
      confidence: r.confidence,
      arvSource: priced.arvSource,
      arvUsed: priced.arvUsed,
      ceiling: r.ceiling,
      anchorPct: r.anchorPct,
      cappedToList: r.cappedToList,
      arvDistrusted: r.arvDistrusted,
      flooredToFallback: r.flooredToFallback,
      flagReseed: r.flagReseed,
      detail: r.detail,
    },
    inputs,
  };
}

// ── Full trace ─────────────────────────────────────────────────────────
export interface GateTraceEntry {
  gate_id: string;
  stage_from: PipelineStage | null;
  stage_to: PipelineStage;
  overall_status: "pass" | "fail" | "incomplete";
  reached: boolean;
  /** First failing item (id + reason) on this gate, if any. */
  stopped_by: { item_id: string; status: string; reasoning: string } | null;
  items: Array<{
    item_id: string;
    status: string;
    blocking: boolean;
    failure_action: string;
    reasoning: string;
  }>;
  blockers: string[];
  warnings: string[];
  data_missing: string[];
}

export interface DryRunTrace {
  recordId: string;
  address: string | null;
  current_stage: string | null;
  evaluatedAt: string;
  /** What each external source was mocked to (transparency). */
  mock_state: Record<string, string>;
  gates: GateTraceEntry[];
  opener: OpenerTrace;
  /** One-line verdict: "reaches gate X, stopped by Y". */
  verdict: string;
  /** Proof of safety — MEASURED during the (synchronous) run. */
  safety: {
    fetch_calls_during_trace: number;
    airtable_writes: number;
    sends: number;
    note: string;
  };
}

/** The first item (in checklist order) that blocks the gate — a hard fail,
 *  or a data_missing on a BLOCKING item (spec §6 treats that as a block). */
function firstStop(res: GateRunResult, gate: Gate): GateTraceEntry["stopped_by"] {
  const blockingIds = new Set(gate.items.filter((i) => i.blocking).map((i) => i.id));
  const stop = res.results.find(
    (r) => r.status === "fail" || (r.status === "data_missing" && blockingIds.has(r.item_id)),
  );
  return stop ? { item_id: stop.item_id, status: stop.status, reasoning: stop.reasoning } : null;
}

export interface TraceInput {
  recordId: string;
  listing: Listing | null;
  mocks?: DryRunMocks;
  /** Pin "now" for deterministic age-relative checks (e.g. PO-02 freshness).
   *  Note: the gate checks read the real Date.now(); pass a frozen clock in
   *  tests (vi.setSystemTime) for determinism. This value is only recorded
   *  in the trace as evaluatedAt. */
  now?: Date;
}

/** Run the whole dry-run trace. SYNCHRONOUS by construction → proveNoNetwork
 *  can measure that zero fetch() calls occur. */
export function traceListing(input: TraceInput): DryRunTrace {
  const { recordId, listing } = input;
  const now = input.now ?? new Date();
  const mocks = input.mocks ?? {};
  const { ctx, fetchErrors } = buildDryRunContext(recordId, listing, mocks);

  const { value: result, fetchCalls } = proveNoNetwork(() => {
    const gates: GateTraceEntry[] = [];
    let stoppedAlready = false;
    for (const spec of GATE_SEQUENCE) {
      const res = evaluateGateChecks({
        gate: spec.gate,
        ctx,
        checks: spec.checks,
        config: spec.config,
        fetchErrors,
        now,
      });
      const reached = !stoppedAlready;
      const itemsById = new Map(spec.gate.items.map((i) => [i.id, i]));
      gates.push({
        gate_id: res.gate_id,
        stage_from: res.stage_from,
        stage_to: res.stage_to,
        overall_status: res.overall_status,
        reached,
        stopped_by: firstStop(res, spec.gate),
        items: res.results.map((r) => ({
          item_id: r.item_id,
          status: r.status,
          blocking: itemsById.get(r.item_id)?.blocking ?? false,
          failure_action: r.failure_action,
          reasoning: r.reasoning,
        })),
        blockers: res.blockers,
        warnings: res.warnings,
        data_missing: res.data_missing,
      });
      if (res.overall_status !== "pass") stoppedAlready = true;
    }
    const opener = traceOpener(listing ?? ({} as Listing));
    return { gates, opener };
  });

  const stopped = result.gates.find((g) => g.overall_status !== "pass");
  const verdict = !listing
    ? `record ${recordId} not loaded — cannot trace`
    : stopped
      ? `reaches ${stopped.gate_id}, stopped by ${stopped.stopped_by?.item_id ?? "?"}` +
        (stopped.stopped_by ? ` (${stopped.stopped_by.reasoning})` : "")
      : `passes all ${GATE_SEQUENCE.length} gates — would be send-ready (but sends remain hard-disabled: H2_OUTREACH_HARD_DISABLE)`;

  return {
    recordId,
    address: listing?.address ?? null,
    current_stage: (listing?.pipelineStage as string | null | undefined) ?? null,
    evaluatedAt: now.toISOString(),
    mock_state: {
      quo_thread: mocks.quoThread ? "caller-provided" : "MOCKED empty []",
      gmail_thread: mocks.gmailThread ? "caller-provided" : "MOCKED empty []",
      live_listing: mocks.liveListing ? "caller-provided" : "DERIVED from record (no scrape)",
      cma: mocks.cma ? "caller-provided" : "MOCKED empty [] (RentCast not called)",
      pa_document: "UNAVAILABLE (DocuSign unwired in prod Phase 1)",
      buyer_pipeline: mocks.buyerPipeline ? "caller-provided" : "MOCKED empty []",
      property_intel: mocks.propertyIntel ? "caller-provided" : "MOCKED null",
      airtable_deal: mocks.deal ? "caller-provided" : "MOCKED null",
      firecrawl_rentcast_attom: "NOT CALLED (no live external I/O)",
    },
    gates: result.gates,
    opener: result.opener,
    verdict,
    safety: {
      fetch_calls_during_trace: fetchCalls,
      airtable_writes: 0,
      sends: 0,
      note:
        "fetch_calls measured by wrapping globalThis.fetch for the synchronous run. " +
        "airtable_writes/sends are 0 by construction: this module imports no write/send client.",
    },
  };
}

/** Run `fn` with globalThis.fetch wrapped by a counter, restoring it after.
 *  Because traceListing is fully synchronous, a non-zero count is proof of a
 *  leak. Returns the function's value plus the measured fetch-call count. */
export function proveNoNetwork<T>(fn: () => T): { value: T; fetchCalls: number } {
  const g = globalThis as { fetch?: (...a: unknown[]) => unknown };
  const original = g.fetch;
  let fetchCalls = 0;
  if (typeof original === "function") {
    g.fetch = (...args: unknown[]) => {
      fetchCalls++;
      return (original as (...a: unknown[]) => unknown)(...args);
    };
  }
  try {
    const value = fn();
    return { value, fetchCalls };
  } finally {
    if (typeof original === "function") g.fetch = original;
  }
}
