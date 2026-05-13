import { Deal } from "@/lib/types";
import { formatCurrency } from "@/lib/utils";
import TwoTrackPricing, { extractZipFromAddress } from "./TwoTrackPricing";

interface DealCardProps {
  deal: Deal;
}

const statusColors: Record<string, string> = {
  "Under Contract": "bg-yellow-500/20 text-yellow-400",
  "Closing": "bg-emerald-500/20 text-emerald-400",
  "Closed": "bg-green-500/20 text-green-400",
  "Dead": "bg-red-500/20 text-red-400",
  "Pending": "bg-blue-500/20 text-blue-400",
};

export default function DealCard({ deal }: DealCardProps) {
  return (
    <div className="bg-[#1c2128] rounded-lg border border-[#30363d] overflow-hidden hover:border-emerald-500/50 transition-colors">
      {deal.propertyImageUrl && (
        <div className="h-40 bg-[#161b22] overflow-hidden">
          <img
            src={deal.propertyImageUrl}
            alt={deal.propertyAddress}
            className="w-full h-full object-cover"
          />
        </div>
      )}
      <div className="p-4">
        <div className="flex justify-between items-start mb-3">
          <div>
            <h3 className="text-white font-semibold text-sm">{deal.propertyAddress}</h3>
            <p className="text-gray-400 text-xs">{deal.city}</p>
          </div>
          {deal.closingStatus && (
            <span
              className={`px-2 py-0.5 rounded text-xs font-bold ${
                statusColors[deal.closingStatus] || "bg-gray-500/20 text-gray-400"
              }`}
            >
              {deal.closingStatus}
            </span>
          )}
        </div>

        <div className="grid grid-cols-2 gap-2 mb-3 text-xs">
          <div>
            <span className="text-gray-500">Contract</span>
            <p className="text-white font-medium">{formatCurrency(deal.contractPrice)}</p>
          </div>
          <div>
            <span className="text-gray-500">Dispo Ask</span>
            <p className="text-emerald-400 font-medium">{formatCurrency(deal.offerPrice)}</p>
          </div>
          <div>
            <span className="text-gray-500">Assignment Fee</span>
            <p className="text-yellow-400 font-medium">{formatCurrency(deal.assignmentFee)}</p>
          </div>
          <div>
            <span className="text-gray-500">ARV</span>
            <p className="text-white font-medium">{formatCurrency(deal.arv)}</p>
          </div>
          <div>
            <span className="text-gray-500">Est. Repairs</span>
            <p className="text-red-400 font-medium">{formatCurrency(deal.estimatedRepairs)}</p>
          </div>
          <div>
            <span className="text-gray-500">Details</span>
            <p className="text-white font-medium">
              {deal.beds ?? "—"}bd / {deal.baths ?? "—"}ba / {deal.sqft ?? "—"}sf
            </p>
          </div>
        </div>

        {deal.dispoReady && (
          <div className="bg-emerald-500/10 border border-emerald-500/30 rounded px-3 py-1.5 text-xs text-emerald-400 font-semibold text-center">
            DISPO READY
          </div>
        )}

        {/* Two-Track buyer math — fetches /api/pricing-intelligence/[zip]
            client-side. Renders only when ZIP can be parsed and we have
            ARV + rehab inputs. The fetch surfaces its own loading/error
            state per the Positive Confirmation Principle. */}
        {(() => {
          const zip = extractZipFromAddress(deal.propertyAddress);
          if (
            !zip ||
            deal.arv == null ||
            deal.arv <= 0 ||
            deal.estimatedRepairs == null ||
            deal.estimatedRepairs < 0
          ) {
            return null;
          }
          return (
            <TwoTrackPricing
              zip={zip}
              address={deal.propertyAddress}
              city={deal.city}
              state={deal.state}
              beds={deal.beds}
              baths={deal.baths}
              sqft={deal.sqft}
              arv_mid={deal.arv}
              rehab_mid={deal.estimatedRepairs}
            />
          );
        })()}
      </div>
    </div>
  );
}
