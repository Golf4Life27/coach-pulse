// DD V3.0 volley templates — three SMS texts that surface the 12 DD items
// agents can reasonably answer over text. Locked copy per spec.

export function getVolleyText(textIndex: 1 | 2 | 3, agentName: string | null): string {
  const firstName = (agentName ?? "").split(/\s+/)[0] || "there";
  if (textIndex === 1) {
    return `Hey ${firstName}, before I bring back a counter — is the property currently vacant or tenant-occupied? And are utilities currently on?`;
  }
  if (textIndex === 2) {
    return `Rough ages on roof, HVAC, water heater, electrical, and plumbing? Any known foundation issues, active leaks, or sewer problems?`;
  }
  return `Last one — any known asbestos, lead, mold, open permits, or code violations the seller has disclosed?`;
}
