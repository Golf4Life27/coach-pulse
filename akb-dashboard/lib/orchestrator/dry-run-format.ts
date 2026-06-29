// Human-readable rendering of a DryRunTrace (CONVEYOR Milestone 1).
// Plain text for a terminal; goal = a non-engineer understands "how far did
// this property get and what stopped it" in under a minute. Pure string work.

import type { DryRunTrace, GateTraceEntry, OpenerTrace } from "./dry-run-trace";

const usd = (n: number | null | undefined): string =>
  typeof n === "number" ? "$" + Math.round(n).toLocaleString() : "—";

const GLYPH: Record<string, string> = {
  pass: "✓",
  fail: "✗",
  data_missing: "⊘",
  warning: "⚠",
};

function line(width = 71): string {
  return "═".repeat(width);
}

function renderOpener(o: OpenerTrace): string {
  const rc = o.recomputed;
  const flags = [
    rc.arvDistrusted ? "ARV<list distrusted" : null,
    rc.flooredToFallback ? "floored→hold" : null,
    rc.cappedToList ? "capped to list" : null,
    rc.flagReseed ? "flag-reseed" : null,
  ].filter(Boolean);
  const storedOpener =
    o.stored.roughOpenerAmount != null
      ? `${usd(o.stored.roughOpenerAmount)} (${o.stored.openerBasis ?? "basis?"})`
      : "none (Rough_Opener_Amount blank)";
  return [
    " OPENER  (how this property is priced)",
    `   list price ......... ${usd(o.inputs.listPrice)}`,
    `   stored opener ...... ${storedOpener}`,
    `   stored MAO_V1 ...... ${usd(o.stored.mao_v1)}`,
    `   RECOMPUTE .......... ${usd(rc.opener)}   basis: ${rc.basisLabel}   [${rc.confidence}]${flags.length ? "  ⟨" + flags.join(", ") + "⟩" : ""}`,
    `     why: ${rc.detail}`,
    `     inputs: ARV ${usd(o.inputs.storedArv)} [${o.inputs.arvConfidence ?? "—"}] · rehab ${usd(o.inputs.estRehabMid ?? o.inputs.estRehab)} · ` +
      `buy-box ${o.inputs.arvPctMax ?? "n/a"} (${o.inputs.marketId ?? "no market"}) · anchor ${o.inputs.anchorPct} · seed MOCKED(null)`,
  ].join("\n");
}

function renderGate(idx: number, g: GateTraceEntry): string {
  const head =
    g.overall_status === "pass"
      ? `${idx} ✓ ${g.gate_id}`
      : g.overall_status === "fail"
        ? `${idx} ✗ ${g.gate_id}`
        : `${idx} ⊘ ${g.gate_id}`;
  const pad = head.padEnd(26);
  if (!g.reached) {
    return `   ${pad} (not reached — a prior gate did not pass)`;
  }
  const status = g.overall_status.toUpperCase().padEnd(5);
  const stop = g.stopped_by ? `  stopped by ${g.stopped_by.item_id} — ${g.stopped_by.reasoning}` : "";
  const lines = [`   ${pad} ${status}${stop}`];
  for (const it of g.items) {
    const glyph = GLYPH[it.status] ?? "?";
    const tag = it.blocking ? "[block]" : it.failure_action === "warn" ? "[warn] " : "[soft] ";
    lines.push(`        ${glyph} ${it.item_id} ${tag} ${it.reasoning}`);
  }
  return lines.join("\n");
}

export function formatTrace(t: DryRunTrace): string {
  const out: string[] = [];
  out.push(line());
  out.push(` DRY-RUN TRACE  ·  ${t.address ?? "(no address)"}`);
  out.push(
    ` record ${t.recordId}  ·  stage: ${t.current_stage ?? "—"}  ·  evaluated ${t.evaluatedAt}`,
  );
  out.push(line());
  out.push(
    ` SAFETY   external API calls: ${t.safety.fetch_calls_during_trace} (measured) · ` +
      `Airtable writes: ${t.safety.airtable_writes} · sends: ${t.safety.sends}`,
  );
  out.push(
    ` MOCKS    Quo/Gmail/CMA/Buyers empty · Firecrawl/RentCast/ATTOM not called · DocuSign unavailable`,
  );
  out.push("");
  out.push(renderOpener(t.opener));
  out.push("");
  out.push(" GATES  (live pipeline order)");
  t.gates.forEach((g, i) => out.push(renderGate(i + 1, g)));
  out.push("");
  out.push(` VERDICT  ${t.verdict}`);
  out.push(line());
  return out.join("\n");
}
