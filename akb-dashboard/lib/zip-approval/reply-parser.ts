// ZIP approval SMS reply parser (Workstream D1, item 5).
// @agent: scout
//
// Parses operator SMS replies to a "Approve [ZIP] in [Market]? Reply
// YES [ZIP] or NO [ZIP]" prompt. Strict-command style (distinct from
// the fuzzy outreach classifier in /api/scan-replies): the operator is
// answering a yes/no with an explicit ZIP, so we require both a decision
// token AND a 5-digit ZIP, and reject anything ambiguous.

export type ZipReplyDecision = "approve" | "reject";

export interface ParsedZipReply {
  decision: ZipReplyDecision;
  zip: string;
}

const APPROVE_RE = /\b(yes|y|approve[d]?|ok|okay|confirm)\b/i;
const REJECT_RE = /\b(no|n|reject[ed]?|deny|denied|pass|skip)\b/i;
const ZIP_RE = /\b(\d{5})\b/;

// Returns the parsed decision + ZIP, or null when the reply is not an
// unambiguous YES/NO with a ZIP. Ambiguous replies (both YES and NO
// tokens, or no ZIP) return null so the caller can leave the ZIP pending
// and surface it for manual handling rather than guessing.
export function parseZipApprovalReply(body: string): ParsedZipReply | null {
  if (typeof body !== "string") return null;
  const text = body.trim();
  if (!text) return null;

  const zipMatch = text.match(ZIP_RE);
  if (!zipMatch) return null;
  const zip = zipMatch[1];

  const hasApprove = APPROVE_RE.test(text);
  const hasReject = REJECT_RE.test(text);

  // Exactly one decision token must be present.
  if (hasApprove === hasReject) return null;

  return { decision: hasApprove ? "approve" : "reject", zip };
}
