export function formatCurrency(value: number | null | undefined): string {
  if (value == null) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
}

export function extractFirstName(fullName: string | null | undefined): string {
  if (!fullName) return "";
  return fullName.split(" ")[0];
}

function cleanPhone(phone: string): string {
  return phone.replace(/[^+\d]/g, "");
}

function roundOfferUp(amount: number): number {
  return Math.ceil(amount / 250) * 250;
}

export function buildSMSLink(
  phone: string | null | undefined,
  agentName: string | null | undefined,
  address: string | null | undefined,
  city: string | null | undefined,
  mao: number | null | undefined
): string {
  if (!phone) return "#";
  const cleaned = cleanPhone(phone);
  if (!cleaned) return "#";
  const firstName = extractFirstName(agentName);
  const maoStr =
    mao != null ? formatCurrency(roundOfferUp(mao)) : "a competitive price";
  const body = `Hi ${firstName}, this is Alex with AKB Solutions. I'm interested in your listing at ${address || "the property"} in ${city || "your area"}. I'd like to make a cash offer at ${maoStr} with a quick close and no financing contingencies. Is the seller open to offers in that range?`;
  return `sms:${cleaned}?body=${encodeURIComponent(body)}`;
}

export function buildQuickSMSLink(phone: string | null | undefined): string {
  if (!phone) return "#";
  return `sms:${cleanPhone(phone)}`;
}

export function getLastNote(notes: string | null | undefined): string {
  if (!notes) return "";
  const paragraphs = notes.split("\n").filter((p) => p.trim());
  return paragraphs[paragraphs.length - 1] || "";
}

export function cn(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(" ");
}
