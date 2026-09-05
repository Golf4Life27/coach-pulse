// CONTRACT LIFECYCLE — the "we are under contract" write (2026-09-05).
//
// Until this existed, Contract_Executed_At had NO code writer: the operator
// typed dates into Airtable by hand and nothing downstream noticed. This is
// the pure half of the trigger the dispo engine listens for. One operator
// action ("Mark contract executed" on the pipeline page) computes every
// clock the back half runs on:
//
//   Contract_Executed_At  = executedAt (date)
//   Option_Deadline       = executedAt + optionDays   (default 10 — every
//                           contract keeps the 10-day option, EMD-cap rule)
//   EMD_Due_At            = executedAt + 3 days
//   Close_Date            = executedAt + closeDays    (default 21)
//   Contract_Offer_Price  = contractPrice
//   Assignment_Price      = assignmentPrice ?? contractPrice + DEFAULT_ASSIGNMENT_MARKUP
//
// Pure. No I/O. The route validates auth + record existence and writes.

export const DEFAULT_OPTION_DAYS = 10;
export const DEFAULT_CLOSE_DAYS = 21;
export const DEFAULT_EMD_DAYS = 3;
/** Default assignment markup over contract when the operator gives no
 *  assignment price. $10K clears the $5K wholesale-fee floor with room. */
export const DEFAULT_ASSIGNMENT_MARKUP = 10_000;

export interface ContractExecutedInput {
  contractPrice: number | null | undefined;
  /** ISO date or datetime. Defaults to `now`. */
  executedAt?: string | null;
  assignmentPrice?: number | null;
  optionDays?: number | null;
  closeDays?: number | null;
}

export interface ContractExecutedFields {
  Contract_Executed_At: string;
  Option_Deadline: string;
  EMD_Due_At: string;
  Close_Date: string;
  Contract_Offer_Price: number;
  Assignment_Price: number;
}

export type ContractExecutedResult =
  | { ok: true; fields: ContractExecutedFields; summary: string }
  | { ok: false; error: string };

function positive(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

/** YYYY-MM-DD in UTC — the Airtable date-field wire format. */
export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, days: number): Date {
  const out = new Date(d.getTime());
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}

function parseExecutedAt(raw: string | null | undefined, now: Date): Date | null {
  if (!raw) return now;
  const s = raw.trim();
  // A bare date must not drift a day on timezone parsing — pin to UTC noon.
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T12:00:00Z`) : new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function daysOrDefault(raw: number | null | undefined, dflt: number, max: number): number | null {
  if (raw == null) return dflt;
  if (!Number.isFinite(raw) || raw < 0 || raw > max) return null;
  return Math.round(raw);
}

export function contractExecutedFields(
  input: ContractExecutedInput,
  now: Date = new Date(),
): ContractExecutedResult {
  if (!positive(input.contractPrice)) {
    return { ok: false, error: "contractPrice must be a positive number" };
  }
  const executedAt = parseExecutedAt(input.executedAt, now);
  if (!executedAt) return { ok: false, error: "executedAt is not a valid date" };
  // A contract can't execute more than 7 days in the future.
  if (executedAt.getTime() - now.getTime() > 7 * 86_400_000) {
    return { ok: false, error: "executedAt is more than 7 days in the future" };
  }
  const optionDays = daysOrDefault(input.optionDays, DEFAULT_OPTION_DAYS, 60);
  if (optionDays == null) return { ok: false, error: "optionDays must be 0–60" };
  const closeDays = daysOrDefault(input.closeDays, DEFAULT_CLOSE_DAYS, 120);
  if (closeDays == null) return { ok: false, error: "closeDays must be 0–120" };
  if (closeDays < optionDays) {
    return { ok: false, error: "closeDays must be at least optionDays" };
  }

  const contractPrice = Math.round(input.contractPrice);
  let assignmentPrice: number;
  if (input.assignmentPrice == null) {
    assignmentPrice = contractPrice + DEFAULT_ASSIGNMENT_MARKUP;
  } else if (!positive(input.assignmentPrice)) {
    return { ok: false, error: "assignmentPrice must be a positive number when given" };
  } else {
    assignmentPrice = Math.round(input.assignmentPrice);
  }
  if (assignmentPrice <= contractPrice) {
    return { ok: false, error: "assignmentPrice must exceed contractPrice" };
  }

  const fields: ContractExecutedFields = {
    Contract_Executed_At: isoDate(executedAt),
    Option_Deadline: isoDate(addDays(executedAt, optionDays)),
    EMD_Due_At: isoDate(addDays(executedAt, DEFAULT_EMD_DAYS)),
    Close_Date: isoDate(addDays(executedAt, closeDays)),
    Contract_Offer_Price: contractPrice,
    Assignment_Price: assignmentPrice,
  };
  const summary =
    `Contract executed ${fields.Contract_Executed_At} at $${contractPrice.toLocaleString("en-US")}; ` +
    `option ends ${fields.Option_Deadline}, EMD due ${fields.EMD_Due_At}, close ${fields.Close_Date}; ` +
    `assignment $${assignmentPrice.toLocaleString("en-US")}`;
  return { ok: true, fields, summary };
}
