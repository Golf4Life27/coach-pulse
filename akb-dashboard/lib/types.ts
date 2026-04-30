export interface Listing {
  id: string;
  address: string;
  city: string;
  zip: string;
  listPrice: number | null;
  mao: number | null;
  dom: number | null;
  offerTier: string | null;
  liveStatus: string | null;
  executionPath: string | null;
  outreachStatus: string | null;
  lastOutreachDate: string | null;
  agentName: string | null;
  agentPhone: string | null;
  agentEmail: string | null;
  verificationUrl: string | null;
  notes: string | null;
  distressScore: number | null;
  distressBucket: string | null;
  bedrooms: number | null;
  bathrooms: number | null;
  buildingSqFt: number | null;
  stageCalc: string | null;
  approvedForOutreach: boolean;
  flipScore: number | null;
  offMarketOverride: boolean;
  restrictionText: string | null;
  ddChecklist: string[] | null;
  doNotText: boolean;
  state: string | null;
  actionHoldUntil: string | null;
  actionCardState: "Open" | "Held" | "Cleared" | null;
}

export interface Deal {
  id: string;
  propertyAddress: string;
  city: string;
  contractPrice: number | null;
  offerPrice: number | null;
  assignmentFee: number | null;
  estimatedRepairs: number | null;
  arv: number | null;
  status: string | null;
  closingStatus: string | null;
  dispoReady: boolean;
  propertyImageUrl: string | null;
  beds: number | null;
  baths: number | null;
  sqft: number | null;
}

export interface Buyer {
  id: string;
  buyerName: string;
  buyerEmail: string | null;
  buyerStatus: string | null;
  preferredCities: string | null;
  cashBuyer: boolean;
  proofOfFundsOnFile: boolean;
  buyerActiveFlag: boolean;
}

export interface DashboardStats {
  negotiating: number;
  responseReceived: number;
  textedEmailed: number;
  dead: number;
  totalRecords: number;
  verifiedActive: number;
  autoProceed: number;
  manualReview: number;
  rejected: number;
}

export interface ProspectiveBuyer {
  id: string;
  fullName: string;
  company: string | null;
  email: string | null;
  phone: string | null;
  propertyPurchased: string | null;
  city: string | null;
  zip: string | null;
  source: string | null;
  outreachStatus: string | null;
  lastContacted: string | null;
  notes: string | null;
}
