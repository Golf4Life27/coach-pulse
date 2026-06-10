// BUTTONS ARE THE DECISIONS (operator review 6/10, ruling 2): each card's
// stated options become its buttons. Generic verbs only when the card
// genuinely has no specific options.
//
// Options are derived from the Action_Required prose. A chosen option is
// RECORDED (the item resolves with the choice shown); executing it — the
// actual text/offer — still happens in the Deal Room / v1 until ops ships a
// decision-capture write (backend request #7 extension).

import type { OperatorItem } from "./types";

export interface DecisionOption {
  label: string;
  /** record  = resolve the item, noting the chosen label
   *  later   = defer
   *  open    = navigate to the Deal Room (no status change) */
  kind: "record" | "later" | "open";
  /** true when derived from the card's own prose (vs generic fallback). */
  specific: boolean;
}

function clean(s: string): string {
  return s
    .replace(/[.;,]+$/, "")
    .replace(/^\s*(to|either)\s+/i, "")
    .trim();
}

function cap(s: string, n = 28): string {
  const t = s.charAt(0).toUpperCase() + s.slice(1);
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

export function deriveDecisions(item: OperatorItem): DecisionOption[] {
  const text = item.actionRequired ?? "";
  const opts: DecisionOption[] = [];

  // "decide whether to X or Y" / "either X or Y" → [X] [Y]
  const either = text.match(/(?:whether to|either)\s+(.+?)\s+or\s+(.+?)(?:[.;]|$)/i);
  if (either) {
    opts.push(
      { label: cap(clean(either[1])), kind: "record", specific: true },
      { label: cap(clean(either[2])), kind: "record", specific: true },
    );
  }

  // "confirm dead" cards → [Confirm dead] [Reopen]
  if (opts.length === 0 && /confirm\s+dead|mark\s+dead/i.test(text)) {
    opts.push(
      { label: "Confirm dead", kind: "record", specific: true },
      { label: "Reopen", kind: "open", specific: true },
    );
  }

  // re-offer with a number range → [Re-offer $X–$Y] [Release]
  if (opts.length === 0) {
    const reoffer = text.match(/re-?offer\s*(\$[\d,k.]+\s*[-–]\s*\$?[\d,k.]+|\$[\d,k.]+)?/i);
    if (reoffer) {
      opts.push(
        { label: cap(`Re-offer${reoffer[1] ? ` ${reoffer[1].replace(/\s/g, "")}` : ""}`), kind: "record", specific: true },
        { label: "Release", kind: "record", specific: true },
      );
    }
  }

  // Genuinely no stated options → generic.
  if (opts.length === 0) {
    opts.push({ label: "Done", kind: "record", specific: false });
  }

  opts.push({ label: "Later", kind: "later", specific: false });
  return opts;
}
