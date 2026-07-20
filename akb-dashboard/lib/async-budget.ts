// Per-source time budgets for multi-source routes. @agent: maverick
//
// WHY (2026-07-20, the Canfield empty-thread 504): /api/conversations
// fetched siblings → Quo → Gmail SEQUENTIALLY; on a multi-listing agent
// with both phone and email on file the sum blew the 30s lambda budget,
// the route 504'd, and the client rendered the failure as "No conversation
// history. Send a text to start" — a false empty that caused a duplicate
// opener and an operator apology text. One slow source must never take
// down the sources that answered — it degrades, visibly.

/** Run a source under a time budget. On timeout OR rejection, resolve with
 *  the fallback and record the label in `degraded` so the caller can
 *  surface the gap (never a silent empty). A source that settles inside
 *  its budget is never flagged. The underlying promise is not cancelled —
 *  harmless in a lambda that ends at response time. */
export function withBudget<T>(
  p: Promise<T>,
  ms: number,
  fallback: T,
  label: string,
  degraded: string[],
): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      degraded.push(label);
      resolve(fallback);
    }, ms);
    p.then(
      (v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        degraded.push(label);
        resolve(fallback);
      },
    );
  });
}
