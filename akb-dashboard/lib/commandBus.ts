// Decoupled communication channel between Action Queue cards and the
// CommandBar. Cards never import CommandBar; CommandBar never knows which
// card the user is on. They meet through this module.
//
//   - setHoveredCard / getHoveredCard: cards register themselves on mouse
//     enter / leave so a Cmd+K hotkey can resolve "the focused card."
//   - openCommandBar: the imperative "open the bar with this context now"
//     entry point (used by the Response card's Counter button).
//
// All state lives in module scope — fine for our single-tab dashboard.

const OPEN_EVENT = "akb:open-command-bar";

let hoveredRecordId: string | null = null;
let pendingDetail: OpenDetail = {};

export interface OpenDetail {
  contextRecordId?: string | null;
  prefill?: string;
}

export function setHoveredCard(id: string | null): void {
  hoveredRecordId = id;
}

export function getHoveredCard(): string | null {
  return hoveredRecordId;
}

export function openCommandBar(detail: OpenDetail = {}): void {
  pendingDetail = detail;
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(OPEN_EVENT));
  }
}

export function consumePendingDetail(): OpenDetail {
  const detail = pendingDetail;
  pendingDetail = {};
  return detail;
}

export const COMMAND_BAR_OPEN_EVENT = OPEN_EVENT;
