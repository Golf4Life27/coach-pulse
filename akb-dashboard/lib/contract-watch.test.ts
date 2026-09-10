import { describe, it, expect } from "vitest";
import { findPendingSignatures, composeContractWatchSms, type ContractWatchMessage } from "./contract-watch";
import { estimateSmsSegments, findNonGsm7Chars } from "./sms/gsm7";

const NOW = new Date("2026-09-09T03:15:00Z");

// The real 513 Lamar traffic. Bryan Ryder's seller signed 9/8; Alex was
// routing order 2 and never signed. DocuSign sent the original plus a resend.
const LAMAR: ContractWatchMessage[] = [
  {
    id: "m1",
    from: "DocuSign NA4 System <dse@docusign.net>",
    subject: "Complete with Docusign: Contract for 513 Lamar",
    date: "2026-09-06T05:14:53Z",
  },
  {
    id: "m2",
    from: "dse@docusign.net",
    subject: "Complete with Docusign: Contract for 513 Lamar",
    date: "2026-09-09T03:15:02Z",
  },
];

describe("findPendingSignatures", () => {
  it("catches the 513 Lamar miss and ages it from the FIRST notice, not the resend", () => {
    const [env, ...rest] = findPendingSignatures(LAMAR, NOW);
    expect(rest).toEqual([]);
    expect(env.label).toBe("Contract for 513 Lamar");
    expect(env.firstSeenIso).toBe("2026-09-06T05:14:53.000Z");
    expect(env.noticeCount).toBe(2);
    // ~2d22h. The resend must NOT reset the clock to zero.
    expect(env.ageHours).toBe(70);
  });

  it("drops an envelope once DocuSign says it is completed", () => {
    const signed = [
      ...LAMAR,
      { id: "m3", from: "dse@docusign.net", subject: "Completed: Contract for 513 Lamar", date: "2026-09-09T04:00:00Z" },
    ];
    expect(findPendingSignatures(signed, NOW)).toEqual([]);
  });

  it("drops it even when the completion notice arrives out of order", () => {
    const outOfOrder = [
      { id: "m0", from: "dse@docusign.net", subject: "Completed: Contract for 513 Lamar", date: "2026-09-04T00:00:00Z" },
      ...LAMAR,
    ];
    expect(findPendingSignatures(outOfOrder, NOW)).toEqual([]);
  });

  it("ignores mail that is not actually from docusign", () => {
    const spoof: ContractWatchMessage[] = [
      { id: "s1", from: "noreply@docusign.net.evil.com", subject: "Complete with Docusign: Contract for Nowhere", date: "2026-09-06T00:00:00Z" },
      { id: "s2", from: "bryan-ryder@jbgoodwin.com", subject: "Complete with Docusign: Contract for 513 Lamar", date: "2026-09-06T00:00:00Z" },
    ];
    expect(findPendingSignatures(spoof, NOW)).toEqual([]);
  });

  it("ignores docusign mail that is not a signature request", () => {
    const noise: ContractWatchMessage[] = [
      { id: "n1", from: "dse@docusign.net", subject: "Your Docusign account statement", date: "2026-09-06T00:00:00Z" },
    ];
    expect(findPendingSignatures(noise, NOW)).toEqual([]);
  });

  it("sorts oldest-waiting first and survives unparseable dates", () => {
    const many: ContractWatchMessage[] = [
      { id: "a", from: "dse@docusign.net", subject: "Complete with Docusign: Newer Deal", date: "2026-09-08T00:00:00Z" },
      { id: "b", from: "dse@docusign.net", subject: "Complete with Docusign: Older Deal", date: "2026-09-01T00:00:00Z" },
      { id: "c", from: "dse@docusign.net", subject: "Complete with Docusign: Broken Date", date: "not-a-date" },
    ];
    expect(findPendingSignatures(many, NOW).map((e) => e.label)).toEqual(["Older Deal", "Newer Deal"]);
  });

  it("is empty on empty input", () => {
    expect(findPendingSignatures([], NOW)).toEqual([]);
  });
});

describe("composeContractWatchSms", () => {
  const env = findPendingSignatures(LAMAR, NOW)[0];

  it("names the envelope, the wait, and that the operator is the blocker", () => {
    const sms = composeContractWatchSms(env);
    expect(sms).toContain("513 Lamar");
    expect(sms).toContain("2d");
    expect(sms).toContain("2 notices");
    expect(sms).toContain("YOUR signature");
  });

  it("bills as GSM-7 — it goes out over the Quo alert line", () => {
    const sms = composeContractWatchSms(env);
    expect(findNonGsm7Chars(sms)).toEqual([]);
    expect(estimateSmsSegments(sms).encoding).toBe("gsm7");
  });

  it("reports hours before the first full day", () => {
    expect(composeContractWatchSms({ ...env, ageHours: 26, noticeCount: 1 })).toContain("1d");
    expect(composeContractWatchSms({ ...env, ageHours: 5, noticeCount: 1 })).toContain("5h");
  });

  it("truncates a pathological label instead of blowing the segment budget", () => {
    const sms = composeContractWatchSms({ ...env, label: "X".repeat(400) });
    expect(sms.length).toBeLessThanOrEqual(300);
    expect(estimateSmsSegments(sms).encoding).toBe("gsm7");
  });
});
