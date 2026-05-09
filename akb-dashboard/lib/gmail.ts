// Gmail integration stub.
//
// Server-side Gmail access requires OAuth credentials we don't yet have wired
// up (the foundation spec references the Gmail MCP, which is only available
// inside Claude Code, not at runtime). For now we return an empty array so
// the timeline-merge contract is satisfied; email content already lands in
// Listings_V1.Notes via the existing scan-replies pipeline and is parsed by
// lib/notes.parseConversation.
//
// When Gmail OAuth is added, implement getThreadsForEmail to fetch threads
// in the last `sinceMinutes` and shape them as GmailMessage[].

export interface GmailMessage {
  id: string;
  from: string;
  to: string;
  subject: string;
  body: string;
  date: string;
}

export async function getThreadsForEmail(
  _email: string,
  _sinceMinutes: number = 60 * 24 * 90,
): Promise<GmailMessage[]> {
  return [];
}
