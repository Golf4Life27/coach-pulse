import { describe, it, expect } from "vitest";
import { buildVerifyProbeDiagnostic } from "./verify-probe";

describe("buildVerifyProbeDiagnostic", () => {
  it("flags comps_header_found when a comps section is present", () => {
    const md = "# 123 Main St\nFor sale $200,000\n\n## Nearby similar homes\nSOLD AUG 31, 2026\n";
    const d = buildVerifyProbeDiagnostic(md);
    expect(d.comps_header_found).toBe(true);
    // stripped comps content must not leak into the status scope.
    expect(d.status_scope.first_lines.join("\n")).not.toContain("SOLD AUG 31, 2026");
  });

  it("leaves comps_header_found false when no comps section exists", () => {
    const md = "# 123 Main St\nFor sale $200,000\nActive on market\n";
    const d = buildVerifyProbeDiagnostic(md);
    expect(d.comps_header_found).toBe(false);
    expect(d.raw.chars).toBe(md.length);
  });

  it("truncates any line to 200 chars in both status_scope and raw", () => {
    const longLine = "x".repeat(500);
    const md = `# subject\n${longLine}\n`;
    const d = buildVerifyProbeDiagnostic(md);
    expect(d.status_scope.first_lines[1].length).toBe(200);
    expect(d.raw.head[1].length).toBe(200);
    // full (untruncated) char counts are still reported.
    expect(d.raw.chars).toBe(md.length);
  });

  it("surfaces the subject status chip decision without touching resolved/stillActive", () => {
    // "For sale" (before the first heading) is the subject's own chip — the
    // later comps "SOLD AUG 31, 2026" card must not override it.
    const md = "For sale\n\n$374,000\n## About this home\nSOLD AUG 31, 2026\n";
    const d = buildVerifyProbeDiagnostic(md);
    expect(d.subject_status_chip).toEqual({ chip: "for sale", verdict: "active" });
  });

  it("reports a sold chip verdict for a bare status-chip line", () => {
    const md = "SOLD AUG 31, 2026\n## About this home\n";
    const d = buildVerifyProbeDiagnostic(md);
    expect(d.subject_status_chip).toEqual({ chip: "sold aug 31, 2026", verdict: "inactive" });
  });

  it("caps first_lines / head at their line limits", () => {
    const md = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
    const d = buildVerifyProbeDiagnostic(md);
    expect(d.status_scope.first_lines.length).toBe(60);
    expect(d.raw.head.length).toBe(120);
  });
});
