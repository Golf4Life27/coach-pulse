import { Listing } from "@/lib/types";
import { formatCurrency, buildQuickSMSLink, getLastNote } from "@/lib/utils";

interface NegotiationCardProps {
  listing: Listing;
}

export default function NegotiationCard({ listing }: NegotiationCardProps) {
  return (
    <div className="bg-[#1c2128] rounded-lg border border-[#30363d] p-4 hover:border-orange-500/50 transition-colors">
      <div className="flex justify-between items-start mb-3">
        <div>
          <h3 className="text-white font-semibold text-sm">{listing.address}</h3>
          <p className="text-gray-400 text-xs">
            {listing.city}, TX {listing.zip}
          </p>
        </div>
        {listing.offerTier && (
          <span className="px-2 py-0.5 rounded text-xs font-bold bg-orange-500/20 text-orange-400">
            Tier {listing.offerTier}
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2 mb-3 text-xs">
        <div>
          <span className="text-gray-500">List Price</span>
          <p className="text-white font-medium">{formatCurrency(listing.listPrice)}</p>
        </div>
        <div>
          <span className="text-gray-500">Offer (MAO)</span>
          <p className="text-emerald-400 font-medium">{formatCurrency(listing.mao)}</p>
        </div>
        <div>
          <span className="text-gray-500">DOM</span>
          <p className="text-white font-medium">{listing.dom ?? "—"}</p>
        </div>
        <div>
          <span className="text-gray-500">Distress</span>
          <p className="text-white font-medium">{listing.distressScore ?? "—"}</p>
        </div>
      </div>

      {/* Agent Info */}
      <div className="border-t border-[#30363d] pt-3 mb-3">
        <p className="text-xs text-gray-400 mb-1">
          <span className="text-gray-500">Agent:</span>{" "}
          <span className="text-white">{listing.agentName || "—"}</span>
        </p>
        <div className="flex gap-2 flex-wrap">
          {listing.agentPhone && (
            <a
              href={`tel:${listing.agentPhone}`}
              className="text-xs text-blue-400 hover:text-blue-300"
            >
              {listing.agentPhone}
            </a>
          )}
          {listing.agentEmail && (
            <a
              href={`mailto:${listing.agentEmail}`}
              className="text-xs text-blue-400 hover:text-blue-300"
            >
              {listing.agentEmail}
            </a>
          )}
        </div>
      </div>

      {/* Last Note */}
      {listing.notes && (
        <div className="mb-3">
          <p className="text-xs text-gray-500 mb-1">Last Note:</p>
          <p className="text-xs text-gray-300 bg-[#161b22] rounded p-2 line-clamp-3">
            {getLastNote(listing.notes)}
          </p>
        </div>
      )}

      {/* Action Buttons */}
      <div className="flex gap-2">
        {listing.agentPhone && (
          <a
            href={buildQuickSMSLink(listing.agentPhone)}
            className="flex-1 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold text-center py-2.5 rounded transition-colors min-h-[44px] flex items-center justify-center"
          >
            SMS Agent
          </a>
        )}
        {listing.verificationUrl && (
          <a
            href={listing.verificationUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex-1 bg-[#30363d] hover:bg-[#3d444d] text-gray-300 text-xs font-semibold text-center py-2.5 rounded transition-colors min-h-[44px] flex items-center justify-center"
          >
            Redfin
          </a>
        )}
      </div>
    </div>
  );
}
