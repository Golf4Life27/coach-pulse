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
    expect(env.platform).toBe("docusign");
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

  it("drops an envelope the sender VOIDED — the real 9/11 Lamar sequence", () => {
    // Bryan voided "Contract for 513 Lamar" at 04:08Z and sent "Revised Sales
    // Contract for 513 Lamar" at 04:18Z. Only the revised one is still owed.
    const now = new Date("2026-09-12T13:20:00Z");
    const msgs: ContractWatchMessage[] = [
      ...LAMAR,
      { id: "m3", from: "dse@docusign.net", subject: "Complete with Docusign: Contract for 513 Lamar", date: "2026-09-10T03:13:58Z" },
      { id: "m4", from: "dse@docusign.net", subject: "Voided: Complete with Docusign: Contract for 513 Lamar", date: "2026-09-11T04:08:14Z" },
      { id: "m5", from: "dse@docusign.net", subject: "Complete with Docusign: Revised Sales Contract for 513 Lamar", date: "2026-09-11T04:18:04Z" },
    ];
    const pending = findPendingSignatures(msgs, now);
    expect(pending.map((e) => e.label)).toEqual(["Revised Sales Contract for 513 Lamar"]);
    expect(pending[0].ageHours).toBe(33);
  });

  it("drops a voided envelope even when the void notice arrives before the request", () => {
    const msgs: ContractWatchMessage[] = [
      { id: "v1", from: "dse@docusign.net", subject: "Voided: Contract for 513 Lamar", date: "2026-09-11T04:08:14Z" },
      ...LAMAR,
    ];
    expect(findPendingSignatures(msgs, NOW)).toEqual([]);
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

// AUTHENTISIGN (2026-09-12). The Birmingham contract — 1005 2nd St, listing
// agent Pamela Calamusa — was invisible for three days because this module
// only knew DocuSign. Real Gmail traffic: one subject, three identical
// notices. The FIRST one is the true age.
const BIRMINGHAM: ContractWatchMessage[] = [
  {
    id: "b1",
    from: "Authentisign <secure@authentisign.com>",
    subject: "Your signature is requested: General/Financed Residential Contract - 12/24",
    date: "2026-09-09T09:37:00Z",
  },
  {
    id: "b2",
    from: "secure@authentisign.com",
    subject: "Your signature is requested: General/Financed Residential Contract - 12/24",
    date: "2026-09-10T13:39:00Z",
  },
  {
    id: "b3",
    from: "secure@authentisign.com",
    subject: "Your signature is requested: General/Financed Residential Contract - 12/24",
    date: "2026-09-10T15:35:00Z",
  },
];

const NOW_BHAM = new Date("2026-09-12T13:20:00Z");

describe("findPendingSignatures — Authentisign", () => {
  it("catches the Birmingham contract and ages it from the FIRST of three identical notices", () => {
    const [env, ...rest] = findPendingSignatures(BIRMINGHAM, NOW_BHAM);
    expect(rest).toEqual([]);
    expect(env.platform).toBe("authentisign");
    expect(env.label).toBe("General/Financed Residential Contract - 12/24");
    expect(env.firstSeenIso).toBe("2026-09-09T09:37:00.000Z");
    expect(env.noticeCount).toBe(3);
    // 09-09 09:37Z → 09-12 13:20Z is 3d3h43m. Resends must not reset the clock.
    expect(env.ageHours).toBe(75);
  });

  it('drops it once "Signing complete:" lands, in order or out of order', () => {
    const done = {
      id: "b4",
      from: "secure@authentisign.com",
      subject: "Signing complete: General/Financed Residential Contract - 12/24",
      date: "2026-09-11T18:00:00Z",
    };
    expect(findPendingSignatures([...BIRMINGHAM, done], NOW_BHAM)).toEqual([]);
    expect(findPendingSignatures([done, ...BIRMINGHAM], NOW_BHAM)).toEqual([]);
    // and even when the completion notice predates every request notice
    expect(
      findPendingSignatures([{ ...done, id: "b5", date: "2026-09-01T00:00:00Z" }, ...BIRMINGHAM], NOW_BHAM),
    ).toEqual([]);
  });

  it("ignores a lookalike sender domain", () => {
    const spoof: ContractWatchMessage[] = [
      {
        id: "s3",
        from: "secure@authentisign.com.evil.com",
        subject: "Your signature is requested: Contract for Nowhere",
        date: "2026-09-09T00:00:00Z",
      },
    ];
    expect(findPendingSignatures(spoof, NOW_BHAM)).toEqual([]);
  });

  it("still handles DocuSign unchanged alongside the new patterns", () => {
    const [env] = findPendingSignatures(LAMAR, NOW);
    expect(env.platform).toBe("docusign");
    expect(env.label).toBe("Contract for 513 Lamar");
    expect(env.ageHours).toBe(70);
    expect(env.noticeCount).toBe(2);
  });

  it("sorts a mixed DocuSign + Authentisign backlog oldest-waiting first", () => {
    const mixed: ContractWatchMessage[] = [
      {
        id: "x1",
        from: "secure@authentisign.com",
        subject: "Your signature is requested: Newer Authentisign Deal",
        date: "2026-09-11T00:00:00Z",
      },
      ...BIRMINGHAM,
      { id: "x2", from: "dse@docusign.net", subject: "Complete with Docusign: Middle Docusign Deal", date: "2026-09-10T00:00:00Z" },
      { id: "x3", from: "dse@docusign.net", subject: "Complete with Docusign: Oldest Docusign Deal", date: "2026-09-02T00:00:00Z" },
    ];
    expect(findPendingSignatures(mixed, NOW_BHAM).map((e) => [e.label, e.platform])).toEqual([
      ["Oldest Docusign Deal", "docusign"],
      ["General/Financed Residential Contract - 12/24", "authentisign"],
      ["Middle Docusign Deal", "docusign"],
      ["Newer Authentisign Deal", "authentisign"],
    ]);
  });
});

describe("composeContractWatchSms — platform", () => {
  it("names Authentisign so the operator knows which app to open", () => {
    const env = findPendingSignatures(BIRMINGHAM, NOW_BHAM)[0];
    const sms = composeContractWatchSms(env);
    expect(sms).toContain("SIGN (Authentisign):");
    expect(sms).toContain("General/Financed Residential Contract - 12/24");
    expect(sms).toContain("3d");
    expect(sms).toContain("3 notices");
    expect(findNonGsm7Chars(sms)).toEqual([]);
  });

  it("names DocuSign for a DocuSign envelope", () => {
    const sms = composeContractWatchSms(findPendingSignatures(LAMAR, NOW)[0]);
    expect(sms).toContain("SIGN (DocuSign):");
  });

  it("keeps a long Authentisign label inside 300 ASCII chars", () => {
    const env = findPendingSignatures(BIRMINGHAM, NOW_BHAM)[0];
    const sms = composeContractWatchSms({
      ...env,
      label: `General/Financed Residential Contract - 12/24 - 1005 2nd St N Birmingham AL 35203 ${"Addendum ".repeat(40)}`,
    });
    expect(sms.length).toBeLessThanOrEqual(300);
    expect(findNonGsm7Chars(sms)).toEqual([]);
    expect(estimateSmsSegments(sms).encoding).toBe("gsm7");
  });
});
