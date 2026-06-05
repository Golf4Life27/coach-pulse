// Lower-of-two-lanes guard — Track 2 (2026-06-05).
// @agent: orchestrator
//
// When BOTH the landlord (rent-cap) lane AND the flipper (Buyer_Median)
// lane produce an operative Your_MAO, the gate MUST take the LOWER MAO.
// The more permissive lane never overrides a tighter ceiling. Per the
// operator: "Permissive lane can never override a tighter ceiling."
//
// Pure. Tested. No I/O.

export interface LaneMAO {
  lane: "landlord" | "flipper";
  status: "ok" | "hold" | "block";
  investorMao: number | null;
  yourMao: number | null;
  reason: string;
}

export type Lane = "landlord" | "flipper" | "neither";

export interface LowerLaneVerdict {
  operative: {
    lane: Lane;
    investorMao: number | null;
    yourMao: number | null;
  };
  /** When both lanes computed: |landlord.yourMao − flipper.yourMao|.
   *  null when fewer than two computed. */
  marginBetweenLanes: number | null;
  reason: string;
}

/** Pure: pick the lower-MAO lane. If only one lane computed, use it
 *  alone. If neither computed, return `neither` + null. Ties → landlord
 *  (deterministic; both are equally constraining at the tie). */
export function takeLowerMao(
  landlord: LaneMAO | null,
  flipper: LaneMAO | null,
): LowerLaneVerdict {
  const lOk = landlord?.status === "ok" && landlord.yourMao != null;
  const fOk = flipper?.status === "ok" && flipper.yourMao != null;

  if (lOk && fOk) {
    const lY = landlord!.yourMao!;
    const fY = flipper!.yourMao!;
    if (fY < lY) {
      return {
        operative: { lane: "flipper", investorMao: flipper!.investorMao, yourMao: fY },
        marginBetweenLanes: lY - fY,
        reason: `Flipper Your_MAO $${fY.toLocaleString()} < Landlord $${lY.toLocaleString()} — take the LOWER (flipper). Landlord lane would have been more permissive by $${(lY - fY).toLocaleString()} and is suppressed.`,
      };
    }
    // landlord ≤ flipper (ties → landlord, deterministic)
    return {
      operative: { lane: "landlord", investorMao: landlord!.investorMao, yourMao: lY },
      marginBetweenLanes: fY - lY,
      reason: `Landlord Your_MAO $${lY.toLocaleString()} ≤ Flipper $${fY.toLocaleString()} — take the LOWER (landlord). Flipper lane would have been more permissive by $${(fY - lY).toLocaleString()} and is suppressed.`,
    };
  }
  if (lOk) {
    return {
      operative: { lane: "landlord", investorMao: landlord!.investorMao, yourMao: landlord!.yourMao },
      marginBetweenLanes: null,
      reason: `Only landlord lane computed (flipper ${flipper?.status ?? "absent"}). Cannot cross-check against flipper ceiling; operative = landlord.`,
    };
  }
  if (fOk) {
    return {
      operative: { lane: "flipper", investorMao: flipper!.investorMao, yourMao: flipper!.yourMao },
      marginBetweenLanes: null,
      reason: `Only flipper lane computed (landlord ${landlord?.status ?? "absent"}). Cannot cross-check against landlord ceiling; operative = flipper.`,
    };
  }
  return {
    operative: { lane: "neither", investorMao: null, yourMao: null },
    marginBetweenLanes: null,
    reason: `Neither lane produced an operative MAO (landlord=${landlord?.status ?? "absent"}, flipper=${flipper?.status ?? "absent"}). HOLD.`,
  };
}
