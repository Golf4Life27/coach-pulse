// M6 — inbound-capture live gate. @agent: outreach
//
// DEFAULT-OFF (watched-first, same discipline as M1–M5). Gates EVERY
// inbound-capture write: the Unmatched_Replies catch-all, the webhook's
// listing notes/status append, and the Gmail poll append. OFF ⇒ compute the
// plan + audit it, write NOTHING (existing behavior unchanged). The operator
// flips INBOUND_CAPTURE_LIVE=true after reviewing the watched run.

export function isInboundCaptureLive(): boolean {
  return process.env.INBOUND_CAPTURE_LIVE === "true";
}
