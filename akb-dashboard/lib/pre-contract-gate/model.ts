// PRE-CONTRACT GATE — nothing garbage reaches a contract (operator 2026-07-16,
// after 3123 Sunbeam went to a signed TREC contract at NEEDS_DATA, 0/12 DD,
// and a 65%-of-fantasy-list price that was really ~as-is retail). @agent: sentry
//
// THE FAILURE THIS CLOSES: the DD checklist sat in the deal room at 0/12 and
// nothing STOPPED contracting. A deal could reach a binding contract — and a
// wire — with no ARV, no rehab, no MAO, and no exit. This module is the gate:
// before a deal is marked under_contract (and before money moves), it must
// clear a checklist, priced against the RIGHT ceiling for its EXIT.
//
// ── THE ANTI-STRANGLE RULE (operator 2026-07-16) ──────────────────────────
// This is NOT "price ≤ flip-MAO or block." That single-lane thinking would
// strangle the creative deals that never pencil on the 70% rule. The gate is
// EXIT-AWARE: it asks "which exit, and does it pencil on THAT exit — or are
// you overriding with eyes open?" A deal underwater as a flip but great as a
// sub-to PASSES (exit=creative + your confirmation). And every hard check is
// WAIVABLE with a logged reason — the gate's job is that you're never
// SURPRISED, never that you're blocked. You always keep the override.
//
// PURE. No I/O — the route supplies the record's numbers + operator inputs.

export type ExitStrategy = "cash_flip" | "wholesale" | "rental" | "creative";

export const EXIT_LABELS: Record<ExitStrategy, string> = {
  cash_flip: "Cash flip (hold & resell)",
  wholesale: "Wholesale (assign the contract)",
  rental: "Rental / buy-and-hold",
  creative: "Creative (sub-to / seller finance / novation)",
};

export type CheckStatus = "pass" | "warn" | "fail";

export interface GateCheck {
  id: string;
  label: string;
  status: CheckStatus;
  /** A failing/warning check the operator may override with a logged reason. */
  waivable: boolean;
  /** True when a waiver is on record for this check. */
  waived: boolean;
  detail: string;
}

export type GateStatus = "clear" | "warn" | "waived" | "blocked";

export interface PreContractGate {
  status: GateStatus;
  checks: GateCheck[];
  headline: string;
  /** May this deal proceed to contract? False only when a hard check is failing
   *  AND un-waived. Warnings and waived fails do not block. */
  canContract: boolean;
  /** Count of un-waived hard failures (the blockers). */
  blockers: number;
}

export interface GateInput {
  contractPrice: number | null;
  arv: number | null;
  rehab: number | null;
  /** Dispo ceiling — what a cash buyer pays (decision-math Buyer_Ceiling). */
  buyerCeiling: number | null;
  /** Landlord-lane your-MAO (Your_MAO_V21) for the rental exit. */
  landlordMao: number | null;
  listPrice: number | null;
  /** Decision-math verdict: NEEDS_DATA / GO / TIGHT / PASS / HOLD_LOW_CONF. */
  decisionVerdict: string | null;
  /** DD checklist progress (the 12 items in the deal room). */
  ddDone: number;
  ddTotal: number;
  /** When the listing/market was last verified (ISO) — freshness for the
   *  "lists move" check (Sunbeam dropped $60k AFTER contracting). */
  lastVerifiedAt: string | null;
  /** Operator-selected exit; null = not chosen yet (a hard, non-waivable gate). */
  exit: ExitStrategy | null;
  /** Waived check ids → operator reason. A waiver is an eyes-open override. */
  waivers: Record<string, string>;
  /** Wholesale fee used for the cash-exit headroom (Your MAO = ceiling − fee). */
  wholesaleFee: number;
}

const DAY_MS = 86_400_000;
/** A market read older than this must be re-verified before contracting. */
export const MARKET_FRESH_DAYS = 10;

const pos = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

/** Evaluate the pre-contract gate for one deal. Pure. Order of checks is the
 *  order they render. */
export function evaluatePreContractGate(input: GateInput, nowIso: string): PreContractGate {
  const checks: GateCheck[] = [];
  const waived = (id: string) => Object.prototype.hasOwnProperty.call(input.waivers, id);

  // 1. Underwriting is real — the Sunbeam hole (contracted at NEEDS_DATA).
  {
    const missing: string[] = [];
    if (!pos(input.arv)) missing.push("ARV (run comps)");
    if (input.rehab == null) missing.push("rehab estimate");
    const needsData = (input.decisionVerdict ?? "").toUpperCase() === "NEEDS_DATA";
    const ok = missing.length === 0 && !needsData;
    checks.push({
      id: "underwriting_real",
      label: "Underwriting is real",
      status: ok ? "pass" : "fail",
      waivable: true,
      waived: waived("underwriting_real"),
      detail: ok
        ? `ARV ${usd(input.arv!)}, rehab ${usd(input.rehab!)} on record`
        : `Un-underwritten — missing ${missing.join(" + ") || "a verdict"}${needsData ? " (verdict NEEDS_DATA)" : ""}. No number should reach a contract un-checked.`,
    });
  }

  // 2. Exit selected — you must decide which game you're playing. NOT waivable:
  //    the whole point is you choose the exit consciously.
  {
    const ok = input.exit != null;
    checks.push({
      id: "exit_selected",
      label: "Exit strategy chosen",
      status: ok ? "pass" : "fail",
      waivable: false,
      waived: false,
      detail: ok
        ? `Exit: ${EXIT_LABELS[input.exit!]}`
        : "Pick your exit — cash flip / wholesale / rental / creative. The price ceiling depends on it.",
    });
  }

  // 3. Price within the ceiling FOR THAT EXIT (the anti-strangle core).
  checks.push(priceCheck(input));

  // 4. DD checklist cleared.
  {
    if (input.ddTotal <= 0) {
      checks.push({
        id: "dd_checklist",
        label: "Due-diligence checklist",
        status: "warn",
        waivable: true,
        waived: waived("dd_checklist"),
        detail: "No DD checklist configured for this deal.",
      });
    } else {
      const ok = input.ddDone >= input.ddTotal;
      checks.push({
        id: "dd_checklist",
        label: "Due-diligence checklist",
        status: ok ? "pass" : "fail",
        waivable: true,
        waived: waived("dd_checklist"),
        detail: ok
          ? `${input.ddDone}/${input.ddTotal} cleared`
          : `${input.ddDone}/${input.ddTotal} — verify condition + disclosures before you commit.`,
      });
    }
  }

  // 5. Market freshness — lists move (Sunbeam dropped $60k the day after
  //    contract). Force a re-verify; the gate can't know the new price, but it
  //    can make you look.
  {
    const now = Date.parse(nowIso);
    const seen = input.lastVerifiedAt ? Date.parse(input.lastVerifiedAt) : NaN;
    const ageDays = Number.isFinite(seen) ? Math.floor((now - seen) / DAY_MS) : null;
    const ok = ageDays != null && ageDays <= MARKET_FRESH_DAYS;
    checks.push({
      id: "market_fresh",
      label: "Current market re-verified",
      status: ok ? "pass" : "fail",
      waivable: true,
      waived: waived("market_fresh"),
      detail: ok
        ? `List/market verified ${ageDays}d ago`
        : `Re-verify the current list before contracting — lists move (Sunbeam cut $60k the day after contract). ${
            ageDays == null ? "Never verified." : `Last verified ${ageDays}d ago.`
          }`,
    });
  }

  return summarize(checks, input.exit);
}

/** The exit-aware price ceiling check. Cash exits price against Your MAO (buyer
 *  ceiling − fee); rental against the landlord MAO; creative is NOT judged on
 *  flip-MAO — it requires an eyes-open confirmation instead. */
function priceCheck(input: GateInput): GateCheck {
  const id = "price_within_ceiling";
  const w = Object.prototype.hasOwnProperty.call(input.waivers, id);
  const price = input.contractPrice;

  if (input.exit == null) {
    return { id, label: "Price within your ceiling", status: "fail", waivable: true, waived: w, detail: "Pick an exit to price the ceiling." };
  }

  if (input.exit === "creative") {
    // Creative lane is spec'd but not built — the system can't verify sub-to /
    // seller-finance / novation math. So it is NOT judged on flip-MAO; it
    // requires the operator to confirm the structure pencils on TERMS.
    return {
      id,
      label: "Creative structure confirmed",
      status: "fail",
      waivable: true,
      waived: w,
      detail:
        "Creative exit — not judged on flip-MAO. Confirm the structure pencils on terms (cash flow / loan balance / tenant-buyer spread), then waive to proceed. (Creative math not yet built — this is your call.)",
    };
  }

  if (!pos(price)) {
    return { id, label: "Price within your ceiling", status: "fail", waivable: true, waived: w, detail: "No contract price on record." };
  }

  if (input.exit === "rental") {
    if (!pos(input.landlordMao)) {
      return { id, label: "Price ≤ landlord MAO", status: "fail", waivable: true, waived: w, detail: "No landlord MAO computed — underwrite the rental lane first." };
    }
    const ok = price <= input.landlordMao;
    return {
      id,
      label: "Price ≤ landlord MAO",
      status: ok ? "pass" : "fail",
      waivable: true,
      waived: w,
      detail: ok
        ? `Price ${usd(price)} ≤ landlord MAO ${usd(input.landlordMao)}`
        : `Price ${usd(price)} is ABOVE your landlord MAO ${usd(input.landlordMao)} by ${usd(price - input.landlordMao)}.`,
    };
  }

  // cash_flip | wholesale → price ≤ Your MAO (buyer ceiling − fee).
  if (!pos(input.buyerCeiling)) {
    return { id, label: "Price ≤ your MAO", status: "fail", waivable: true, waived: w, detail: "No buyer ceiling computed — underwrite first." };
  }
  const yourMao = Math.round(input.buyerCeiling - input.wholesaleFee);
  if (price <= yourMao) {
    return {
      id,
      label: "Price ≤ your MAO",
      status: "pass",
      waivable: true,
      waived: w,
      detail: `Price ${usd(price)} ≤ your MAO ${usd(yourMao)} (buyer ceiling ${usd(input.buyerCeiling)} − fee ${usd(input.wholesaleFee)}). Spread intact.`,
    };
  }
  if (price <= input.buyerCeiling) {
    return {
      id,
      label: "Price ≤ your MAO",
      status: "warn",
      waivable: true,
      waived: w,
      detail: `Thin — price ${usd(price)} is above your MAO ${usd(yourMao)} but under the buyer ceiling ${usd(input.buyerCeiling)}. No fee room; you'd assign at cost.`,
    };
  }
  return {
    id,
    label: "Price ≤ your MAO",
    status: "fail",
    waivable: true,
    waived: w,
    detail: `UNDERWATER — price ${usd(price)} is ABOVE the buyer ceiling ${usd(input.buyerCeiling)} by ${usd(price - input.buyerCeiling)}. No cash buyer pays you this. (Sunbeam was here.)`,
  };
}

function summarize(checks: GateCheck[], exit: ExitStrategy | null): PreContractGate {
  const hardFails = checks.filter((c) => c.status === "fail");
  const blockers = hardFails.filter((c) => !(c.waivable && c.waived)).length;
  const anyWaived = checks.some((c) => c.status === "fail" && c.waivable && c.waived);
  const anyWarn = checks.some((c) => c.status === "warn" && !c.waived);

  let status: GateStatus;
  if (blockers > 0) status = "blocked";
  else if (anyWaived) status = "waived";
  else if (anyWarn) status = "warn";
  else status = "clear";

  const headline =
    status === "blocked"
      ? `🔴 Not ready to contract — ${blockers} blocker${blockers === 1 ? "" : "s"} to clear or waive`
      : status === "waived"
        ? `🟠 Proceeding with waivers — overrides on record, eyes open${exit ? ` (${EXIT_LABELS[exit]})` : ""}`
        : status === "warn"
          ? `🟡 Clear to contract, with cautions`
          : `🟢 Cleared to contract — underwritten, priced within your exit, DD done`;

  return { status, checks, headline, canContract: status !== "blocked", blockers };
}
