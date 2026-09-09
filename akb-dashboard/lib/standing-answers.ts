// Operator-approved standing answers — fixed text, sent verbatim, never
// composed or paraphrased by a model. A standing answer exists because the
// operator has already ruled on the exact words; the code's only job is to
// not drift from them.
//
// IDENTITY_QUESTION_STANDING_ANSWER — operator ruling 2026-09-09 (supersedes
// the 2026-09-08 v1 draft, which carried an em-dash that pushed the message
// out of GSM-7 and roughly doubled its billed SMS segments — see
// lib/sms/gsm7.ts). Answers "are you a wholesaler?" / "are you going to
// assign the contract?" (lib/reply-triage.ts classification
// "identity_question").
//
// Deliberate design, do not "fix" without a new operator ruling:
//   - Assignment is DISCLOSED on purpose. The operator's read: hiding it
//     invites a worse conversation later, when it surfaces on the closing
//     documents instead of in a text message.
//   - The answer proves performance (proof of funds, earnest money at the
//     agent's own title company, as-is, no repair requests, seller's
//     timeline) rather than arguing the wholesaler label. The label is not
//     the agent's actual concern; the performance is.
//   - It must NEVER claim a track record. AKB has closed zero deals to date
//     — any "we've done this before" phrasing would be a false claim.
//   - It must NEVER assert this agent's commission rate or amount. We have
//     not read their listing agreement: variable-rate and flat-minimum
//     commission clauses are both common, and post-NAR-settlement buyer-side
//     compensation is negotiated off-MLS, so any specific number or
//     percentage risks contradicting what the agent actually has on file.
//
// COPY THIS STRING EXACTLY, CHARACTER FOR CHARACTER, if it is ever moved.
// No em dash (U+2014), no en dash (U+2013), no curly quotes — plain ASCII
// hyphen and straight apostrophe only (GSM-7 safety; see lib/sms/gsm7.ts and
// the regression test in lib/standing-answers.test.ts).
export const IDENTITY_QUESTION_STANDING_ANSWER =
  "Yes - I buy with cash and I do assign some contracts to my buyer partners. Either way you're dealing with me: proof of funds up front, earnest money at your title company, as-is with no repair requests, and I close on your seller's timeline. And since I'm unrepresented, there's no buyer-side split coming out of your commission. Happy to send the POF over now.";
