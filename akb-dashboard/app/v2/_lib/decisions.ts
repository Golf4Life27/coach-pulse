// BUTTONS ARE THE DECISIONS (ruling 6/10) + STRANGER TEST (round-2): each
// card's stated options become its buttons, every label parses without the
// system's vocabulary, and any button whose effect isn't obvious carries a
// one-line consequence. decisions.ts also marks Maverick's recommended
// option so the renderer can light it up (round-2 rule 3).
//
// A chosen option is RECORDED (the item resolves with the choice shown);
// executing it — the actual text/offer — happens on the deal page until ops
// ships the Decision_Taken capture (request #7b).

import type { OperatorItem } from "./types";

export interface DecisionOption {
  label: string;
  /** Shown small under the label when the effect isn't obvious. */
  consequence?: string;
  /** record  = resolve the item, noting the chosen label
   *  later   = defer
   *  open    = navigate to the deal page (no status change) */
  kind: "record" | "later" | "open";
  /** true when derived from the card's own prose (vs generic fallback). */
  specific: boolean;
  /** Maverick's recommended option — renderer highlights exactly one. */
  recommended?: boolean;
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

const NOT_NOW: DecisionOption = {
  label: "Not now",
  consequence: "stays in the queue",
  kind: "later",
  specific: false,
};

export function deriveDecisions(item: OperatorItem): DecisionOption[] {
  const text = item.actionRequired ?? "";
  const opts: DecisionOption[] = [];

  // "decide whether to X or Y" / "either X or Y" → [X] [Y].
  // The first stated option is Maverick's recommendation (the prose leads
  // with what it wants done).
  const either = text.match(/(?:whether to|either)\s+(.+?)\s+or\s+(.+?)(?:[.;]|$)/i);
  if (either) {
    opts.push(
      {
        label: cap(clean(either[1])),
        consequence: "records the decision and clears the card",
        kind: "record",
        specific: true,
        recommended: true,
      },
      {
        label: cap(clean(either[2])),
        consequence: "records the decision and clears the card",
        kind: "record",
        specific: true,
      },
    );
  }

  // "confirm dead" cards → [Confirm dead] [Reopen].
  if (opts.length === 0 && /confirm\s+dead|mark\s+dead/i.test(text)) {
    opts.push(
      {
        label: "Confirm dead",
        consequence: "stays dead; clears the card",
        kind: "record",
        specific: true,
        recommended: true,
      },
      {
        label: "Reopen",
        consequence: "opens the deal page",
        kind: "open",
        specific: true,
      },
    );
  }

  // re-offer with a number range → [Re-offer $X–$Y] [Let it go].
  if (opts.length === 0) {
    const reoffer = text.match(/re-?offer\s*(\$[\d,k.]+\s*[-–]\s*\$?[\d,k.]+|\$[\d,k.]+)?/i);
    if (reoffer) {
      opts.push(
        {
          label: cap(`Re-offer${reoffer[1] ? ` ${reoffer[1].replace(/\s/g, "")}` : ""}`),
          consequence: "records the decision; send it from the deal page",
          kind: "record",
          specific: true,
          recommended: true,
        },
        {
          label: "Let it go",
          consequence: "records the pass and clears the card",
          kind: "record",
          specific: true,
        },
      );
    }
  }

  // Genuinely no stated options → generic, nothing lit.
  if (opts.length === 0) {
    opts.push({
      label: "Done",
      consequence: "clears this card",
      kind: "record",
      specific: false,
    });
  }

  opts.push(NOT_NOW);
  return opts;
}
