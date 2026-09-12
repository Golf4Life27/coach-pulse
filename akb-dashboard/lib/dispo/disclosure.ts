// DISPO LEGAL DISCLOSURE — the fixed text that rides on every buyer-facing
// surface (2026-09-12).
//
// WHY ITS OWN FILE: three consumers need the same words — the Gmail blast
// (lib/dispo/blast-email.ts), the package composer (lib/dispo/package.ts) and
// the public deal page (app/d/[recordId]) — and blast-email is itself imported
// BY the package composer. Putting the constants here keeps that a tree
// instead of a cycle.
//
// AKB is not the owner and not a broker: it holds an equitable interest under
// an executed purchase contract and is assigning that contract. Saying so in
// the same breath as the price is the difference between marketing an
// assignment (legal in TX/AL without a license) and brokering someone else's
// property (not). Plain ASCII on purpose — these strings end up in SMS
// bodies, where one curly quote forces UCS-2 (see lib/sms/gsm7.ts).

export const DISPO_DISCLOSURE =
  "AKB Solutions LLC is under contract to purchase this property and holds an " +
  "equitable interest in it. AKB is offering an assignment of its purchase " +
  "contract, not the property itself, and is not the owner and not a licensed " +
  "real estate broker. All information is believed accurate but must be " +
  "independently verified by the buyer. Proof of funds required before any " +
  "showing or assignment.";

export const DISPO_DISCLOSURE_SHORT =
  "Assignment of contract. AKB Solutions LLC holds an equitable interest and " +
  "is not the owner or a broker. Verify all info.";
